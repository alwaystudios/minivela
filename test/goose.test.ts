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
  githubCloneUrl,
  gooseArguments,
  gooseBranch,
  GOOSE_ASKPASS_PATH,
  GOOSE_GIT_EMAIL,
  GOOSE_GIT_NAME,
  GOOSE_RECIPE_PATH,
  parseInvocation,
  parseRepoRef,
  selectTargetRepo,
  STDOUT_LIMIT,
  type CommandRunner,
  type GoosePaths,
} from '../goose/server.js';

jest.setTimeout(180_000);

const HELLO = 'https://github.com/octocat/Hello-World';
const CLONE_SHA = 'abc1234';
const TEST_GIT_PAT = 'test-git-pat';
const presentGitPat = async () => TEST_GIT_PAT;

test('accepts a stored draft', () => {
  const parsed = parseInvocation({ project: 'acme', draftId: 'draft-1' });
  expect(parsed).toEqual({ ok: true, project: 'acme', draftId: 'draft-1' });
});

test('accepts a stored draft with a repo selector', () => {
  const parsed = parseInvocation({ project: 'acme', draftId: 'draft-1', repo: 'octocat/Hello-World' });
  expect(parsed).toEqual({ ok: true, project: 'acme', draftId: 'draft-1', repo: 'octocat/Hello-World' });
});

test.each(['', '   '])('rejects an empty project %j', (project) => {
  const parsed = parseInvocation({ project, draftId: 'draft-1' });
  expect(parsed.ok).toBe(false);
});

test.each([
  ['https://github.com/octocat/Hello-World', 'url'],
  ['octocat', 'missing name'],
  ['octocat/Hello-World/extra', 'extra path'],
  ['git@github.com:octocat/Hello-World', 'ssh'],
])('rejects repo %s', (repo) => {
  const parsed = parseInvocation({ project: 'acme', draftId: 'draft-1', repo });
  expect(parsed.ok).toBe(false);
});

test('rejects repoUrl and task', () => {
  expect(parseInvocation({ project: 'acme', draftId: 'draft-1', repoUrl: HELLO }).ok).toBe(false);
  expect(parseInvocation({ project: 'acme', draftId: 'draft-1', task: 'edit the readme' }).ok).toBe(false);
  expect(parseInvocation({ repoUrl: HELLO, task: 'edit the readme' }).ok).toBe(false);
});

test('selects the only repo on the work order', () => {
  expect(selectTargetRepo(sampleDraft())).toEqual({ ok: true, owner: 'octocat', repo: 'Hello-World' });
  expect(githubCloneUrl({ owner: 'octocat', repo: 'Hello-World' })).toBe(HELLO);
});

test('a named repo must be on the work order', () => {
  expect(selectTargetRepo(sampleDraft(), 'octocat/Hello-World')).toEqual({
    ok: true,
    owner: 'octocat',
    repo: 'Hello-World',
  });
  expect(selectTargetRepo(sampleDraft(), 'octocat/Spoon-Knife').ok).toBe(false);
});

test('more than one repo needs a selector', () => {
  const draft = twoRepoDraft();
  expect(selectTargetRepo(draft).ok).toBe(false);
  expect(selectTargetRepo(draft, 'octocat/Spoon-Knife')).toEqual({
    ok: true,
    owner: 'octocat',
    repo: 'Spoon-Knife',
  });
});

test('parseRepoRef accepts owner/repo only', () => {
  expect(parseRepoRef('octocat/Hello-World')).toEqual({ ok: true, owner: 'octocat', repo: 'Hello-World' });
  expect(parseRepoRef('https://github.com/octocat/Hello-World').ok).toBe(false);
});

test('the pushed branch is goose/<draftId>', () => {
  expect(gooseBranch('draft-1')).toBe('goose/draft-1');
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
  const paths = testPaths(root);
  const calls: Array<{ command: string; args: string[]; cwd?: string; env?: Record<string, string> }> = [];
  const reads: Array<{ project: string; name: string }> = [];
  const logs: string[] = [];
  const logSpy = jest.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logs.push(String(line));
  });
  try {
  const run: CommandRunner = async (command, args, cwd, env) => {
    calls.push({ command, args, cwd, env });
    if (command === 'goose') {
      const mode = (await stat(paths.taskPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(await readFile(paths.targetPath, 'utf8')).toBe('octocat/Hello-World\n');
      expect(await readFile(paths.taskPath, 'utf8')).not.toContain(TEST_GIT_PAT);
      return { code: 0, stdout: 'z'.repeat(STDOUT_LIMIT + 50), stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, paths, async () => sampleDraft(), async (project, name) => {
    reads.push({ project, name });
    return TEST_GIT_PAT;
  });
  const port = await listen(server);
  try {
    const health = await getJson(port, '/health');
    expect(health.statusCode).toBe(200);
    expect(health.body).toMatchObject({ status: 'Healthy' });
    expect(typeof health.body.time_of_last_update).toBe('number');

    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      response: { diff: 'diff --git a/README.md\n', branch: 'goose/draft-1' },
    });
    expect(response.body.response?.stdout).toHaveLength(STDOUT_LIMIT);
    expect(response.body.response?.stdout).not.toContain(TEST_GIT_PAT);
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }

  const clone = calls.find((call) => call.command === 'git' && call.args[0] === 'clone');
  expect(clone?.args).toEqual(['clone', '--depth', '1', HELLO, paths.workspace]);
  expect(clone?.env).toBeUndefined();
  expect(calls.find((call) => call.command === 'git' && call.args[0] === 'diff')?.args).toEqual([
    'diff',
    '--cached',
    CLONE_SHA,
  ]);
  expect(calls.find((call) => call.command === 'git' && call.args[0] === 'ls-remote')?.args).toEqual([
    'ls-remote',
    '--heads',
    'origin',
    'refs/heads/goose/draft-1',
  ]);
  expect(calls.find((call) => call.command === 'git' && call.args[0] === 'checkout')?.args).toEqual([
    'checkout',
    '-b',
    'goose/draft-1',
  ]);
  expect(calls.find((call) => call.command === 'git' && call.args[0] === 'reset')?.args).toEqual([
    'reset',
    '--soft',
    CLONE_SHA,
  ]);
  const commit = calls.find((call) => call.command === 'git' && call.args.includes('commit'));
  expect(commit?.args).toEqual([
    '-c',
    `user.name=${GOOSE_GIT_NAME}`,
    '-c',
    `user.email=${GOOSE_GIT_EMAIL}`,
    'commit',
    '-m',
    'Apply draft draft-1',
  ]);
  const push = calls.find((call) => call.command === 'git' && call.args[0] === 'push');
  expect(push?.args).toEqual(['push', 'origin', 'HEAD:refs/heads/goose/draft-1']);
  expect(push?.args).not.toContain('--force');
  expect(push?.args).not.toContain('-f');
  expect(push?.env).toEqual({
    GIT_ASKPASS: GOOSE_ASKPASS_PATH,
    GIT_TERMINAL_PROMPT: '0',
    GOOSE_GIT_PAT: TEST_GIT_PAT,
  });
  const goose = calls.find((call) => call.command === 'goose');
  expect(goose?.args).toEqual(gooseArguments().slice(1));
  expect(goose?.cwd).toBe(paths.workspace);
  expect(calls.some((call) => call.args.some((arg) => /gateway/i.test(arg)))).toBe(false);
  expect(JSON.stringify(calls.map(({ env: _env, ...call }) => call))).not.toContain(TEST_GIT_PAT);
  expect(reads).toEqual([{ project: 'acme', name: 'git-pat' }]);
  expect(logs).toContain(
    JSON.stringify({
      project: 'acme',
      draftId: 'draft-1',
      secretId: 'minivela/acme/git-pat',
      status: 'loaded',
    }),
  );
  expect(logs.join('\n')).not.toContain(TEST_GIT_PAT);
  } finally {
    logSpy.mockRestore();
  }
});

test('a missing git-pat stops before clone and Goose', async () => {
  const server = createGooseServer(
    async () => {
      throw new Error('should not run');
    },
    unusedPaths(),
    async () => sampleDraft(),
    async () => {
      throw new Error('project secret minivela/acme/git-pat is missing or unreadable');
    },
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'error',
      response: { diff: '', error: 'project secret minivela/acme/git-pat is missing or unreadable' },
    });
  } finally {
    await close(server);
  }
});

test('an empty git-pat stops before clone and Goose', async () => {
  const server = createGooseServer(
    async () => {
      throw new Error('should not run');
    },
    unusedPaths(),
    async () => sampleDraft(),
    async () => '',
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'error',
      response: { diff: '', error: 'project secret minivela/acme/git-pat is missing or unreadable' },
    });
  } finally {
    await close(server);
  }
});

test('a goose failure is HTTP 200 and still returns the diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const run: CommandRunner = async (command, args) => {
    if (command === 'goose') {
      return { code: 1, stdout: '', stderr: 'Bedrock access denied' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('error');
    expect(response.body.response?.diff).toBe('diff --git a/README.md\n');
    expect(response.body.response?.error).toContain('goose');
    expect(response.body.response?.error).toContain('Bedrock access denied');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('a stored draft is formatted as the work order Goose reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const paths = testPaths(root);
  const draft = sampleDraft();
  const run: CommandRunner = async (command, args) => {
    if (command === 'goose') {
      const task = await readFile(paths.taskPath, 'utf8');
      expect(task).toContain('Draft: draft-1');
      expect(task).toContain('Add a Smoke line to README.md');
      expect(task).toContain('octocat/Hello-World');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(
    run,
    paths,
    async (key) => {
      expect(key).toEqual({ project: 'acme', draftId: 'draft-1' });
      return draft;
    },
    presentGitPat,
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      response: { diff: 'diff --git a/README.md\n', branch: 'goose/draft-1' },
    });
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
    unusedPaths(),
    async () => undefined,
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'missing' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'error',
      response: { error: 'No draft with that id.' },
    });
  } finally {
    await close(server);
  }
});

test('a repo that is not on the work order is HTTP 200 with an error', async () => {
  const server = createGooseServer(
    async () => {
      throw new Error('should not run');
    },
    unusedPaths(),
    async () => sampleDraft(),
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, {
      project: 'acme',
      draftId: 'draft-1',
      repo: 'octocat/Spoon-Knife',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('error');
    expect(response.body.response?.error).toContain('work order');
  } finally {
    await close(server);
  }
});

test('a multi-repo order without a selector is HTTP 200 with an error', async () => {
  const server = createGooseServer(
    async () => {
      throw new Error('should not run');
    },
    unusedPaths(),
    async () => twoRepoDraft(),
  );
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body.response?.error).toContain('more than one repository');
  } finally {
    await close(server);
  }
});

test('a multi-repo order with a selector clones that repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const paths = testPaths(root);
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, paths, async () => twoRepoDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, {
      project: 'acme',
      draftId: 'draft-1',
      repo: 'octocat/Spoon-Knife',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.response?.branch).toBe('goose/draft-1');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
  expect(calls.find((call) => call.command === 'git' && call.args[0] === 'clone')?.args).toEqual([
    'clone',
    '--depth',
    '1',
    'https://github.com/octocat/Spoon-Knife',
    paths.workspace,
  ]);
});

test('an empty diff after Goose exits 0 is an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'error',
      response: { diff: '', error: 'Goose made no changes' },
    });
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
  expect(calls.some((call) => call.command === 'git' && call.args[0] === 'push')).toBe(false);
  expect(calls.some((call) => call.command === 'git' && call.args.includes('commit'))).toBe(false);
});

test('an existing goose branch is an error and does not push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'ls-remote') {
      return { code: 0, stdout: 'abc1234\trefs/heads/goose/draft-1\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'error',
      response: { error: 'branch goose/draft-1 already exists', diff: 'diff --git a/README.md\n' },
    });
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
  expect(calls.some((call) => call.command === 'git' && call.args[0] === 'push')).toBe(false);
  expect(calls.some((call) => call.command === 'git' && call.args.includes('commit'))).toBe(false);
});

test('a push failure is an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const run: CommandRunner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    if (command === 'git' && args[0] === 'push') {
      return { code: 1, stdout: '', stderr: 'permission denied' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('error');
    expect(response.body.response?.error).toContain('git push');
    expect(response.body.response?.error).toContain('permission denied');
    expect(response.body.response?.branch).toBeUndefined();
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('a Goose commit is still a change because the diff is against the clone tip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const run: CommandRunner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      if (args.includes(CLONE_SHA)) {
        return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      response: { diff: 'diff --git a/README.md\n', branch: 'goose/draft-1' },
    });
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('a git add failure is an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goose-'));
  const run: CommandRunner = async (command, args) => {
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'add') {
      return { code: 1, stdout: '', stderr: 'index.lock' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  const port = await listen(server);
  try {
    const response = await postJson(port, { project: 'acme', draftId: 'draft-1' });
    expect(response.statusCode).toBe(200);
    expect(response.body.status).toBe('error');
    expect(response.body.response?.error).toContain('git add');
    expect(response.body.response?.error).toContain('index.lock');
  } finally {
    await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test('validation failure is HTTP 400', async () => {
  const server = createGooseServer(async () => {
    throw new Error('should not run');
  });
  const port = await listen(server);
  try {
    const response = await postJson(port, { repoUrl: HELLO, task: 'edit the readme' });
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
  const run: CommandRunner = async (command, args) => {
    if (command === 'goose') {
      const ping = await getJson(port, '/ping');
      expect(ping.body.status).toBe('HealthyBusy');
      release();
      return { code: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args[0] === 'rev-parse') {
      return { code: 0, stdout: `${CLONE_SHA}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'diff') {
      return { code: 0, stdout: 'diff --git a/README.md\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const server = createGooseServer(run, testPaths(root), async () => sampleDraft(), presentGitPat);
  port = await listen(server);
  try {
    const pending = postJson(port, { project: 'acme', draftId: 'draft-1' });
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

function twoRepoDraft(): DraftWrite {
  const draft = sampleDraft();
  return {
    ...draft,
    workOrder: {
      ...draft.workOrder,
      repos: [
        { owner: 'octocat', repo: 'Hello-World' },
        { owner: 'octocat', repo: 'Spoon-Knife' },
      ],
    },
  };
}

function testPaths(root: string): GoosePaths {
  return {
    recipePath: GOOSE_RECIPE_PATH,
    taskPath: join(root, 'task.md'),
    targetPath: join(root, 'target'),
    workspace: join(root, 'workspace'),
  };
}

function unusedPaths(): GoosePaths {
  return {
    recipePath: GOOSE_RECIPE_PATH,
    taskPath: '/tmp/unused-task.md',
    targetPath: '/tmp/unused-target',
    workspace: '/tmp/unused-workspace',
  };
}

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
): Promise<{
  statusCode: number;
  body: { status?: string; response?: { diff?: string; stdout?: string; error?: string; branch?: string } };
}> {
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
              response?: { diff?: string; stdout?: string; error?: string; branch?: string };
            },
          });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}
