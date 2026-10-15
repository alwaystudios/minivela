import {
  partitionQueryInput,
  repoFromItem,
  repoPartitions,
  reposFromQueryItems,
  ruleFromItem,
  rulePartitions,
  rulesFromQueryItems,
} from '../lib/lookup.js';

test('a partition query aliases the reserved project name', () => {
  expect(partitionQueryInput('rules', 'global')).toEqual({
    TableName: 'rules',
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'project' },
    ExpressionAttributeValues: { ':p': { S: 'global' } },
  });
});

test('rules load global first, then the client', () => {
  expect(rulePartitions('bpp')).toEqual(['global', 'bpp']);
  expect(rulePartitions('global')).toEqual(['global']);
});

test('repos load the requested client only', () => {
  expect(repoPartitions('bpp')).toEqual(['bpp']);
  expect(repoPartitions('global')).toEqual(['global']);
});

test('a complete rule is kept and an incomplete one is dropped', () => {
  const kept = ruleFromItem({
    project: { S: 'global' },
    ruleId: { S: 'small-diffs' },
    title: { S: 'Small diffs. No drive-by refactors.' },
    body: { S: 'Prefer small, reviewable diffs.' },
  });
  expect(kept?.ruleId).toBe('small-diffs');
  expect(rulesFromQueryItems([{ title: { S: 'missing' } }, kept ? {
    project: { S: kept.project },
    ruleId: { S: kept.ruleId },
    title: { S: kept.title },
    body: { S: kept.body },
  } : {}])).toEqual([kept]);
});

test('a complete repo is kept and an incomplete one is dropped', () => {
  const kept = repoFromItem({
    project: { S: 'bpp' },
    repoId: { S: 'bpp/learn' },
    owner: { S: 'bpp' },
    repo: { S: 'learn' },
    url: { S: 'https://github.com/bpp/learn' },
    summary: { S: 'Learner app.' },
  });
  expect(kept?.repoId).toBe('bpp/learn');
  expect(reposFromQueryItems([{ owner: { S: 'bpp' } }])).toEqual([]);
});
