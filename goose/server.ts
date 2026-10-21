import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { spawn } from 'node:child_process';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { isDraftWrite } from '../lib/agent/draft.js';
import { formatDraftMarkdown, type DraftWrite } from '../lib/work-order.js';

export const GOOSE_RECIPE_PATH = '/opt/goose/recipe.yaml';
export const GOOSE_TASK_PATH = '/tmp/goose-task.md';
export const GOOSE_WORKSPACE = '/tmp/workspace';
export const STDOUT_LIMIT = 8000;

const OWNER_REPO = /^[A-Za-z0-9_.-]+$/;

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[], cwd?: string) => Promise<CommandResult>;

export type GoosePaths = {
  recipePath: string;
  taskPath: string;
  workspace: string;
};

export type DraftLoader = (key: { project: string; draftId: string }) => Promise<unknown>;

export type ParsedInvocation =
  | { ok: true; repoUrl: string; task: string }
  | { ok: true; repoUrl: string; project: string; draftId: string }
  | { ok: false; error: string };

export function gooseArguments(recipePath = GOOSE_RECIPE_PATH): string[] {
  return [
    'goose',
    'run',
    '--recipe',
    recipePath,
    '--max-turns',
    '30',
    '--quiet',
    '--with-builtin',
    'developer',
    '--no-profile',
    '--no-session',
  ];
}

export function parseInvocation(body: unknown): ParsedInvocation {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object with repoUrl and a work order' };
  }
  const record = body as Record<string, unknown>;
  const keys = new Set(Object.keys(record));
  if (typeof record.repoUrl !== 'string') {
    return { ok: false, error: 'repoUrl must be a string' };
  }
  const repoUrl = validateRepoUrl(record.repoUrl);
  if (repoUrl.ok === false) {
    return repoUrl;
  }
  if (keys.size === 2 && keys.has('repoUrl') && keys.has('task')) {
    if (typeof record.task !== 'string' || record.task.length === 0) {
      return { ok: false, error: 'task must be a non-empty string' };
    }
    return { ok: true, repoUrl: repoUrl.repoUrl, task: record.task };
  }
  if (keys.size === 3 && keys.has('repoUrl') && keys.has('project') && keys.has('draftId')) {
    if (typeof record.project !== 'string' || record.project.trim().length === 0) {
      return { ok: false, error: 'project must be a non-empty string' };
    }
    if (typeof record.draftId !== 'string' || record.draftId.trim().length === 0) {
      return { ok: false, error: 'draftId must be a non-empty string' };
    }
    return { ok: true, repoUrl: repoUrl.repoUrl, project: record.project.trim(), draftId: record.draftId.trim() };
  }
  return { ok: false, error: 'body must contain repoUrl with task, or repoUrl with project and draftId' };
}

export function workOrderHasRepo(item: DraftWrite, repoUrl: string): boolean {
  const wanted = githubOwnerRepo(repoUrl);
  if (wanted === undefined) {
    return false;
  }
  return item.workOrder.repos.some(
    (repo) =>
      repo.owner.toLowerCase() === wanted.owner.toLowerCase() &&
      repo.repo.toLowerCase() === wanted.repo.toLowerCase(),
  );
}

function validateRepoUrl(repoUrl: string): { ok: true; repoUrl: string } | { ok: false; error: string } {
  if (/^(?:file:|ssh:)|git@/i.test(repoUrl)) {
    return { ok: false, error: 'repoUrl must be an https github.com repository' };
  }
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return { ok: false, error: 'repoUrl must be an https github.com repository' };
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    return { ok: false, error: 'repoUrl must be an https github.com repository' };
  }
  if (url.username !== '' || url.password !== '' || url.port !== '' || url.search !== '' || url.hash !== '') {
    return { ok: false, error: 'repoUrl must not include userinfo, a port, a query, or a fragment' };
  }
  if (url.pathname.includes('%')) {
    return { ok: false, error: 'repoUrl must be an https github.com repository' };
  }
  const parts = url.pathname.split('/');
  if (parts.length !== 3 || parts[0] !== '') {
    return { ok: false, error: 'repoUrl path must be /owner/repo or /owner/repo.git' };
  }
  const owner = parts[1];
  let repo = parts[2];
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  if (owner.length === 0 || repo.length === 0 || !OWNER_REPO.test(owner) || !OWNER_REPO.test(repo)) {
    return { ok: false, error: 'repoUrl path must be /owner/repo or /owner/repo.git' };
  }
  return { ok: true, repoUrl };
}

function githubOwnerRepo(repoUrl: string): { owner: string; repo: string } | undefined {
  const parsed = validateRepoUrl(repoUrl);
  if (parsed.ok === false) {
    return undefined;
  }
  const url = new URL(parsed.repoUrl);
  const owner = url.pathname.split('/')[1];
  let repo = url.pathname.split('/')[2];
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4);
  }
  return { owner, repo };
}

export function createGooseServer(
  run: CommandRunner = spawnCommand,
  paths: GoosePaths = {
    recipePath: GOOSE_RECIPE_PATH,
    taskPath: GOOSE_TASK_PATH,
    workspace: GOOSE_WORKSPACE,
  },
  loadDraft: DraftLoader = getDraftFromTable,
): Server {
  let busy = false;
  let statusChangedAt = unixSeconds();

  function setBusy(next: boolean): void {
    if (next === busy) {
      return;
    }
    busy = next;
    statusChangedAt = unixSeconds();
  }

  function health(): { status: string; time_of_last_update: number } {
    return {
      status: busy ? 'HealthyBusy' : 'Healthy',
      time_of_last_update: statusChangedAt,
    };
  }

  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && (req.url === '/ping' || req.url === '/health')) {
          json(res, 200, health());
          return;
        }
        if (req.method === 'POST' && req.url === '/invocations') {
          await handleInvocation(req, res, run, paths, loadDraft, () => busy, setBusy);
          return;
        }
        json(res, 404, { status: 'error', error: 'not found' });
      } catch (error) {
        console.log(JSON.stringify({ status: 'error' }));
        const message = error instanceof Error ? error.message : 'the work order failed';
        json(res, 200, { status: 'error', diff: '', stdout: '', error: message });
      }
    })();
  });
}

async function handleInvocation(
  req: IncomingMessage,
  res: ServerResponse,
  run: CommandRunner,
  paths: GoosePaths,
  loadDraft: DraftLoader,
  isBusy: () => boolean,
  setBusy: (next: boolean) => void,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ status: 'error' }));
    json(res, 400, { status: 'error', error: 'body must be JSON' });
    return;
  }
  const parsed = parseInvocation(body);
  if (parsed.ok === false) {
    console.log(JSON.stringify({ status: 'error' }));
    json(res, 400, { status: 'error', error: parsed.error });
    return;
  }
  const loaded = await resolveTask(parsed, loadDraft);
  if (loaded.ok === false) {
    console.log(JSON.stringify({ repoUrl: parsed.repoUrl, status: 'error' }));
    json(res, loaded.status, { status: 'error', error: loaded.error });
    return;
  }
  if (isBusy()) {
    console.log(JSON.stringify({ repoUrl: parsed.repoUrl, status: 'error' }));
    json(res, 200, { status: 'error', diff: '', stdout: '', error: 'a work order is already running' });
    return;
  }
  setBusy(true);
  try {
    const result = await applyWorkOrder(parsed.repoUrl, loaded.task, run, paths);
    console.log(JSON.stringify({ repoUrl: parsed.repoUrl, status: result.status }));
    json(res, 200, result);
  } finally {
    setBusy(false);
    await rm(paths.taskPath, { force: true }).catch(() => undefined);
  }
}

async function resolveTask(
  parsed: Exclude<ParsedInvocation, { ok: false }>,
  loadDraft: DraftLoader,
): Promise<{ ok: true; task: string } | { ok: false; status: number; error: string }> {
  if ('task' in parsed) {
    return { ok: true, task: parsed.task };
  }
  let stored: unknown;
  try {
    stored = await loadDraft({ project: parsed.project, draftId: parsed.draftId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'the draft failed to load';
    return { ok: false, status: 200, error: message };
  }
  if (stored === undefined) {
    return { ok: false, status: 200, error: 'No draft with that id.' };
  }
  if (!isDraftWrite(stored)) {
    return { ok: false, status: 200, error: 'The stored draft could not be read.' };
  }
  if (!workOrderHasRepo(stored, parsed.repoUrl)) {
    return { ok: false, status: 400, error: 'repoUrl must be a repository on this work order' };
  }
  return { ok: true, task: formatDraftMarkdown(stored) };
}

async function getDraftFromTable(key: { project: string; draftId: string }): Promise<unknown> {
  const table = process.env.DRAFTS_TABLE_NAME;
  if (!table) {
    throw new Error('DRAFTS_TABLE_NAME is not set');
  }
  const result = await DynamoDBDocumentClient.from(new DynamoDBClient({})).send(
    new GetCommand({
      TableName: table,
      Key: key,
    }),
  );
  return result.Item;
}

async function applyWorkOrder(
  repoUrl: string,
  task: string,
  run: CommandRunner,
  paths: GoosePaths,
): Promise<{ status: string; diff: string; stdout: string; error?: string }> {
  await rm(paths.workspace, { recursive: true, force: true });
  const clone = await run('git', ['clone', '--depth', '1', repoUrl, paths.workspace]);
  if (clone.code !== 0) {
    return { status: 'error', diff: '', stdout: truncate(clone.stdout), error: commandFailure('git clone', clone) };
  }
  await writeFile(paths.taskPath, task, { mode: 0o600 });
  await chmod(paths.taskPath, 0o600);
  const gooseArgs = gooseArguments(paths.recipePath);
  let goose: CommandResult;
  try {
    goose = await run(gooseArgs[0], gooseArgs.slice(1), paths.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'goose failed';
    goose = { code: 1, stdout: '', stderr: message };
  }
  await run('git', ['add', '-A'], paths.workspace);
  const diff = await run('git', ['diff', '--cached'], paths.workspace);
  const stdout = truncate(goose.stdout);
  if (goose.code !== 0) {
    return { status: 'error', diff: diff.stdout, stdout, error: commandFailure('goose', goose) };
  }
  if (diff.code !== 0) {
    return { status: 'error', diff: diff.stdout, stdout, error: commandFailure('git diff', diff) };
  }
  return { status: 'success', diff: diff.stdout, stdout };
}

function commandFailure(command: string, result: CommandResult): string {
  const detail = truncate(result.stderr.trim() || result.stdout.trim());
  return detail.length > 0 ? `${command} exited ${result.code}: ${detail}` : `${command} exited ${result.code}`;
}

function truncate(value: string): string {
  return value.length > STDOUT_LIMIT ? value.slice(0, STDOUT_LIMIT) : value;
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function spawnCommand(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

const entry = basename(process.argv[1] ?? '');
if (entry === 'server.ts' || entry === 'server.js') {
  createGooseServer().listen(8080, '0.0.0.0');
}
