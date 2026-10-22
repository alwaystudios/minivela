import {
  BREAKDOWN_SYSTEM_PROMPT,
  breakdownCompletionFromModel,
  breakdownSearchQuery,
  draftBreakdown,
  fetchStoredBreakdown,
  type DraftBreakdownRun,
} from '../lib/agent/draft-breakdown.js';
import type { Repo } from '../lib/lookup.js';

const createdAt = '2026-10-20T18:00:00.000Z';
const page = 'acme/notes/billing.md';
const pageText = '# Bill the new meter\n\nShow the tariff, then record the reading.\n';

const repo: Repo = {
  project: 'acme',
  repoId: 'billing',
  owner: 'acme',
  repo: 'billing',
  url: 'https://example.com/acme/billing',
  summary: 'Bills meters. Module src/tariff.ts.',
};

const sonnetUsage = {
  model: 'us.anthropic.claude-sonnet-4-6',
  startedAt: '2026-10-20T18:00:00.000Z',
  finishedAt: '2026-10-20T18:00:01.000Z',
};

function counted(text: string, cutOff = false, usage: { input_tokens?: number; output_tokens?: number } = { input_tokens: 10, output_tokens: 20 }) {
  return breakdownCompletionFromModel({
    text,
    cutOff,
    ...sonnetUsage,
    usage,
  });
}

function draft(input: Partial<Parameters<typeof draftBreakdown>[0]> = {}) {
  const put = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
  const putRun = jest.fn<Promise<void>, [DraftBreakdownRun]>().mockResolvedValue(undefined);
  const complete = jest.fn().mockResolvedValue(
    counted(
      JSON.stringify({
        epic: '# Bill the new meter',
        stories: ['# Show the tariff', '# Record the reading'],
      }),
    ),
  );
  const ready = draftBreakdown({
    project: 'acme',
    page,
    readPage: async () => pageText,
    retrieve: async () => [],
    searchDecisions: async () => [],
    loadRepos: async () => [repo],
    loadTemplate: async () => undefined,
    complete,
    put,
    putRun,
    breakdownId: 'bd-1',
    createdAt,
    ...input,
  });
  return { ready, put, putRun: input.putRun ?? putRun, complete: input.complete ?? complete };
}

test('the prompt keeps repo names on the map and follows ordinary Jira practice', () => {
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('Return JSON only, not the combined document.');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('Decisions overrule the page.');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('Repo names come from the repo map only.');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('A module path in a story is a claim taken from the page, a decision, or a repo summary.');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('Each ticket says the repo was not opened.');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('follow ordinary Jira practice');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('Do not invent an issue key. The heading is the ticket title.');
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain('There is no story-count cap.');
  expect(BREAKDOWN_SYSTEM_PROMPT).not.toContain('Rules apply');
  expect(BREAKDOWN_SYSTEM_PROMPT).not.toContain('the rules');
});

test('a missing page stores one refusal and does not call the model', async () => {
  const { ready, put, complete } = draft({ readPage: async () => undefined });
  await expect(ready).resolves.toEqual({
    response: 'No object at acme/notes/billing.md.\n',
    status: 'refused',
    breakdownId: 'bd-1',
  });
  expect(put).toHaveBeenCalledWith([
    expect.objectContaining({
      kind: 'refusal',
      ordinal: 0,
      page,
      body: 'No object at acme/notes/billing.md.',
    }),
  ]);
  expect(complete).not.toHaveBeenCalled();
});

test('an empty page stores one refusal and does not call the model', async () => {
  const { ready, complete } = draft({ readPage: async () => '  \n' });
  await expect(ready).resolves.toMatchObject({
    response: expect.stringContaining('The page is empty.'),
    status: 'refused',
  });
  expect(complete).not.toHaveBeenCalled();
});

test('an empty repo map stores one refusal and does not call the model', async () => {
  const { ready, put, complete } = draft({ loadRepos: async () => [] });
  await expect(ready).resolves.toMatchObject({ status: 'refused' });
  expect(put).toHaveBeenCalledWith([expect.objectContaining({ body: 'The repo map is empty.' })]);
  expect(complete).not.toHaveBeenCalled();
});

test('a failed repo query stores one refusal and does not call the model', async () => {
  const { ready, complete } = draft({
    loadRepos: async () => {
      throw new Error('query failed');
    },
  });
  await expect(ready).resolves.toMatchObject({
    response: expect.stringContaining('The repo map failed to load.'),
    status: 'refused',
  });
  expect(complete).not.toHaveBeenCalled();
});

test('a failed decision search stores nothing and does not call the model', async () => {
  const { ready, put, complete } = draft({
    searchDecisions: async () => {
      throw new Error('search failed');
    },
  });
  await expect(ready).resolves.toEqual({ response: 'Decision search failed.', status: 'error' });
  expect(put).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

test('a failed document search stores nothing and does not call the model', async () => {
  const { ready, put, complete } = draft({
    retrieve: async () => {
      throw new Error('retrieve failed');
    },
  });
  await expect(ready).resolves.toEqual({ response: 'Document search failed.', status: 'error' });
  expect(put).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

test('search uses the heading, or the first line when the page has none', () => {
  expect(breakdownSearchQuery(pageText)).toBe('Bill the new meter');
  expect(breakdownSearchQuery('Show the tariff.\n\nThen record it.\n')).toBe('Show the tariff.');
});

test('an empty decision search still drafts', async () => {
  const searchDecisions = jest.fn().mockResolvedValue([]);
  const { ready, complete } = draft({ searchDecisions });
  await expect(ready).resolves.toMatchObject({ status: 'success' });
  expect(searchDecisions).toHaveBeenCalledWith({ prompt: 'Bill the new meter', project: 'acme' });
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ decisions: [], pageText }));
});

test('a project template replaces the global one', async () => {
  const loadTemplate = jest.fn(async (project: string) => (project === 'acme' ? '# Project template' : '# Global template'));
  const { ready, complete } = draft({ loadTemplate });
  await ready;
  expect(loadTemplate).toHaveBeenCalledWith('acme');
  expect(loadTemplate).not.toHaveBeenCalledWith('global');
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ template: '# Project template' }));
});

test('a missing project template uses global, then ordinary practice', async () => {
  const globalOnly = jest.fn(async (project: string) => (project === 'global' ? '# Global template' : '  '));
  const { ready, complete } = draft({ loadTemplate: globalOnly });
  await ready;
  expect(complete).toHaveBeenCalledWith(expect.objectContaining({ template: '# Global template' }));

  const none = jest.fn(async () => undefined);
  const second = draft({ loadTemplate: none, project: 'acme' });
  await second.ready;
  expect(none).toHaveBeenCalledWith('acme');
  expect(none).toHaveBeenCalledWith('global');
  expect(second.complete).toHaveBeenCalledWith(expect.not.objectContaining({ template: expect.anything() }));
});

test('a template read failure stores nothing', async () => {
  const { ready, put, complete } = draft({
    loadTemplate: async () => {
      throw new Error('get failed');
    },
  });
  await expect(ready).rejects.toThrow('get failed');
  expect(put).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

test('a drafted epic and its stories are stored in ordinal order', async () => {
  const retrieve = jest.fn().mockResolvedValue([
    { text: pageText, uri: 's3://docs/acme/notes/billing.md' },
    { text: 'Tariff notes', uri: 's3://docs/acme/notes/tariff.md' },
  ]);
  const { ready, put } = draft({ retrieve });
  await expect(ready).resolves.toEqual({
    response: [
      'Epic',
      '',
      '# Bill the new meter',
      '',
      'Story',
      '',
      '# Show the tariff',
      '',
      'Story',
      '',
      '# Record the reading',
      '',
    ].join('\n'),
    status: 'success',
    breakdownId: 'bd-1',
  });
  expect(retrieve).toHaveBeenCalledWith({ prompt: 'Bill the new meter', project: 'acme' });
  expect(put).toHaveBeenCalledWith([
    expect.objectContaining({
      ticketId: 'bd-1#0',
      kind: 'epic',
      ordinal: 0,
      page,
      body: '# Bill the new meter',
    }),
    expect.objectContaining({ ticketId: 'bd-1#1', kind: 'story', ordinal: 1, body: '# Show the tariff' }),
    expect.objectContaining({ ticketId: 'bd-1#2', kind: 'story', ordinal: 2, body: '# Record the reading' }),
  ]);
  const rows = put.mock.calls[0][0] as Array<Record<string, unknown>>;
  expect(rows.slice(1).every((row) => !Object.prototype.hasOwnProperty.call(row, 'page'))).toBe(true);
});

test('the page chunk is not sent to the model', async () => {
  const { ready, complete } = draft({
    retrieve: async () => [
      { text: pageText, uri: 's3://docs/acme/notes/billing.md' },
      { text: 'Tariff notes', uri: 's3://docs/acme/notes/tariff.md' },
    ],
  });
  await ready;
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({
      chunks: [{ text: 'Tariff notes', uri: 's3://docs/acme/notes/tariff.md' }],
    }),
  );
});

test('a page the model cannot split is stored as a refusal', async () => {
  const { ready, put } = draft({
    complete: async () => counted(JSON.stringify({ reasons: 'The page is a status report.' })),
  });
  await expect(ready).resolves.toEqual({
    response: 'The page is a status report.\n',
    status: 'refused',
    breakdownId: 'bd-1',
  });
  expect(put).toHaveBeenCalledWith([
    expect.objectContaining({ kind: 'refusal', ordinal: 0, page, body: 'The page is a status report.' }),
  ]);
});

test('a cut-off reply writes no rows', async () => {
  const { ready, put } = draft({
    complete: async () => counted(JSON.stringify({ epic: '# Bill the new meter', stories: ['# Show the tariff'] }), true),
  });
  await expect(ready).resolves.toEqual({ response: 'The model reply was cut off.', status: 'error' });
  expect(put).not.toHaveBeenCalled();
});

test('a literal copy of the split example is stored', async () => {
  const example = '{"epic":"# Epic","stories":["# Story"]}';
  expect(BREAKDOWN_SYSTEM_PROMPT).toContain(`return ${example}`);
  const { ready, put } = draft({
    complete: async () => counted(example),
  });
  await expect(ready).resolves.toMatchObject({ status: 'success', breakdownId: 'bd-1' });
  expect(put).toHaveBeenCalledWith([
    expect.objectContaining({ kind: 'epic', ordinal: 0, body: '# Epic' }),
    expect.objectContaining({ kind: 'story', ordinal: 1, body: '# Story' }),
  ]);
});

test('a reply that does not parse writes no rows and logs the model text', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const { ready, put } = draft({
    complete: async () => counted('not json'),
  });
  await expect(ready).resolves.toEqual({ response: 'The model reply could not be parsed.', status: 'error' });
  expect(put).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith('not json');
  error.mockRestore();
});

test('quotation marks inside a ticket are stored', async () => {
  const text = [
    '```json',
    '{',
    '  "epic": "# Bill the meter\\n\\nAnswer "what have we got?", "who owns it?".",',
    '  "stories": [',
    '    "# Show the tariff\\n\\nSay "hello"."',
    '  ]',
    '}',
    '```',
  ].join('\n');
  const { ready, put } = draft({
    complete: async () => counted(text),
  });
  await expect(ready).resolves.toMatchObject({ status: 'success' });
  expect(put).toHaveBeenCalledWith([
    expect.objectContaining({
      kind: 'epic',
      body: '# Bill the meter\n\nAnswer "what have we got?", "who owns it?".',
    }),
    expect.objectContaining({ kind: 'story', body: '# Show the tariff\n\nSay "hello".' }),
  ]);
});

test('a stored story keeps the markdown the model returned', async () => {
  const story = '# Record the reading  \n';
  const { ready, put } = draft({
    complete: async () =>
      counted('```json\n{"epic":"# Bill the new meter","stories":["' + story.replace(/\n/g, '\\n') + '"]}\n```'),
  });
  await ready;
  expect(put).toHaveBeenCalledWith([
    expect.objectContaining({ kind: 'epic', body: '# Bill the new meter' }),
    expect.objectContaining({ kind: 'story', body: story }),
  ]);
});

test('a draft-breakdown whose model response has both counts writes one row', async () => {
  const rows: DraftBreakdownRun[] = [];
  const { ready } = draft({
    putRun: async (row) => {
      rows.push(row);
    },
    complete: async () =>
      counted(
        JSON.stringify({
          epic: '# Bill the new meter',
          stories: ['# Show the tariff'],
        }),
        false,
        { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      ),
  });
  const result = await ready;
  expect(result).toMatchObject({ status: 'success', breakdownId: 'bd-1' });
  expect(rows).toEqual([
    {
      project: 'acme',
      runId: expect.any(String),
      step: 'draft-breakdown',
      model: 'us.anthropic.claude-sonnet-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      estimatedUsd: 18,
      startedAt: sonnetUsage.startedAt,
      finishedAt: sonnetUsage.finishedAt,
      status: 'success',
      breakdownId: 'bd-1',
    },
  ]);
  expect(rows[0]).not.toHaveProperty('page');
  expect(rows[0]).not.toHaveProperty('draftId');
  expect(rows[0]).not.toHaveProperty('branch');
  expect(rows[0]).not.toHaveProperty('grade');
  expect(rows[0]).not.toHaveProperty('repoUrl');
  expect(rows[0]).not.toHaveProperty('prompt');
  expect(rows[0]).not.toHaveProperty('stdout');
  expect(rows[0]).not.toHaveProperty('diff');
  expect(JSON.stringify(rows[0])).not.toContain(pageText);
});

test('an empty repo map writes no row', async () => {
  const putRun = jest.fn();
  const { ready, complete } = draft({ loadRepos: async () => [], putRun });
  await expect(ready).resolves.toMatchObject({ status: 'refused' });
  expect(complete).not.toHaveBeenCalled();
  expect(putRun).not.toHaveBeenCalled();
});

test('a fetch by breakdownId writes no row', async () => {
  const putRun = jest.fn();
  const result = await fetchStoredBreakdown({
    project: 'acme',
    breakdownId: 'bd-1',
    query: async () => [
      {
        project: 'acme',
        ticketId: 'bd-1#0',
        breakdownId: 'bd-1',
        kind: 'epic',
        ordinal: 0,
        body: '# Bill the new meter',
        createdAt,
        page,
      },
    ],
    putRun,
  });
  expect(result).toMatchObject({ status: 'success', breakdownId: 'bd-1' });
  expect(putRun).not.toHaveBeenCalled();
});

test('a model response with no output_tokens is an error and writes no row', async () => {
  const putRun = jest.fn();
  const { ready, put } = draft({
    putRun,
    complete: async () =>
      counted(JSON.stringify({ epic: '# Bill the new meter', stories: ['# Show the tariff'] }), false, {
        input_tokens: 12,
      }),
  });
  await expect(ready).resolves.toEqual({
    response: 'The breakdown model returned no token counts.',
    status: 'error',
  });
  expect(put).not.toHaveBeenCalled();
  expect(putRun).not.toHaveBeenCalled();
});

test('an unknown model id is an error and writes no row', async () => {
  const putRun = jest.fn();
  const { ready, put } = draft({
    putRun,
    complete: async () =>
      breakdownCompletionFromModel({
        text: JSON.stringify({ epic: '# Bill the new meter', stories: ['# Show the tariff'] }),
        cutOff: false,
        model: 'other',
        usage: { input_tokens: 1, output_tokens: 1 },
        startedAt: sonnetUsage.startedAt,
        finishedAt: sonnetUsage.finishedAt,
      }),
  });
  await expect(ready).resolves.toEqual({ response: 'An unknown model id.', status: 'error' });
  expect(put).not.toHaveBeenCalled();
  expect(putRun).not.toHaveBeenCalled();
});

test('a cut-off reply with both counts writes one run row and no breakdown rows', async () => {
  const rows: DraftBreakdownRun[] = [];
  const { ready, put } = draft({
    putRun: async (row) => {
      rows.push(row);
    },
    complete: async () => counted(JSON.stringify({ epic: '# Bill the new meter', stories: ['# Show the tariff'] }), true),
  });
  await expect(ready).resolves.toEqual({ response: 'The model reply was cut off.', status: 'error' });
  expect(put).not.toHaveBeenCalled();
  expect(rows).toEqual([
    expect.objectContaining({
      step: 'draft-breakdown',
      status: 'error',
      breakdownId: 'bd-1',
      inputTokens: 10,
      outputTokens: 20,
    }),
  ]);
});

test('a model refusal writes one run row with status refused', async () => {
  const rows: DraftBreakdownRun[] = [];
  const { ready } = draft({
    putRun: async (row) => {
      rows.push(row);
    },
    complete: async () => counted(JSON.stringify({ reasons: 'The page is a status report.' })),
  });
  await expect(ready).resolves.toMatchObject({ status: 'refused', breakdownId: 'bd-1' });
  expect(rows).toEqual([
    expect.objectContaining({ status: 'refused', step: 'draft-breakdown', breakdownId: 'bd-1' }),
  ]);
});
