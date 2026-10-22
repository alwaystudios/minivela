import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { spawn } from 'node:child_process';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import { isDraftWrite } from '../lib/agent/draft.js';
import { getProjectSecret, projectSecretName } from '../lib/project-secret.js';
import { formatDraftMarkdown, type DraftWrite } from '../lib/work-order.js';

export const GOOSE_RECIPE_PATH = '/opt/goose/recipe.yaml';
export const GOOSE_TASK_PATH = '/tmp/goose-task.md';
export const GOOSE_TARGET_PATH = '/tmp/goose-target';
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
  targetPath: string;
  workspace: string;
};

export type DraftLoader = (key: { project: string; draftId: string }) => Promise<unknown>;

export type SecretReader = (project: string, name: string) => Promise<string>;

const GIT_PAT = 'git-pat';

export type ParsedInvocation =
  | { ok: true; project: string; draftId: string; repo?: string }
  | { ok: false; error: string };

export type TargetRepo = { owner: string; repo: string };

export type GooseInvokeResult = {
  status: 'success' | 'error';
  response: { diff?: string; stdout?: string; error?: string };
};

function failed(error: string, extra?: { diff?: string; stdout?: string }): GooseInvokeResult {
  return { status: 'error', response: { ...extra, error } };
}

function succeeded(diff: string, stdout: string): GooseInvokeResult {
  return { status: 'success', response: { diff, stdout } };
}

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
    return { ok: false, error: 'body must be a JSON object with project and draftId' };
  }
  const record = body as Record<string, unknown>;
  const keys = new Set(Object.keys(record));
  if (!keys.has('project') || !keys.has('draftId') || keys.has('task') || keys.has('repoUrl')) {
    return { ok: false, error: 'body must contain project and draftId' };
  }
  if (![...keys].every((key) => key === 'project' || key === 'draftId' || key === 'repo')) {
    return { ok: false, error: 'body must contain project and draftId' };
  }
  if (typeof record.project !== 'string' || record.project.trim().length === 0) {
    return { ok: false, error: 'project must be a non-empty string' };
  }
  if (typeof record.draftId !== 'string' || record.draftId.trim().length === 0) {
    return { ok: false, error: 'draftId must be a non-empty string' };
  }
  if (!keys.has('repo')) {
    return { ok: true, project: record.project.trim(), draftId: record.draftId.trim() };
  }
  if (typeof record.repo !== 'string') {
    return { ok: false, error: 'repo must be owner/repo' };
  }
  const repo = parseRepoRef(record.repo);
  if (repo.ok === false) {
    return repo;
  }
  return {
    ok: true,
    project: record.project.trim(),
    draftId: record.draftId.trim(),
    repo: `${repo.owner}/${repo.repo}`,
  };
}

export function parseRepoRef(value: string): { ok: true } & TargetRepo | { ok: false; error: string } {
  const parts = value.split('/');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    return { ok: false, error: 'repo must be owner/repo' };
  }
  if (!OWNER_REPO.test(parts[0]) || !OWNER_REPO.test(parts[1])) {
    return { ok: false, error: 'repo must be owner/repo' };
  }
  return { ok: true, owner: parts[0], repo: parts[1] };
}

export function selectTargetRepo(
  item: DraftWrite,
  requested?: string,
): { ok: true } & TargetRepo | { ok: false; error: string } {
  const repos = item.workOrder.repos;
  if (repos.length === 0) {
    return { ok: false, error: 'this work order names no repository' };
  }
  if (requested === undefined) {
    if (repos.length > 1) {
      return { ok: false, error: 'this work order names more than one repository; pass repo as owner/repo' };
    }
    return { ok: true, owner: repos[0].owner, repo: repos[0].repo };
  }
  const wanted = parseRepoRef(requested);
  if (wanted.ok === false) {
    return wanted;
  }
  const match = repos.find(
    (repo) =>
      repo.owner.toLowerCase() === wanted.owner.toLowerCase() &&
      repo.repo.toLowerCase() === wanted.repo.toLowerCase(),
  );
  if (match === undefined) {
    return { ok: false, error: 'repo must be a repository on this work order' };
  }
  return { ok: true, owner: match.owner, repo: match.repo };
}

export function githubCloneUrl(target: TargetRepo): string {
  return `https://github.com/${target.owner}/${target.repo}`;
}

export function createGooseServer(
  run: CommandRunner = spawnCommand,
  paths: GoosePaths = {
    recipePath: GOOSE_RECIPE_PATH,
    taskPath: GOOSE_TASK_PATH,
    targetPath: GOOSE_TARGET_PATH,
    workspace: GOOSE_WORKSPACE,
  },
  loadDraft: DraftLoader = getDraftFromTable,
  readSecret: SecretReader = getProjectSecret,
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
          await handleInvocation(req, res, run, paths, loadDraft, readSecret, () => busy, setBusy);
          return;
        }
        json(res, 404, failed('not found'));
      } catch (error) {
        console.log(JSON.stringify({ status: 'error' }));
        const message = error instanceof Error ? error.message : 'the work order failed';
        json(res, 200, failed(message, { diff: '', stdout: '' }));
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
  readSecret: SecretReader,
  isBusy: () => boolean,
  setBusy: (next: boolean) => void,
): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    console.log(JSON.stringify({ status: 'error' }));
    json(res, 400, failed('body must be JSON'));
    return;
  }
  const parsed = parseInvocation(body);
  if (parsed.ok === false) {
    console.log(JSON.stringify({ status: 'error' }));
    json(res, 400, failed(parsed.error));
    return;
  }
  const loaded = await resolveTask(parsed, loadDraft);
  if (loaded.ok === false) {
    console.log(JSON.stringify({ project: parsed.project, draftId: parsed.draftId, status: 'error' }));
    json(res, loaded.status, failed(loaded.error));
    return;
  }
  if (isBusy()) {
    console.log(JSON.stringify({ project: parsed.project, draftId: parsed.draftId, status: 'error' }));
    json(res, 200, failed('a work order is already running', { diff: '', stdout: '' }));
    return;
  }
  setBusy(true);
  try {
    try {
      await readGitPat(parsed.project, readSecret);
      console.log(
        JSON.stringify({
          project: parsed.project,
          draftId: parsed.draftId,
          secretId: projectSecretName(parsed.project, GIT_PAT),
          status: 'loaded',
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `project secret ${projectSecretName(parsed.project, GIT_PAT)} is missing or unreadable`;
      console.log(JSON.stringify({ project: parsed.project, draftId: parsed.draftId, status: 'error' }));
      json(res, 200, failed(message, { diff: '', stdout: '' }));
      return;
    }
    const result = await applyWorkOrder(loaded.repoUrl, loaded.task, loaded.target, run, paths);
    console.log(
      JSON.stringify({
        project: parsed.project,
        draftId: parsed.draftId,
        repo: `${loaded.target.owner}/${loaded.target.repo}`,
        status: result.status,
      }),
    );
    json(res, 200, result);
  } finally {
    setBusy(false);
    await rm(paths.taskPath, { force: true }).catch(() => undefined);
    await rm(paths.targetPath, { force: true }).catch(() => undefined);
  }
}

async function resolveTask(
  parsed: Exclude<ParsedInvocation, { ok: false }>,
  loadDraft: DraftLoader,
): Promise<
  | { ok: true; task: string; repoUrl: string; target: TargetRepo }
  | { ok: false; status: number; error: string }
> {
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
  const target = selectTargetRepo(stored, parsed.repo);
  if (target.ok === false) {
    return { ok: false, status: 200, error: target.error };
  }
  return {
    ok: true,
    task: formatDraftMarkdown(stored),
    repoUrl: githubCloneUrl(target),
    target,
  };
}

async function readGitPat(project: string, readSecret: SecretReader): Promise<void> {
  const secret = await readSecret(project, GIT_PAT);
  if (secret.length === 0) {
    throw new Error(`project secret ${projectSecretName(project, GIT_PAT)} is missing or unreadable`);
  }
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
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

async function applyWorkOrder(
  repoUrl: string,
  task: string,
  target: TargetRepo,
  run: CommandRunner,
  paths: GoosePaths,
): Promise<GooseInvokeResult> {
  await rm(paths.workspace, { recursive: true, force: true });
  const clone = await run('git', ['clone', '--depth', '1', repoUrl, paths.workspace]);
  if (clone.code !== 0) {
    return failed(commandFailure('git clone', clone), { diff: '', stdout: truncate(clone.stdout) });
  }
  const rev = await run('git', ['rev-parse', 'HEAD'], paths.workspace);
  const base = rev.stdout.trim();
  if (rev.code !== 0 || base.length === 0) {
    return failed(commandFailure('git rev-parse', rev), { diff: '', stdout: truncate(rev.stdout) });
  }
  await writeFile(paths.taskPath, task, { mode: 0o600 });
  await chmod(paths.taskPath, 0o600);
  await writeFile(paths.targetPath, `${target.owner}/${target.repo}\n`, { mode: 0o600 });
  await chmod(paths.targetPath, 0o600);
  const gooseArgs = gooseArguments(paths.recipePath);
  let goose: CommandResult;
  try {
    goose = await run(gooseArgs[0], gooseArgs.slice(1), paths.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'goose failed';
    goose = { code: 1, stdout: '', stderr: message };
  }
  const add = await run('git', ['add', '-A'], paths.workspace);
  const diff =
    add.code === 0
      ? await run('git', ['diff', '--cached', base], paths.workspace)
      : { code: add.code, stdout: '', stderr: add.stderr };
  const stdout = truncate(goose.stdout);
  if (goose.code !== 0) {
    return failed(commandFailure('goose', goose), { diff: diff.stdout, stdout });
  }
  if (add.code !== 0) {
    return failed(commandFailure('git add', add), { diff: '', stdout });
  }
  if (diff.code !== 0) {
    return failed(commandFailure('git diff', diff), { diff: diff.stdout, stdout });
  }
  if (diff.stdout.trim().length === 0) {
    return failed('Goose made no changes', { diff: '', stdout });
  }
  return succeeded(diff.stdout, stdout);
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
