import { answerFromMemory, parseInvokePayload } from '../lib/agent/answer.js';
import { promptForInvoke, readTicketMarkdown } from '../lib/ticket.js';
import { DRAFT_SYSTEM_PROMPT, draftWorkOrder, readWorkOrder } from '../lib/agent/draft.js';
import { RULE_PRECEDENCE } from '../lib/work-order.js';
import { checkReadiness } from '../lib/agent/readiness.js';
import { projectRetrieveFilter, projectRetrieveValues } from '../lib/project-filter.js';

test('a retrieve for a client includes global', () => {
  expect(projectRetrieveValues('acme')).toEqual(['acme', 'global']);
  expect(projectRetrieveFilter('acme')).toEqual({ in: { key: 'project', value: ['acme', 'global'] } });
});

test('a retrieve for global does not open other clients', () => {
  expect(projectRetrieveValues('global')).toEqual(['global']);
});

test('an empty project is invalid', () => {
  expect(() => projectRetrieveValues('  ')).toThrow(/project/);
});

test('invoke without a project is rejected', () => {
  expect(parseInvokePayload({ prompt: 'what is the export RFC' })).toEqual({
    response: 'Name a project. The agent will not search without one.',
    status: 'error',
  });
});

test('invoke without a prompt is rejected', () => {
  expect(parseInvokePayload({ project: 'acme' })).toMatchObject({ status: 'error' });
});

test('check-readiness is accepted as a skill', () => {
  expect(parseInvokePayload({ prompt: 'add CSV export', project: 'acme', skill: 'check-readiness' })).toEqual({
    prompt: 'add CSV export',
    project: 'acme',
    skill: 'check-readiness',
  });
});

test('draft-work-order is accepted as a skill', () => {
  expect(parseInvokePayload({ prompt: 'add CSV export', project: 'acme', skill: 'draft-work-order' })).toEqual({
    prompt: 'add CSV export',
    project: 'acme',
    skill: 'draft-work-order',
  });
});

test('markdown format is accepted on draft-work-order', () => {
  expect(
    parseInvokePayload({
      prompt: 'add CSV export',
      project: 'acme',
      skill: 'draft-work-order',
      format: 'markdown',
    }),
  ).toEqual({
    prompt: 'add CSV export',
    project: 'acme',
    skill: 'draft-work-order',
    format: 'markdown',
  });
});

test('format is rejected unless the skill is draft-work-order', () => {
  expect(parseInvokePayload({ prompt: 'add CSV export', project: 'acme', format: 'markdown' })).toEqual({
    response: 'format is only valid with skill draft-work-order.',
    status: 'error',
  });
  expect(parseInvokePayload({ prompt: 'add CSV export', project: 'acme', skill: 'draft-work-order', format: 'yaml' })).toEqual({
    response: 'format must be json or markdown when set.',
    status: 'error',
  });
});

test('a stored draft is fetched by id', () => {
  expect(
    parseInvokePayload({
      project: 'acme',
      draftId: 'draft-1',
      format: 'markdown',
    }),
  ).toEqual({
    project: 'acme',
    draftId: 'draft-1',
    format: 'markdown',
  });
});

test('a stored breakdown is fetched by id', () => {
  expect(parseInvokePayload({ project: 'acme', breakdownId: 'bd-1' })).toEqual({
    project: 'acme',
    breakdownId: 'bd-1',
  });
});

test('a breakdown fetch rejects a prompt, a skill, or a draft id', () => {
  expect(
    parseInvokePayload({
      project: 'acme',
      breakdownId: 'bd-1',
      prompt: 'split this page',
    }),
  ).toEqual({
    response: 'breakdownId fetches a stored breakdown. Omit prompt, skill, page, ticket, draftId, and format.',
    status: 'error',
  });
});

test('a fetch rejects a prompt or a skill', () => {
  expect(
    parseInvokePayload({
      prompt: 'add CSV export',
      project: 'acme',
      draftId: 'draft-1',
    }),
  ).toEqual({
    response: 'draftId fetches a stored draft. Omit prompt, skill, page, and ticket.',
    status: 'error',
  });
});

test('a ticket key is accepted with or without a prompt', () => {
  expect(parseInvokePayload({ project: 'acme', ticket: 'ACME-12', skill: 'draft-work-order' })).toEqual({
    project: 'acme',
    skill: 'draft-work-order',
    ticket: 'ACME-12',
  });
  expect(
    parseInvokePayload({
      prompt: 'match the loading state',
      project: 'acme',
      ticket: 'ACME-12',
      skill: 'draft-work-order',
    }),
  ).toEqual({
    prompt: 'match the loading state',
    project: 'acme',
    skill: 'draft-work-order',
    ticket: 'ACME-12',
  });
});

test('a ticket file fills the prompt when the caller did not send one', () => {
  const ticketText = '# ACME-12\n\nRepro path and Figma link.';
  expect(promptForInvoke(undefined, ticketText)).toBe(ticketText);
  expect(promptForInvoke('match the loading state', ticketText)).toBe('match the loading state');
});

test('a ticket key that is not a key is rejected', () => {
  expect(parseInvokePayload({ project: 'acme', ticket: 'acme/jira/ACME-12.md' })).toEqual({
    response: 'Name a ticket key.',
    status: 'error',
  });
});

test('a missing ticket object is an error', async () => {
  const read = jest.fn().mockResolvedValue(undefined);
  await expect(readTicketMarkdown({ bucket: 'docs', project: 'acme', ticket: 'ACME-12', read })).resolves.toEqual({
    response: 'No object at acme/jira/ACME-12.md.',
    status: 'error',
  });
  expect(read).toHaveBeenCalledWith('acme/jira/ACME-12.md');
});

test('a ticket read returns the whole markdown object', async () => {
  const result = await readTicketMarkdown({
    bucket: 'docs',
    project: 'acme',
    ticket: 'ACME-12',
    read: jest.fn().mockResolvedValue('# ACME-12\n\nRepro path and Figma link.'),
  });
  expect(result).toEqual({
    chunk: {
      text: '# ACME-12\n\nRepro path and Figma link.',
      uri: 's3://docs/acme/jira/ACME-12.md',
    },
  });
});

test('an unknown skill is rejected', () => {
  expect(parseInvokePayload({ prompt: 'add CSV export', project: 'acme', skill: 'draft' })).toEqual({
    response: 'skill must be check-readiness, draft-work-order, or draft-breakdown when set.',
    status: 'error',
  });
});

test('draft-breakdown reads one page in the project', () => {
  expect(
    parseInvokePayload({ project: 'acme', page: 'acme/notes/billing.md', skill: 'draft-breakdown' }),
  ).toEqual({
    project: 'acme',
    skill: 'draft-breakdown',
    page: 'acme/notes/billing.md',
  });
  expect(parseInvokePayload({ project: 'acme', skill: 'draft-breakdown' })).toEqual({
    response: 'Name a page.',
    status: 'error',
  });
  expect(parseInvokePayload({ project: 'acme', page: 'other/notes/billing.md', skill: 'draft-breakdown' })).toEqual({
    response: 'Name a page in this project.',
    status: 'error',
  });
  expect(parseInvokePayload({ project: 'acme', page: 'acme/../notes/billing.md', skill: 'draft-breakdown' })).toEqual({
    response: 'Name a page in this project.',
    status: 'error',
  });
  expect(parseInvokePayload({ project: 'acme', page: 'acme/notes/billing.txt', skill: 'draft-breakdown' })).toEqual({
    response: 'Name a page in this project.',
    status: 'error',
  });
  expect(
    parseInvokePayload({
      project: 'acme',
      page: 'acme/notes/billing.md',
      skill: 'draft-breakdown',
      prompt: 'split this',
    }),
  ).toEqual({
    response: 'draft-breakdown reads one page. Omit prompt, ticket, draftId, breakdownId, and format.',
    status: 'error',
  });
  expect(parseInvokePayload({ project: 'acme', page: 'acme/notes/billing.md', prompt: 'split this' })).toEqual({
    response: 'page is only valid with skill draft-breakdown.',
    status: 'error',
  });
});

test('answer uses retrieved decisions and documents for that project', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockResolvedValue([
    {
      project: 'acme',
      decisionId: 'abc',
      title: 'CSV only',
      content: 'v1 ships CSV.',
      quote: 'Excel is out of scope.',
      speaker: 'Marcus Webb',
      timestamp: '00:00:20.500',
      loggedAt: '2026-10-15T12:00:00.000Z',
      sourceKey: 'acme/transcripts/standup.vtt',
    },
  ]);
  const complete = jest.fn().mockResolvedValue('CSV only. Cite the later loggedAt.');
  const result = await answerFromMemory({
    prompt: 'the export RFC',
    project: 'acme',
    retrieve,
    searchDecisions,
    complete,
  });
  expect(retrieve).toHaveBeenCalledWith({ prompt: 'the export RFC', project: 'acme' });
  expect(searchDecisions).toHaveBeenCalledWith({ prompt: 'the export RFC', project: 'acme' });
  expect(complete).toHaveBeenCalledWith({
    prompt: 'the export RFC',
    project: 'acme',
    chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
    decisions: [
      {
        project: 'acme',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Marcus Webb',
        timestamp: '00:00:20.500',
        loggedAt: '2026-10-15T12:00:00.000Z',
        sourceKey: 'acme/transcripts/standup.vtt',
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
      prompt: 'the export RFC',
      project: 'acme',
      retrieve,
      searchDecisions,
      complete,
    });
    expect(complete).toHaveBeenCalledWith({
      prompt: 'the export RFC',
      project: 'acme',
      chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
      decisions: [],
    });
    expect(result).toEqual({ response: 'Use a single table.', status: 'success' });
  } finally {
    error.mockRestore();
  }
});

test('check-readiness loads repos, decisions, and documents', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockResolvedValue([]);
  const loadRepos = jest.fn().mockResolvedValue([
    {
      project: 'acme',
      repoId: 'acme/web',
      owner: 'acme',
      repo: 'web',
      url: 'https://github.com/acme/web',
      summary: 'Web app.',
    },
  ]);
  const complete = jest.fn().mockResolvedValue('Ready. Target acme/web. Cite small-diffs.');
  const result = await checkReadiness({
    prompt: 'add CSV export',
    project: 'acme',
    retrieve,
    searchDecisions,
    loadRepos,
    complete,
  });
  expect(loadRepos).toHaveBeenCalledWith('acme');
  expect(complete).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'add CSV export',
      project: 'acme',
      repos: [expect.objectContaining({ repoId: 'acme/web' })],
    }),
  );
  expect(complete.mock.calls[0][0]).not.toHaveProperty('rules');
  expect(result.status).toBe('success');
});

test('check-readiness stops when the repo map is empty', async () => {
  const complete = jest.fn();
  const result = await checkReadiness({
    prompt: 'add CSV export',
    project: 'acme',
    retrieve: jest.fn().mockResolvedValue([]),
    searchDecisions: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([]),
    complete,
  });
  expect(complete).not.toHaveBeenCalled();
  expect(result).toEqual({ response: 'The repo map is empty.', status: 'refused' });
});

test('check-readiness stops when the repo map fails to load', async () => {
  const complete = jest.fn();
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await checkReadiness({
      prompt: 'add CSV export',
      project: 'acme',
      retrieve: jest.fn().mockResolvedValue([]),
      searchDecisions: jest.fn().mockResolvedValue([]),
      loadRepos: jest.fn().mockRejectedValue(new Error('query failed')),
      complete,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result).toEqual({ response: 'The repo map failed to load.', status: 'refused' });
  } finally {
    error.mockRestore();
  }
});

const webRepo = {
  project: 'acme',
  repoId: 'acme/web',
  owner: 'acme',
  repo: 'web',
  url: 'https://github.com/acme/web',
  summary: 'Web app.',
};

const validDraftJson = JSON.stringify({
  intent: 'Add CSV export',
  summary: 'Add CSV export in acme/web.',
  repos: [{ owner: 'acme', repo: 'web' }],
  constraints: ['Match existing patterns in acme/web.'],
  acceptance: ['Query path covered by a test.'],
  citations: { decisionIds: ['abc'], documentUris: ['s3://doc/rfc.md'] },
});

test('draft-work-order stores a work order that names a mapped repo', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'add CSV export',
    project: 'acme',
    retrieve: jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]),
    searchDecisions: jest.fn().mockResolvedValue([
      {
        project: 'acme',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Marcus Webb',
        timestamp: '00:00:20.500',
        loggedAt: '2026-10-15T12:00:00.000Z',
        sourceKey: 'acme/transcripts/standup.vtt',
      },
    ]),
    loadRules: jest.fn().mockResolvedValue([
      {
        project: 'global',
        ruleId: 'function-comment',
        title: 'Comment every function',
        body: 'Always start a function with a comment.',
      },
    ]),
    loadRepos: jest.fn().mockResolvedValue([webRepo]),
    complete: jest.fn().mockResolvedValue(validDraftJson),
    put,
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
  });
  expect(put).toHaveBeenCalledWith({
    project: 'acme',
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
    workOrder: {
      intent: 'Add CSV export',
      summary: 'Add CSV export in acme/web.',
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: ['Match existing patterns in acme/web.'],
      acceptance: ['Query path covered by a test.'],
      rules: [
        {
          project: 'global',
          ruleId: 'function-comment',
          title: 'Comment every function',
          body: 'Always start a function with a comment.',
        },
      ],
      rulePrecedence: RULE_PRECEDENCE,
      project: 'acme',
    },
    citations: { decisionIds: ['abc'], documentUris: ['s3://doc/rfc.md'] },
  });
  expect(result.status).toBe('success');
  expect(JSON.parse(result.response).draftId).toBe('draft-1');
});

test('draft-work-order can return the stored draft as markdown', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'add CSV export',
    project: 'acme',
    retrieve: jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]),
    searchDecisions: jest.fn().mockResolvedValue([
      {
        project: 'acme',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Marcus Webb',
        timestamp: '00:00:20.500',
        loggedAt: '2026-10-15T12:00:00.000Z',
        sourceKey: 'acme/transcripts/standup.vtt',
      },
    ]),
    loadRules: jest.fn().mockResolvedValue([
      {
        project: 'global',
        ruleId: 'function-comment',
        title: 'Comment every function',
        body: 'Always start a function with a comment.',
      },
    ]),
    loadRepos: jest.fn().mockResolvedValue([webRepo]),
    complete: jest.fn().mockResolvedValue(validDraftJson),
    put,
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
    format: 'markdown',
  });
  expect(put).toHaveBeenCalledWith(
    expect.objectContaining({
      project: 'acme',
      draftId: 'draft-1',
      workOrder: expect.objectContaining({ intent: 'Add CSV export', rulePrecedence: RULE_PRECEDENCE }),
    }),
  );
  expect(result.status).toBe('success');
  expect(result.response).toContain('## Intent');
  expect(result.response).toContain('Add CSV export');
  expect(result.response).toContain(RULE_PRECEDENCE);
  expect(result.response).toContain('quote: Excel is out of scope.');
  expect(result.response).toContain('loggedAt: 2026-10-15T12:00:00.000Z');
  expect(result.response).toContain('speaker: Marcus Webb');
  expect(result.response).not.toContain('"draftId"');
  expect(JSON.stringify(put.mock.calls[0][0])).not.toContain('## Intent');
});

test('the draft prompt keeps source facts and leaves rules out of the draft', () => {
  expect(DRAFT_SYSTEM_PROMPT).toContain('Do not copy or restate a loaded rule in the summary or the constraints, including a paraphrase.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('An acceptance line copied from the source stays even when it shares words with a rule.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A consequence of a loaded rule goes in consequences');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Copy a file name the source shows as an existing file.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('When the source asks the change to write a record into a file that is not in the repo paths, name the module README, or the pull request body when no module is named.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('ifFalse is stop when that claim is the point of the work, and omit when the rest can proceed without it.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('human-verified, not agent-verified');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A test that runs in the checkout stays unmarked.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Copy repro steps, links, and named files from the source into the summary.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Do not invent how the change is made.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('If it names none, infer the target from the repo map.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A ticket with more than one step is one work order.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Keep an exclusion that limits the first step, and also keep the later step that changes that same path.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Work that does not block the first step stays in the order when it is in scope or in acceptance.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Copy every acceptance line from the source into acceptance.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Copy a risk that sets the order of the work into the summary.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('If two parts of the scope name different repos, name both as targets.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('When part of the scope names no repo, infer that part from the repo map and include it when it is a different target.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A path the source already names is not a premise.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('When the source does not choose which path, add a premise that names the step which uses it, with ifFalse stop.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A file premise stops only that step. Other steps do not wait.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Do not name a workspace, monorepo, or package file the source does not name.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Acceptance is only the lines copied from the source.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('intent names every step in one line, including a later step and work that runs in parallel.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Do not hedge a path.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A folder the source names in words is not a slash path.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('The premise quotes those words and stops only that step.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('The summary tells the agent to find that folder and match what is already there.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A slash path for that folder is allowed only when the source or that repo\'s summary already contains it.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('A file the source names can be written as a path.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('When a step removes a secret or input from a workflow, the summary says every caller file the source already names drops that same secret or input.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('That line is required. It is not an invented mechanism.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('When the source names no caller file, the summary tells the agent to search the named repo for callers.');
  expect(DRAFT_SYSTEM_PROMPT).toContain('Do not invent a caller filename.');
});

const storedDraft = {
  project: 'acme',
  draftId: 'draft-1',
  createdAt: '2026-10-16T07:22:19.216Z',
  workOrder: {
    intent: 'Add CSV export',
    summary: 'Add CSV export in acme/web.',
    repos: [{ owner: 'acme', repo: 'web' }],
    constraints: ['Match existing patterns in acme/web.'],
    acceptance: ['Query path covered by a test.'],
    rules: [],
    rulePrecedence: RULE_PRECEDENCE,
    project: 'acme',
  },
  citations: { decisionIds: ['abc'], documentUris: ['s3://doc/rfc.md'] },
};

test('read by id returns the stored json and writes nothing', async () => {
  const get = jest.fn().mockResolvedValue(storedDraft);
  const loadDecisions = jest.fn();
  const result = await readWorkOrder({
    project: 'acme',
    draftId: storedDraft.draftId,
    get,
    loadDecisions,
  });
  expect(get).toHaveBeenCalledWith({ project: 'acme', draftId: storedDraft.draftId });
  expect(loadDecisions).not.toHaveBeenCalled();
  expect(JSON.parse(result.response).draftId).toBe(storedDraft.draftId);
  expect(result.status).toBe('success');
});

test('read by id can return markdown for that row', async () => {
  const result = await readWorkOrder({
    project: 'acme',
    draftId: storedDraft.draftId,
    format: 'markdown',
    get: jest.fn().mockResolvedValue(storedDraft),
    loadDecisions: jest.fn().mockResolvedValue([
      {
        project: 'acme',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Alex',
        timestamp: '00:01:00.000',
        loggedAt: '2026-10-16T07:00:00.000Z',
        sourceKey: 'acme/transcripts/review.vtt',
      },
    ]),
  });
  expect(result.status).toBe('success');
  expect(result.response).toContain('Draft: draft-1');
  expect(result.response).toContain('quote: Excel is out of scope.');
  expect(result.response).not.toContain('"workOrder"');
});

test('read by id keeps consequences and premises', async () => {
  const result = await readWorkOrder({
    project: 'acme',
    draftId: storedDraft.draftId,
    format: 'markdown',
    get: jest.fn().mockResolvedValue({
      ...storedDraft,
      workOrder: {
        ...storedDraft.workOrder,
        consequences: ['No comment mentions New Relic, history, or a ticket.'],
        premises: [{ claim: 'Eight monitors expose both thresholds', ifFalse: 'stop' }],
      },
    }),
    loadDecisions: jest.fn().mockResolvedValue([]),
  });
  expect(result.status).toBe('success');
  expect(result.response).toContain('In the files this change writes:');
  expect(result.response).toContain('- Eight monitors expose both thresholds. If this is false, stop and ask.');
});

test('read by id treats an unrecognized premise outcome as stop and ask', async () => {
  const result = await readWorkOrder({
    project: 'acme',
    draftId: storedDraft.draftId,
    format: 'markdown',
    get: jest.fn().mockResolvedValue({
      ...storedDraft,
      workOrder: {
        ...storedDraft.workOrder,
        premises: [{ claim: 'Eight monitors expose both thresholds', ifFalse: 'ask' }],
      },
    }),
    loadDecisions: jest.fn().mockResolvedValue([]),
  });
  expect(result.status).toBe('success');
  expect(result.response).toContain('- Eight monitors expose both thresholds. If this is false, stop and ask.');
});

test('read by id misses a draft that is not stored', async () => {
  const result = await readWorkOrder({
    project: 'acme',
    draftId: 'missing',
    get: jest.fn().mockResolvedValue(undefined),
    loadDecisions: jest.fn(),
  });
  expect(result).toEqual({ response: 'No draft with that id.', status: 'error' });
});

test('a ticket file is the document and the knowledge base is not retrieved', async () => {
  const retrieve = jest.fn();
  const searchDecisions = jest.fn().mockResolvedValue([]);
  const put = jest.fn().mockResolvedValue(undefined);
  const ticketDocument = {
    text: '# ACME-12\n\nRepro path and Figma link.',
    uri: 's3://docs/acme/jira/ACME-12.md',
  };
  const result = await draftWorkOrder({
    prompt: ticketDocument.text,
    project: 'acme',
    ticketDocument,
    retrieve,
    searchDecisions,
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([webRepo]),
    complete: jest.fn().mockResolvedValue(validDraftJson),
    put,
    draftId: 'draft-ticket',
    createdAt: '2026-10-15T21:00:00.000Z',
  });
  expect(retrieve).not.toHaveBeenCalled();
  expect(searchDecisions).toHaveBeenCalledWith({ prompt: ticketDocument.text, project: 'acme' });
  expect(put).toHaveBeenCalled();
  expect(result.status).toBe('success');
});

test('draft-work-order does not store when rules fail to load', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const complete = jest.fn();
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await draftWorkOrder({
      prompt: 'add CSV export',
      project: 'acme',
      retrieve: jest.fn().mockResolvedValue([]),
      searchDecisions: jest.fn().mockResolvedValue([]),
      loadRules: jest.fn().mockRejectedValue(new Error('query failed')),
      loadRepos: jest.fn().mockResolvedValue([webRepo]),
      complete,
      put,
      draftId: 'draft-rules',
      createdAt: '2026-10-15T21:00:00.000Z',
    });
    expect(complete).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(result).toEqual({ response: 'Rules failed to load.', status: 'success' });
  } finally {
    error.mockRestore();
  }
});

test('draft-work-order does not store a repo that is not in the map', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'add CSV export',
    project: 'acme',
    retrieve: jest.fn().mockResolvedValue([]),
    searchDecisions: jest.fn().mockResolvedValue([]),
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([webRepo]),
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

test('draft-work-order stops when the repo map is empty', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const complete = jest.fn();
  const result = await draftWorkOrder({
    prompt: 'add CSV export',
    project: 'acme',
    retrieve: jest.fn().mockResolvedValue([]),
    searchDecisions: jest.fn().mockResolvedValue([]),
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([]),
    complete,
    put,
    draftId: 'draft-empty-map',
    createdAt: '2026-10-15T21:00:00.000Z',
  });
  expect(complete).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(result).toEqual({ response: 'The repo map is empty.', status: 'refused' });
});

test('draft-work-order stops when the repo map fails to load', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const complete = jest.fn();
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await draftWorkOrder({
      prompt: 'add CSV export',
      project: 'acme',
      retrieve: jest.fn().mockResolvedValue([]),
      searchDecisions: jest.fn().mockResolvedValue([]),
      loadRules: jest.fn().mockResolvedValue([]),
      loadRepos: jest.fn().mockRejectedValue(new Error('query failed')),
      complete,
      put,
      draftId: 'draft-map-failed',
      createdAt: '2026-10-15T21:00:00.000Z',
    });
    expect(complete).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(result).toEqual({ response: 'The repo map failed to load.', status: 'refused' });
  } finally {
    error.mockRestore();
  }
});

test('draft-work-order does not store when the model is blocked', async () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const result = await draftWorkOrder({
    prompt: 'add CSV export',
    project: 'demo',
    retrieve: jest.fn().mockResolvedValue([]),
    searchDecisions: jest.fn().mockResolvedValue([]),
    loadRules: jest.fn().mockResolvedValue([]),
    loadRepos: jest.fn().mockResolvedValue([webRepo]),
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

