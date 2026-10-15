import { answerFromMemory, parseInvokePayload } from '../lib/agent/answer.js';
import { draftWorkOrder } from '../lib/agent/draft.js';
import { checkReadiness } from '../lib/agent/readiness.js';
import { projectRetrieveFilter, projectRetrieveValues } from '../lib/project-filter.js';

test('a retrieve for a client includes global', () => {
  expect(projectRetrieveValues('bpp')).toEqual(['bpp', 'global']);
  expect(projectRetrieveFilter('bpp')).toEqual({ in: { key: 'project', value: ['bpp', 'global'] } });
});

test('a retrieve for global does not open other clients', () => {
  expect(projectRetrieveValues('global')).toEqual(['global']);
});

test('an empty project is invalid', () => {
  expect(() => projectRetrieveValues('  ')).toThrow(/project/);
});

test('invoke without a project is rejected', () => {
  expect(parseInvokePayload({ prompt: 'what is RFC 162' })).toEqual({
    response: 'Name a project. The agent will not search without one.',
    status: 'error',
  });
});

test('invoke without a prompt is rejected', () => {
  expect(parseInvokePayload({ project: 'bpp' })).toMatchObject({ status: 'error' });
});

test('check-readiness is accepted as a skill', () => {
  expect(parseInvokePayload({ prompt: 'JOIN single table', project: 'bpp', skill: 'check-readiness' })).toEqual({
    prompt: 'JOIN single table',
    project: 'bpp',
    skill: 'check-readiness',
  });
});

test('draft-work-order is accepted as a skill', () => {
  expect(parseInvokePayload({ prompt: 'JOIN single table', project: 'bpp', skill: 'draft-work-order' })).toEqual({
    prompt: 'JOIN single table',
    project: 'bpp',
    skill: 'draft-work-order',
  });
});

test('an unknown skill is rejected', () => {
  expect(parseInvokePayload({ prompt: 'JOIN single table', project: 'bpp', skill: 'draft' })).toEqual({
    response: 'skill must be check-readiness or draft-work-order when set.',
    status: 'error',
  });
});

test('answer uses retrieved decisions and documents for that project', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockResolvedValue([
    {
      project: 'bpp',
      decisionId: 'abc',
      title: 'CSV only',
      content: 'v1 ships CSV.',
      quote: 'Excel is out of scope.',
      speaker: 'Marcus Webb',
      timestamp: '00:00:20.500',
      loggedAt: '2026-10-15T12:00:00.000Z',
      sourceKey: 'bpp/transcripts/standup.vtt',
    },
  ]);
  const complete = jest.fn().mockResolvedValue('CSV only. Cite the later loggedAt.');
  const result = await answerFromMemory({
    prompt: 'RFC 162',
    project: 'bpp',
    retrieve,
    searchDecisions,
    complete,
  });
  expect(retrieve).toHaveBeenCalledWith({ prompt: 'RFC 162', project: 'bpp' });
  expect(searchDecisions).toHaveBeenCalledWith({ prompt: 'RFC 162', project: 'bpp' });
  expect(complete).toHaveBeenCalledWith({
    prompt: 'RFC 162',
    project: 'bpp',
    chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
    decisions: [
      {
        project: 'bpp',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Marcus Webb',
        timestamp: '00:00:20.500',
        loggedAt: '2026-10-15T12:00:00.000Z',
        sourceKey: 'bpp/transcripts/standup.vtt',
      },
    ],
  });
  expect(result).toEqual({ response: 'CSV only. Cite the later loggedAt.', status: 'success' });
});

test('a failed decision search still answers from documents', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockRejectedValue(new Error('SearchVectors failed'));
  const complete = jest.fn().mockResolvedValue('Use a single table.');
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await answerFromMemory({
      prompt: 'RFC 162',
      project: 'bpp',
      retrieve,
      searchDecisions,
      complete,
    });
    expect(complete).toHaveBeenCalledWith({
      prompt: 'RFC 162',
      project: 'bpp',
      chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
      decisions: [],
    });
    expect(result).toEqual({ response: 'Use a single table.', status: 'success' });
  } finally {
    error.mockRestore();
  }
});

test('check-readiness loads rules, repos, decisions, and documents', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockResolvedValue([]);
  const loadRules = jest.fn().mockResolvedValue([
    {
      project: 'global',
      ruleId: 'small-diffs',
      title: 'Small diffs. No drive-by refactors.',
      body: 'Prefer small, reviewable diffs.',
    },
  ]);
  const loadRepos = jest.fn().mockResolvedValue([
    {
      project: 'bpp',
      repoId: 'bpp/learn',
      owner: 'bpp',
      repo: 'learn',
      url: 'https://github.com/bpp/learn',
      summary: 'Learner app.',
    },
  ]);
  const complete = jest.fn().mockResolvedValue('Ready. Target bpp/learn. Cite small-diffs.');
  const result = await checkReadiness({
    prompt: 'JOIN single table',
    project: 'bpp',
    retrieve,
    searchDecisions,
    loadRules,
    loadRepos,
    complete,
  });
  expect(loadRules).toHaveBeenCalledWith('bpp');
  expect(loadRepos).toHaveBeenCalledWith('bpp');
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'JOIN single table',
      project: 'bpp',
      rules: [expect.objectContaining({ ruleId: 'small-diffs' })],
      repos: [expect.objectContaining({ repoId: 'bpp/learn' })],
    }),
  );
  expect(result.status).toBe('success');
});

const learnRepo = {
  project: 'bpp',
  repoId: 'bpp/learn',
  owner: 'bpp',
  repo: 'learn',
  url: 'https://github.com/bpp/learn',
  summary: 'Learner app.',
};

const validDraftJson = JSON.stringify({
  intent: 'Single-table JOIN applications',
  summary: 'Migrate JOIN applications onto one DynamoDB table in bpp/learn.',
  repos: [{ owner: 'bpp', repo: 'learn' }],
  constraints: ['Match existing patterns in bpp/learn.'],
  acceptance: ['Query path covered by a test.'],
  citations: { decisionIds: ['abc'], documentUris: ['s3://doc/rfc.md'] },
});

test('draft-work-order stores a work order that names a mapped repo', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'JOIN single table',
    project: 'bpp',
    retrieve: jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]),
    searchDecisions: jest.fn().mockResolvedValue([
      {
        project: 'bpp',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Marcus Webb',
        timestamp: '00:00:20.500',
        loggedAt: '2026-10-15T12:00:00.000Z',
        sourceKey: 'bpp/transcripts/standup.vtt',
      },
    ]),
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([learnRepo]),
    complete: jest.fn().mockResolvedValue(validDraftJson),
    put,
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
  });
  expect(put).toHaveBeenCalledWith({
    project: 'bpp',
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
    workOrder: {
      intent: 'Single-table JOIN applications',
      summary: 'Migrate JOIN applications onto one DynamoDB table in bpp/learn.',
      repos: [{ owner: 'bpp', repo: 'learn' }],
      constraints: ['Match existing patterns in bpp/learn.'],
      acceptance: ['Query path covered by a test.'],
      project: 'bpp',
    },
    citations: { decisionIds: ['abc'], documentUris: ['s3://doc/rfc.md'] },
  });
  expect(result.status).toBe('success');
  expect(JSON.parse(result.response).draftId).toBe('draft-1');
});

test('draft-work-order does not store a repo that is not in the map', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'JOIN single table',
    project: 'bpp',
    retrieve: jest.fn().mockResolvedValue([]),
    searchDecisions: jest.fn().mockResolvedValue([]),
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([learnRepo]),
    complete: jest.fn().mockResolvedValue(
      JSON.stringify({
        intent: 'Invented',
        summary: 'Uses a repo that is not mapped.',
        repos: [{ owner: 'acme', repo: 'other' }],
        constraints: ['None.'],
        acceptance: ['None.'],
      }),
    ),
    put,
    draftId: 'draft-2',
    createdAt: '2026-10-15T21:00:00.000Z',
  });
  expect(put).not.toHaveBeenCalled();
  expect(result).toEqual({
    response: 'The draft named a repo that is not in the project map.',
    status: 'success',
  });
});

test('draft-work-order does not store when the model is blocked', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'JOIN single table',
    project: 'demo',
    retrieve: jest.fn().mockResolvedValue([]),
    searchDecisions: jest.fn().mockResolvedValue([]),
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([]),
    complete: jest.fn().mockResolvedValue(JSON.stringify({ blocked: 'No target repo exists.' })),
    put,
    draftId: 'draft-3',
    createdAt: '2026-10-15T21:00:00.000Z',
  });
  expect(put).not.toHaveBeenCalled();
  expect(result).toEqual({
    response: 'No target repo exists.',
    status: 'success',
  });
});

