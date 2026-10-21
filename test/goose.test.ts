import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { type Server, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app.js';
import { GOOSE_MODEL_ID } from '../lib/models.js';
import { DEFAULT_STACK_NAME } from '../lib/stack-name.js';
import type { DraftWrite } from '../lib/work-order.js';
import {
  createGooseServer,
  gooseArguments,
  GOOSE_RECIPE_PATH,
  parseInvocation,
  STDOUT_LIMIT,
  workOrderHasRepo,
  type CommandRunner,
} from '../goose/server.js';

jest.setTimeout(180_000);

const HELLO = 'https://github.com/octocat/Hello-World';
const HELLO_GIT = 'https://github.com/octocat/Hello-World.git';

test.each([HELLO, HELLO_GIT])('accepts %s', (repoUrl) => {
  const parsed = parseInvocation({ repoUrl, task: 'Add a line to README.md' });
  expect(parsed).toEqual({ ok: true, repoUrl, task: 'Add a line to README.md' });
});

test('accepts a work order longer than 4000 characters', () => {
  const task = 'x'.repeat(7811);
  const parsed = parseInvocation({ repoUrl: HELLO, task });
  expect(parsed).toEqual({ ok: true, repoUrl: HELLO, task });
});

test.each([
  ['https://user:token@github.com/octocat/Hello-World', 'userinfo'],
  ['https://github.com/octocat/Hello-World?token=ghp_abc', 'query token'],
  ['ssh://git@github.com/octocat/Hello-World', 'ssh'],
  ['file:///tmp/repo', 'file'],
  ['https://gitlab.com/octocat/Hello-World', 'host'],
  ['git@github.com:octocat/Hello-World', 'git@'],
])('rejects %s', (repoUrl) => {
  const parsed = parseInvocation({ repoUrl, task: 'Add a line to README.md' });
  expect(parsed.ok).toBe(false);
});

test('rejects an empty task', () => {
  const parsed = parseInvocation({ repoUrl: HELLO, task: '' });
  expect(parsed.ok).toBe(false);
});

test('accepts a stored draft', () => {
  const parsed = parseInvocation({ repoUrl: HELLO, project: 'acme', draftId: 'draft-1' });
  expect(parsed).toEqual({ ok: true, repoUrl: HELLO, project: 'acme', draftId: 'draft-1' });
});

test('rejects a draft payload that also has task', () => {
  const parsed = parseInvocation({
    repoUrl: HELLO,
    project: 'acme',
    draftId: 'draft-1',
    task: 'Add a line to README.md',
  });
  expect(parsed.ok).toBe(false);
});

test('rejects a draft without repoUrl', () => {
  const parsed = parseInvocation({ project: 'acme', draftId: 'draft-1' });
  expect(parsed.ok).toBe(false);
});

test('a repoUrl must be on the work order', () => {
  expect(workOrderHasRepo(sampleDraft(), HELLO)).toBe(true);
  expect(workOrderHasRepo(sampleDraft(), HELLO_GIT)).toBe(true);
  expect(workOrderHasRepo(sampleDraft(), 'https://github.com/octocat/Spoon-Knife')).toBe(false);
});

test('goose runs from an argument array with the developer builtin and no gateway', () => {
  const args = gooseArguments();
  expect(Array.isArray(args)).toBe(true);
  expect(args[0]).toBe('goose');
  expect(args).toEqual([
    'goose',
    'run',
    '--recipe',
    GOOSE_RECIPE_PATH,
    '--max-turns',
    '30',
    '--quiet',
    '--with-builtin',
    'developer',
    '--no-profile',
    '--no-session',
  ]);
  expect(args.join(' ')).not.toMatch(/gateway/i);
  expect(args).not.toContain('--resume');
});

test('an invocation spawns git and goose with argument arrays and returns the diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const taskPath = join(root, 'task.md');
  const workspace = join(root, 'workspace');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const task = 'y'.repeat(7811);
  const run: CommandRunner = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'goose') {
      const mode = (await stat(taskPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(args.join(' ')).not.toContain(task);
      return { code: 0, stdout: 'z'.repeat(STDOUT_LIMIT + 50), stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, { recipePath: GOOSE_RECIPE_PATH, taskPath, workspace });
  const port = await listen(server);
  try {
    const health = await getJson(port, '/health');
    expect(health.statusCode).toBe(200);
    expect(health.body).toMatchObject({ status: 'Healthy' });
    expect(typeof health.body.time_of_last_update).toBe('number');

    const response = await postJson(port, { repoUrl: HELLO, task });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      diff: 'diff --git a/README.md\n',
    });
    expect(response.body.stdout).toHaveLength(STDOUT_LIMIT);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }

  const clone = calls.find((call) => call.command === 'git' && call.args[0] === 'clone');
  expect(clone?.args).toEqual(['clone', '--depth', '1', HELLO, workspace]);
  const goose = calls.find((call) => call.command === 'goose');
  expect(goose?.args).toEqual(gooseArguments().slice(1));
  expect(goose?.cwd).toBe(workspace);
  expect(calls.some((call) => call.args.some((arg) => /gateway/i.test(arg)))).toBe(false);
});

test('a goose failure is HTTP 200 and still returns the diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const run: CommandRunner = async (command, args) => {
    if (command === 'goose') {
      return { code: 1, stdout: '', stderr: 'Bedrock access denied' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, {
    recipePath: GOOSE_RECIPE_PATH,
    taskPath: join(root, 'task.md'),
    workspace: join(root, 'workspace'),
  });
  const port = await listen(server);
  try {
    const response = await postJson(port, { repoUrl: HELLO, task: 'edit the readme' });
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('error');
    expect(response.body.diff).toBe('diff --git a/README.md\n');
    expect(response.body.error).toContain('goose');
    expect(response.body.error).toContain('Bedrock access denied');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('a stored draft is formatted as the work order Goose reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const taskPath = join(root, 'task.md');
  const draft = sampleDraft();
  const run: CommandRunner = async (command, args) => {
    if (command === 'goose') {
      const task = await readFile(taskPath, 'utf8');
      expect(task).toContain('Draft: draft-1');
      expect(task).toContain('Add a Smoke line to README.md');
      expect(task).toContain('octocat/Hello-World');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(
    run,
    { recipePath: GOOSE_RECIPE_PATH, taskPath, workspace: join(root, 'workspace') },
    async (key) => {
      expect(key).toEqual({ project: 'acme', draftId: 'draft-1' });
      return draft;
    },
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { repoUrl: HELLO, project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'success', diff: 'diff --git a/README.md\n' });
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing draft is HTTP 200 with an error', async () => {
  const server = createGooseServer(
    async () => {
      throw new Error('should not run');
    },
    {
      recipePath: GOOSE_RECIPE_PATH,
      taskPath: '/tmp/unused-task.md',
      workspace: '/tmp/unused-workspace',
    },
    async () => undefined,
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { repoUrl: HELLO, project: 'acme', draftId: 'missing' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'error', error: 'No draft with that id.' });
  } finally {
    await close(server);
  }
});

test('a repo that is not on the work order is HTTP 400', async () => {
  const server = createGooseServer(
    async () => {
      throw new Error('should not run');
    },
    {
      recipePath: GOOSE_RECIPE_PATH,
      taskPath: '/tmp/unused-task.md',
      workspace: '/tmp/unused-workspace',
    },
    async () => sampleDraft(),
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, {
      repoUrl: 'https://github.com/octocat/Spoon-Knife',
      project: 'acme',
      draftId: 'draft-1',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body.status).toBe('error');
    expect(response.body.error).toContain('work order');
  } finally {
    await close(server);
  }
});

test('validation failure is HTTP 400', async () => {
  const server = createGooseServer(async () => {
    throw new Error('should not run');
  });
  const port = await listen(server);
  try {
    const response = await postJson(port, { repoUrl: 'ssh://git@github.com/octocat/Hello-World', task: '' });
    expect(response.statusCode).toBe(400);
    expect(response.body.status).toBe('error');
  } finally {
    await close(server);
  }
});

test('while goose is running, ping is HealthyBusy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  let port = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run: CommandRunner = async (command) => {
    if (command === 'goose') {
      const ping = await getJson(port, '/ping');
      expect(ping.body.status).toBe('HealthyBusy');
      release();
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, {
    recipePath: GOOSE_RECIPE_PATH,
    taskPath: join(root, 'task.md'),
    workspace: join(root, 'workspace'),
  });
  port = await listen(server);
  try {
    const pending = postJson(port, { repoUrl: HELLO, task: 'edit the readme' });
    await gate;
    const response = await pending;
    expect(response.body.status).toBe('success');
    const idle = await getJson(port, '/ping');
    expect(idle.body.status).toBe('Healthy');
  } finally {
    release();
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('the minivela stack includes the goose runtime', () => {
  const template = Template.fromStack(stackOf(createApp()));
  template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2);
  template.resourceCountIs('AWS::EC2::VPC', 0);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
  template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: 'minivela_goose',
    ProtocolConfiguration: 'HTTP',
    NetworkConfiguration: Match.objectLike({ NetworkMode: 'PUBLIC' }),
    LifecycleConfiguration: {
      IdleRuntimeSessionTimeout: 300,
      MaxLifetime: 900,
    },
    EnvironmentVariables: {
      GOOSE_PROVIDER: 'aws_bedrock',
      GOOSE_MODEL: GOOSE_MODEL_ID,
      GOOSE_MODE: 'auto',
      GOOSE_DISABLE_SESSION_NAMING: 'true',
      GOOSE_PATH_ROOT: '/tmp/goose',
      DRAFTS_TABLE_NAME: Match.anyValue(),
    },
  });
  template.hasOutput('GooseRuntimeArn', {});

  const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime')).find(
    (resource) => resource.Properties.AgentRuntimeName === 'minivela_goose',
  ) as { Properties: { RoleArn: { 'Fn::GetAtt': string[] }; NetworkConfiguration: { NetworkModeConfig?: unknown } } };
  expect(runtime.Properties.NetworkConfiguration.NetworkModeConfig).toBeUndefined();
  const roleId = runtime.Properties.RoleArn['Fn::GetAtt'][0];
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
    JSON.stringify(policy.Properties.Roles).includes(roleId),
  );
  const policy = JSON.stringify(policies);
  expect(policy).toContain('bedrock:InvokeModel');
  expect(policy).toContain(`foundation-model/${GOOSE_MODEL_ID}`);
  expect(policy).toContain('dynamodb:GetItem');
  expect(policy).not.toContain('bedrock:Retrieve');
  expect(policy).not.toContain('dynamodb:Query');
  expect(policy).not.toContain('dynamodb:PutItem');
  expect(policy).not.toContain('s3:');
  expect(JSON.stringify(template.toJSON())).not.toContain('goose_smoke');
});

function sampleDraft(): DraftWrite {
  return {
    project: 'acme',
    draftId: 'draft-1',
    createdAt: '2026-10-21T00:00:00.000Z',
    workOrder: {
      intent: 'Add a Smoke line to README.md',
      summary: 'Add a Smoke line to README.md',
      repos: [{ owner: 'octocat', repo: 'Hello-World' }],
      constraints: ['small diff'],
      acceptance: ['README has a Smoke line'],
      rules: [{ project: 'global', ruleId: 'r1', title: 'Small diffs', body: 'Do not widen the change.' }],
      rulePrecedence: 'follow the rule',
    },
    citations: { decisionIds: [], documentUris: [] },
  };
}

function stackOf(app: ReturnType<typeof createApp>) {
  return app.node.findChild(DEFAULT_STACK_NAME) as import('aws-cdk-lib/core').Stack;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a port');
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function getJson(port: number, path: string): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(
  port: number,
  body: unknown,
): Promise<{ statusCode: number; body: { status?: string; diff?: string; stdout?: string; error?: string } }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/invocations',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              status?: string;
              diff?: string;
              stdout?: string;
              error?: string;
            },
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
