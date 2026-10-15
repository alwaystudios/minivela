import { parseDraftModelText } from '../lib/work-order.js';

const learn = {
  project: 'bpp',
  repoId: 'bpp/learn',
  owner: 'bpp',
  repo: 'learn',
  url: 'https://github.com/bpp/learn',
  summary: 'Learner app.',
};

test('a fenced work order is kept and unknown citations are dropped', () => {
  const parsed = parseDraftModelText(
    '```json\n{"intent":"Go","summary":"Do the thing.","repos":[{"owner":"bpp","repo":"learn","paths":[]}],"constraints":["Small diffs."],"acceptance":["A test covers it."],"citations":{"decisionIds":["kept","nope"],"documentUris":["s3://doc/rfc.md","s3://other"]}}\n```',
    {
      project: 'bpp',
      repos: [learn],
      decisions: [{ decisionId: 'kept' }],
      chunks: [{ uri: 's3://doc/rfc.md' }],
    },
  );
  expect(parsed).toEqual({
    ok: true,
    workOrder: {
      intent: 'Go',
      summary: 'Do the thing.',
      repos: [{ owner: 'bpp', repo: 'learn' }],
      constraints: ['Small diffs.'],
      acceptance: ['A test covers it.'],
      project: 'bpp',
    },
    citations: { decisionIds: ['kept'], documentUris: ['s3://doc/rfc.md'] },
  });
});

test('garbage text is not a work order', () => {
  expect(parseDraftModelText('not json', { project: 'bpp', repos: [learn], decisions: [], chunks: [] })).toEqual({
    ok: false,
    response: 'The model did not return a work order.',
  });
});
