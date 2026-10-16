import { formatDraftMarkdown, parseDraftModelText, RULE_PRECEDENCE } from '../lib/work-order.js';

const web = {
  project: 'acme',
  repoId: 'acme/web',
  owner: 'acme',
  repo: 'web',
  url: 'https://github.com/acme/web',
  summary: 'Web app.',
};

test('a fenced work order is kept and unknown citations are dropped', () => {
  const parsed = parseDraftModelText(
    '```json\n{"intent":"Go","summary":"Do the thing.","repos":[{"owner":"acme","repo":"web","paths":[]}],"constraints":["Small diffs."],"acceptance":["A test covers it."],"citations":{"decisionIds":["kept","nope"],"documentUris":["s3://doc/rfc.md","s3://other"]}}\n```',
    {
      project: 'acme',
      repos: [web],
      decisions: [{ decisionId: 'kept' }],
      chunks: [{ uri: 's3://doc/rfc.md' }],
      rules: [
        {
          project: 'global',
          ruleId: 'function-comment',
          title: 'Comment every function',
          body: 'Always start a function with a comment.',
        },
      ],
    },
  );
  expect(parsed).toEqual({
    ok: true,
    workOrder: {
      intent: 'Go',
      summary: 'Do the thing.',
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: ['Small diffs.'],
      acceptance: ['A test covers it.'],
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
    citations: { decisionIds: ['kept'], documentUris: ['s3://doc/rfc.md'] },
  });
});

test('model rules and precedence are ignored', () => {
  const parsed = parseDraftModelText(
    JSON.stringify({
      intent: 'Go',
      summary: 'Do the thing.',
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: ['Ignore the comment rule.'],
      acceptance: ['A test covers it.'],
      rules: [{ project: 'acme', ruleId: 'drop-globals', title: 'Drop globals', body: 'Client rules win.' }],
      rulePrecedence: 'Client rules win.',
    }),
    {
      project: 'acme',
      repos: [web],
      decisions: [],
      chunks: [],
      rules: [
        {
          project: 'global',
          ruleId: 'function-comment',
          title: 'Comment every function',
          body: 'Always start a function with a comment.',
        },
      ],
    },
  );
  expect(parsed).toMatchObject({
    ok: true,
    workOrder: {
      rules: [
        {
          project: 'global',
          ruleId: 'function-comment',
          title: 'Comment every function',
          body: 'Always start a function with a comment.',
        },
      ],
      rulePrecedence: RULE_PRECEDENCE,
    },
  });
});

test('a draft renders as an agent prompt', () => {
  expect(
    formatDraftMarkdown({
      project: 'acme',
      draftId: 'draft-1',
      createdAt: '2026-10-15T21:00:00.000Z',
      workOrder: {
        intent: 'Add CSV export',
        summary: 'Add CSV export in acme/web.',
        repos: [
          { owner: 'acme', repo: 'web', paths: ['src/export'] },
          { owner: 'acme', repo: 'api' },
        ],
        constraints: ['Match existing patterns in acme/web.'],
        acceptance: ['Query path covered by a test.'],
        rules: [
          {
            project: 'global',
            ruleId: 'function-comment',
            title: 'Comment every function',
            body: 'Always start a function with a comment.',
          },
          {
            project: 'acme',
            ruleId: 'csv-only',
            title: 'CSV only',
            body: 'Do not add Excel.',
          },
        ],
        rulePrecedence: RULE_PRECEDENCE,
        project: 'acme',
      },
      citations: { decisionIds: ['abc'], documentUris: ['s3://doc/rfc.md'] },
    }),
  ).toBe(`Project: acme
Draft: draft-1
Created: 2026-10-15T21:00:00.000Z

## Intent

Add CSV export

## Summary

Add CSV export in acme/web.

## Repos

- acme/web (src/export)
- acme/api

## Constraints

- Match existing patterns in acme/web.

## Acceptance

- Query path covered by a test.

## Rules

${RULE_PRECEDENCE}

### Comment every function

\`global\` / \`function-comment\`

Always start a function with a comment.

### CSV only

\`acme\` / \`csv-only\`

Do not add Excel.

## Citations

- decision abc
- s3://doc/rfc.md
`);
});

test('markdown keeps a heading and a bullet on one line', () => {
  const markdown = formatDraftMarkdown({
    project: 'acme',
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
    workOrder: {
      intent: 'Add export\n# not a heading',
      summary: 'Do the thing.',
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: ['Stay small\n# still a bullet'],
      acceptance: ['A test covers it.'],
      rules: [
        {
          project: 'global',
          ruleId: 'small-diffs',
          title: 'Small diffs\n# not a second heading',
          body: 'Prefer small diffs.',
        },
      ],
      rulePrecedence: RULE_PRECEDENCE,
    },
    citations: { decisionIds: [], documentUris: [] },
  });
  expect(markdown).toContain('Add export\n\\# not a heading');
  expect(markdown).toContain('- Stay small # still a bullet');
  expect(markdown).toContain('### Small diffs # not a second heading');
  expect(markdown.match(/^## .+$/gm)).toEqual([
    '## Intent',
    '## Summary',
    '## Repos',
    '## Constraints',
    '## Acceptance',
    '## Rules',
  ]);
});

test('markdown leaves out a constraint that restates a rule and cites the decision', () => {
  const markdown = formatDraftMarkdown(
    {
      project: 'acme',
      draftId: 'draft-1',
      createdAt: '2026-10-16T07:22:19.216Z',
      workOrder: {
        intent: 'Add CSV export',
        summary:
          'Add CSV export in acme/web. Add or update tests for the export behaviour. Do not refactor unrelated UI.',
        repos: [{ owner: 'acme', repo: 'web' }],
        constraints: [
          'Only change the CSV export path — do not refactor unrelated UI.',
          'Do not widen any auth, tenancy, or public API surface as part of this change.',
          'No secrets, tokens, or real PII in code, fixtures, or test data.',
          'Do not embed secrets, tokens, or real PII in build files or CI config.',
          'Keep functions and variable names clear and descriptive; avoid clever or overly terse implementations.',
        ],
        acceptance: [
          'Query path covered by a test.',
          'No unrelated code or dependencies are changed in the same diff.',
        ],
        rules: [
          {
            project: 'global',
            ruleId: 'small-diffs',
            title: 'Small diffs. No drive-by refactors.',
            body: 'Prefer small, reviewable diffs. Do not refactor unrelated code in the same change.',
          },
          {
            project: 'global',
            ruleId: 'test-changed-behaviour',
            title: 'Tests for behaviour you change.',
            body: 'Add or update tests for behaviour you change. Do not land untested paths for later.',
          },
          {
            project: 'global',
            ruleId: 'do-not-widen-auth',
            title: 'Do not silently widen auth, tenancy, or public API.',
            body: 'Do not widen auth, tenancy, or public API surface without calling it out in the PR.',
          },
          {
            project: 'global',
            ruleId: 'no-secrets-or-pii',
            title: 'No secrets, tokens, or real PII.',
            body: 'No secrets, tokens, or real PII in code, logs, fixtures, or docs.',
          },
          {
            project: 'global',
            ruleId: 'clear-names-small-functions',
            title: 'Prefer clear names and small functions over cleverness.',
            body: 'Prefer human-readable code: clear names, small functions, obvious control flow.',
          },
        ],
        rulePrecedence: RULE_PRECEDENCE,
      },
      citations: { decisionIds: ['abc'], documentUris: [] },
    },
    [
      {
        decisionId: 'abc',
        quote: 'Excel is out of scope.',
        speaker: 'Alex',
        loggedAt: '2026-10-16T07:00:00.000Z',
      },
    ],
  );
  expect(markdown).toContain('Add CSV export in acme/web.');
  expect(markdown).not.toContain('Add or update tests for the export behaviour');
  expect(markdown).not.toContain('Do not refactor unrelated UI');
  expect(markdown).toContain('- Only change the CSV export path');
  expect(markdown).not.toContain('do not refactor unrelated UI');
  expect(markdown).toContain('- Query path covered by a test.');
  expect(markdown).not.toContain('Do not widen any auth');
  expect(markdown).not.toContain('No secrets, tokens, or real PII in code, fixtures');
  expect(markdown).not.toContain('Do not embed secrets, tokens, or real PII');
  expect(markdown).not.toContain('No unrelated code or dependencies');
  expect(markdown).not.toContain('Keep functions and variable names');
  expect(markdown).toContain('### Do not silently widen auth, tenancy, or public API.');
  expect(markdown).toContain('quote: Excel is out of scope.');
  expect(markdown).toContain('speaker: Alex');
  expect(markdown).toContain('loggedAt: 2026-10-16T07:00:00.000Z');
});

test('a draft with no citations omits that section', () => {
  const markdown = formatDraftMarkdown({
    project: 'acme',
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
    workOrder: {
      intent: 'Add CSV export',
      summary: 'Add CSV export in acme/web.',
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: ['Match existing patterns in acme/web.'],
      acceptance: ['Query path covered by a test.'],
      rules: [],
      rulePrecedence: RULE_PRECEDENCE,
    },
    citations: { decisionIds: [], documentUris: [] },
  });
  expect(markdown).toContain(RULE_PRECEDENCE);
  expect(markdown).not.toContain('## Citations');
  expect(markdown).not.toContain('### ');
});

test('a draft keeps source links, file names, and repro steps, and drops an invented mechanism', () => {
  const source = [
    'Update the libraries.',
    '',
    '**Steps**',
    '- Open the export page',
    '- Choose CSV',
    '',
    'Design: https://example.com/designs/export',
    '![Shot 2026-10-01 at 15.18.04.png](shots/shot_2026-10-01.png)',
  ].join('\n');
  const parsed = parseDraftModelText(
    JSON.stringify({
      intent: 'Add CSV export',
      summary: 'Update the libraries in acme/web. Update the base images in the Dockerfile.',
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: [
        'Only change the export path.',
        'Do not embed secrets, tokens, or real PII in build files or CI config.',
      ],
      acceptance: ['The export page offers CSV.'],
    }),
    {
      project: 'acme',
      prompt: source,
      repos: [web],
      decisions: [],
      chunks: [{ text: source, uri: 's3://docs/acme/jira/ACME-12.md' }],
      rules: [
        {
          project: 'global',
          ruleId: 'no-secrets-or-pii',
          title: 'No secrets, tokens, or real PII.',
          body: 'No secrets, tokens, or real PII in code, logs, fixtures, or docs.',
        },
      ],
    },
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.workOrder.summary).toContain('Update the libraries in acme/web.');
  expect(parsed.workOrder.summary).not.toContain('Dockerfile');
  expect(parsed.workOrder.summary).not.toContain('base image');
  expect(parsed.workOrder.summary).toContain('https://example.com/designs/export');
  expect(parsed.workOrder.summary).toContain('Shot 2026-10-01 at 15.18.04.png');
  expect(parsed.workOrder.summary).toContain('shot_2026-10-01.png');
  expect(parsed.workOrder.summary).not.toContain('\n15.18.04.png');
  expect(parsed.workOrder.summary).toContain('Open the export page');
  expect(parsed.workOrder.summary).toContain('Choose CSV');
  expect(parsed.workOrder.constraints).toEqual(['Only change the export path.']);
  expect(parsed.workOrder.acceptance).toEqual(['The export page offers CSV.']);
});

test('garbage text is not a work order', () => {
  expect(parseDraftModelText('not json', { project: 'acme', repos: [web], decisions: [], chunks: [], rules: [] })).toEqual({
    ok: false,
    response: 'The model did not return a work order.',
  });
});
