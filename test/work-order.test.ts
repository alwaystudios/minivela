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

${RULE_PRECEDENCE}

In the files this change writes:

- Comment every function
- CSV only

## Constraints

- Match existing patterns in acme/web.

## Acceptance

- Query path covered by a test.

## Global rules

${RULE_PRECEDENCE}

### Comment every function

Always start a function with a comment.

## acme rules

### CSV only

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
  expect(markdown).not.toContain('small-diffs');
  expect(markdown.match(/^## .+$/gm)).toEqual([
    '## Intent',
    '## Summary',
    '## Repos',
    '## Constraints',
    '## Acceptance',
    '## Global rules',
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
  expect(markdown).toContain('- No unrelated code or dependencies are changed in the same diff.');
  expect(markdown).not.toContain('Keep functions and variable names');
  expect(markdown).toContain('### Do not silently widen auth, tenancy, or public API.');
  expect(markdown).toContain('quote: Excel is out of scope.');
  expect(markdown).toContain('speaker: Alex');
  expect(markdown).toContain('loggedAt: 2026-10-16T07:00:00.000Z');
});

test('a rule consequence stays next to the files and a premise says what a miss means', () => {
  const consequence = 'No comment mentions New Relic, history, or a ticket.';
  const parsed = parseDraftModelText(
    JSON.stringify({
      intent: 'Add CSV export',
      summary: 'Add CSV export in acme/web. Do not mention a ticket, New Relic, or history in a comment.',
      repos: [{ owner: 'acme', repo: 'web', paths: ['src/export'] }],
      constraints: ['Only change the export path.', 'Do not mention a ticket, New Relic, or history in a comment.'],
      acceptance: ['Query path covered by a test.', 'The export page offers CSV. human-verified, not agent-verified'],
      consequences: [consequence],
      premises: [
        { claim: 'Eight monitors expose both thresholds', ifFalse: 'stop' },
        { claim: 'A pool metric exists.', ifFalse: 'omit' },
        { claim: 'Skipped', ifFalse: 'ask' },
        { claim: 'Logs are in Datadog' },
      ],
    }),
    {
      project: 'acme',
      prompt: 'Add CSV export in acme/web.',
      repos: [web],
      decisions: [],
      chunks: [],
      rules: [
        {
          project: 'global',
          ruleId: 'comment-contents',
          title: 'Comments stay free of tickets and vendors',
          body: 'Do not mention a ticket, New Relic, or history in a comment.',
        },
        {
          project: 'global',
          ruleId: 'csv-only',
          title: 'CSV only',
          body: 'Do not add Excel.',
        },
      ],
    },
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.workOrder.summary).toBe('Add CSV export in acme/web.');
  expect(parsed.workOrder.constraints).toEqual(['Only change the export path.']);
  expect(parsed.workOrder.consequences).toEqual([consequence]);
  expect(parsed.workOrder.acceptance).toEqual([
    'Query path covered by a test.',
    'The export page offers CSV. human-verified, not agent-verified',
  ]);
  expect(parsed.workOrder.premises).toEqual([
    { claim: 'Eight monitors expose both thresholds', ifFalse: 'stop' },
    { claim: 'A pool metric exists.', ifFalse: 'omit' },
    { claim: 'Skipped', ifFalse: 'stop' },
    { claim: 'Logs are in Datadog', ifFalse: 'stop' },
  ]);
  const markdown = formatDraftMarkdown({
    project: 'acme',
    draftId: 'draft-1',
    createdAt: '2026-10-15T21:00:00.000Z',
    workOrder: parsed.workOrder,
    citations: { decisionIds: [], documentUris: [] },
  });
  expect(markdown).toContain('In the files this change writes:');
  expect(markdown).toContain(`- ${consequence}`);
  expect(markdown.match(/No comment mentions New Relic, history, or a ticket\./g)).toHaveLength(2);
  expect(markdown.match(/Do not mention a ticket, New Relic, or history in a comment\./g)).toHaveLength(1);
  expect(markdown).not.toContain('- Do not mention a ticket, New Relic, or history in a comment.');
  expect(markdown).toContain('## Verify before building');
  expect(markdown).toContain('- Eight monitors expose both thresholds. If this is false, stop and ask.');
  expect(markdown).toContain('- A pool metric exists. If this is false, omit it and say so in the pull request.');
  expect(markdown).toContain('- Skipped. If this is false, stop and ask.');
  expect(markdown).toContain('- Logs are in Datadog. If this is false, stop and ask.');
  expect(markdown).not.toContain('- Comments stay free of tickets and vendors');
  expect(markdown).toContain('- CSV only');
  expect(markdown).toContain('- Query path covered by a test.');
  expect(markdown).toContain('- The export page offers CSV. human-verified, not agent-verified');
  expect(markdown).not.toMatch(/Query path covered by a test\..*human-verified/);
  expect(markdown.match(/^## .+$/gm)).toEqual([
    '## Intent',
    '## Summary',
    '## Repos',
    '## Verify before building',
    '## Constraints',
    '## Acceptance',
    '## Global rules',
  ]);
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
  expect(markdown).toContain('## Global rules');
  expect(markdown).toContain(RULE_PRECEDENCE);
  expect(markdown).not.toContain('## acme rules');
  expect(markdown).not.toContain('## Citations');
  expect(markdown).not.toContain('### ');
});

test('a draft keeps source links, file names, and repro steps', () => {
  const source = [
    'Update the libraries.',
    '',
    '**Steps**',
    '- Open the export page',
    '- Choose CSV',
    '',
    'Design: https://example.com/designs/export',
    '[https://example.com/findings?filters=["CSV"]](https://example.com/findings?filters=%5B%22CSV%22%5D)',
    '![Shot 2026-10-01 at 15.18.04.png](shots/shot_2026-10-01.png)',
  ].join('\n');
  const parsed = parseDraftModelText(
    JSON.stringify({
      intent: 'Add CSV export',
      summary: 'Update the libraries in acme/web.',
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
      decisions: [
        {
          decisionId: 'other',
          title: 'Elsewhere',
          content: 'https://example.com/decision',
          quote: 'Leave this decision out.',
        },
      ],
      chunks: [
        {
          text: ['**Steps**', '- Ignore this handbook step', '', 'https://example.com/handbook'].join('\n'),
          uri: 's3://docs/global/handbook.md',
        },
      ],
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
  expect(parsed.workOrder.summary).toContain('https://example.com/designs/export');
  expect(parsed.workOrder.summary).toContain('https://example.com/findings?filters=%5B%22CSV%22%5D');
  expect(parsed.workOrder.summary).not.toContain('filters=["CSV"');
  expect(parsed.workOrder.summary).not.toContain('https://example.com/handbook');
  expect(parsed.workOrder.summary).not.toContain('https://example.com/decision');
  expect(parsed.workOrder.summary).not.toContain('Ignore this handbook step');
  expect(parsed.workOrder.summary).toContain('Shot 2026-10-01 at 15.18.04.png');
  expect(parsed.workOrder.summary).toContain('shot_2026-10-01.png');
  expect(parsed.workOrder.summary).not.toContain('\n15.18.04.png');
  expect(parsed.workOrder.summary).toContain('Open the export page');
  expect(parsed.workOrder.summary).toContain('Choose CSV');
  expect(parsed.workOrder.constraints).toEqual(['Only change the export path.']);
  expect(parsed.workOrder.acceptance).toEqual(['The export page offers CSV.']);
});

test('a draft drops an unnamed mechanism and keeps one the source named', () => {
  const invented = draftOf({
    summary: 'Update the libraries in the export page in the container images or package manifests for the export service.',
    prompt: ['Update the libraries for the export service.', 'Open the export page.'].join('\n'),
    constraints: [
      'Scope is limited to the export libraries (and any other vulnerable libraries discovered in the same images); do not make unrelated changes.',
    ],
    rules: [smallDiffs],
  });
  expect(invented.summary).toContain('in the export page');
  expect(invented.summary).toContain('for the export service');
  expect(invented.summary).not.toContain('container');
  expect(invented.summary).not.toContain('package');
  expect(invented.summary).not.toContain('manifest');
  expect(invented.constraints).toEqual(['Scope is limited to the export libraries (and any other vulnerable libraries)']);

  const named = draftOf({
    summary: 'Update the libraries in the package manifests.',
    prompt: 'Update the libraries in the package manifests.',
  });
  expect(named.summary).toContain('in the package manifests');
});

test('an invented mechanism drops wherever it sits, and a source word does not save it', () => {
  const before = draftOf({
    summary: 'Update the libraries in the container images before the next release.',
    prompt: 'Update the libraries before the next release.',
  });
  expect(before.summary).toBe('Update the libraries before the next release.');

  const services = draftOf({
    summary: 'Update the libraries in the container images for all three services.',
    prompt: 'Update the libraries for the services.',
  });
  expect(services.summary).toBe('Update the libraries for all three services.');

  const leading = draftOf({
    summary: 'In the container images, update the libraries.',
    prompt: 'Update the libraries.',
  });
  expect(leading.summary).toBe('update the libraries.');

  const bare = draftOf({
    summary: 'Update the container images or package manifests.',
    prompt: 'Update the libraries.',
  });
  expect(bare.summary).toBe('Update.');

  const mixed = draftOf({
    summary: 'Update the libraries in the export page or the package manifests.',
    prompt: 'Update the libraries. Open the export page.',
  });
  expect(mixed.summary).toBe('Update the libraries in the export page.');

  const decided = draftOf({
    summary: 'Update the libraries in the container images.',
    prompt: 'Update the libraries.',
    decisions: [{ decisionId: 'poster', content: 'The poster image is fine.', quote: 'Leave the poster.' }],
  });
  expect(decided.summary).toBe('Update the libraries.');

  const single = draftOf({
    summary: 'Update the libraries and the dependency.',
    prompt: 'Update the libraries.',
  });
  expect(single.summary).toContain('dependency');
});

test('a short rule paraphrase drops and a job line stays', () => {
  const drafted = draftOf({
    summary: 'Update the libraries.',
    prompt: 'Update the libraries on the export path.',
    constraints: [
      'Scope is limited to the export path; do not make unrelated changes.',
      'Keep the code clear.',
      'Ship the code change.',
    ],
    rules: [smallDiffs, clearNames],
  });
  expect(drafted.constraints).toEqual([
    'Scope is limited to the export path',
    'Keep the code clear.',
    'Ship the code change.',
  ]);
});

test('an acceptance line from the source stays even when it shares a rule’s words', () => {
  const fromSource = 'Do not refactor unrelated code in the same change.';
  const invented = 'Prefer small reviewable diffs with no drive-by refactors.';
  const kept = draftOf({
    summary: 'Update the libraries.',
    prompt: `Update the libraries. ${fromSource}`,
    acceptance: [fromSource, invented],
    rules: [smallDiffs],
  });
  expect(kept.acceptance).toContain(fromSource);
  expect(kept.acceptance).not.toContain(invented);
});

test('a mixed acceptance line keeps the job clause and drops the rule clause', () => {
  const kept = draftOf({
    summary: 'Update the libraries.',
    prompt: 'Update the libraries. The export page offers CSV.',
    acceptance: [
      'The export page offers CSV — Prefer small, reviewable diffs. Do not refactor unrelated code in the same change.',
    ],
    rules: [smallDiffs],
  });
  expect(kept.acceptance).toEqual(['The export page offers CSV']);
});

test('an acceptance line copied from a document stays when it shares a rule’s words', () => {
  const fromDocument = 'Do not refactor unrelated code in the same change.';
  const invented = 'Prefer small reviewable diffs with no drive-by refactors.';
  const kept = draftOf({
    summary: 'Update the libraries.',
    prompt: 'Update the libraries.',
    acceptance: [fromDocument, invented],
    rules: [smallDiffs],
    chunks: [{ text: fromDocument }],
  });
  expect(kept.acceptance).toContain(fromDocument);
  expect(kept.acceptance).not.toContain(invented);
});

test('a path that starts with a dot keeps the space in front of it', () => {
  const drafted = draftOf({
    summary:
      'Remove the variable from 9. .github/workflows/cd.yml and leave terraform/newrelic/, .github/workflows/newrelic.yml or ./scripts and see ../.github/workflows. Update the libraries .',
    prompt:
      'Remove the variable from .github/workflows/cd.yml and leave terraform/newrelic/ and .github/workflows/newrelic.yml or ./scripts and see ../.github/workflows. Update the libraries.',
  });
  expect(drafted.summary).toContain('9. .github/workflows/cd.yml');
  expect(drafted.summary).toContain('terraform/newrelic/, .github/workflows/newrelic.yml');
  expect(drafted.summary).toContain('or ./scripts');
  expect(drafted.summary).toContain('see ../.github/workflows');
  expect(drafted.summary).not.toContain('9..github');
  expect(drafted.summary).not.toContain(',.github');
  expect(drafted.summary).not.toContain('or./');
  expect(drafted.summary).not.toContain('see../');
  expect(drafted.summary).toContain('Update the libraries.');
  expect(drafted.summary).not.toContain('libraries .');
});

test('a draft stores a link once and skips the ticket address', () => {
  const encoded = 'https://example.com/findings?filters=%7B%22status%22%3A%22open%22%7D';
  const decoded = 'https://example.com/findings?filters={"status":"open"}';
  const drafted = draftOf({
    summary: `Update the libraries. Findings: ${decoded}`,
    prompt: [
      '# ACME-12: Update the libraries',
      '',
      '- **URL:** https://example.com/browse/ACME-12',
      '',
      `See [${decoded}](${encoded}).`,
      'Also https://example.com/browse/acme-12',
      'Related: https://example.com/browse/ACME-99',
      'File: https://example.com/files/ACME-12',
    ].join('\n'),
  });
  expect(drafted.summary).toContain(decoded);
  expect(drafted.summary).not.toContain(encoded);
  expect(drafted.summary).not.toContain('https://example.com/browse/ACME-12');
  expect(drafted.summary).not.toContain('https://example.com/browse/acme-12');
  expect(drafted.summary).toContain('https://example.com/browse/ACME-99');
  expect(drafted.summary).toContain('https://example.com/files/ACME-12');
});

const smallDiffs = {
  project: 'global',
  ruleId: 'small-diffs',
  title: 'Small diffs. No drive-by refactors.',
  body: 'Prefer small, reviewable diffs. Do not refactor unrelated code in the same change.',
};

const clearNames = {
  project: 'global',
  ruleId: 'clear-names',
  title: 'Prefer clear names and small functions over cleverness.',
  body: 'Prefer human-readable code: clear names, small functions, obvious control flow.',
};

function draftOf(input: {
  summary: string;
  prompt: string;
  constraints?: string[];
  acceptance?: string[];
  rules?: Array<{ project: string; ruleId: string; title: string; body: string }>;
  decisions?: Array<{ decisionId: string; content?: string; quote?: string }>;
  chunks?: Array<{ text?: string }>;
}) {
  const parsed = parseDraftModelText(
    JSON.stringify({
      intent: 'Update the libraries',
      summary: input.summary,
      repos: [{ owner: 'acme', repo: 'web' }],
      constraints: input.constraints ?? ['Only change the export path.'],
      acceptance: input.acceptance ?? ['The export page offers CSV.'],
    }),
    {
      project: 'acme',
      prompt: input.prompt,
      repos: [web],
      decisions: input.decisions ?? [],
      chunks: input.chunks ?? [],
      rules: input.rules ?? [],
    },
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.response);
  }
  return parsed.workOrder;
}

test('garbage text is not a work order', () => {
  expect(parseDraftModelText('not json', { project: 'acme', repos: [web], decisions: [], chunks: [], rules: [] })).toEqual({
    ok: false,
    response: 'The model did not return a work order.',
  });
});
