import { parseDraftModelText, RULE_PRECEDENCE } from '../lib/work-order.js';

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

test('garbage text is not a work order', () => {
  expect(parseDraftModelText('not json', { project: 'acme', repos: [web], decisions: [], chunks: [], rules: [] })).toEqual({
    ok: false,
    response: 'The model did not return a work order.',
  });
});
