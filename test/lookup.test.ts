import {
  loadPartitions,
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
  expect(rulePartitions('acme')).toEqual(['global', 'acme']);
  expect(rulePartitions('global')).toEqual(['global']);
});

test('a failed partition fails the load', async () => {
  await expect(
    loadPartitions({
      projects: ['global', 'acme'],
      loadOne: async (project) => {
        if (project === 'global') {
          throw new Error('query failed');
        }
        return ['kept'];
      },
    }),
  ).rejects.toThrow('query failed');
});

test('repos load the requested client only', () => {
  expect(repoPartitions('acme')).toEqual(['acme']);
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
    project: { S: 'acme' },
    repoId: { S: 'acme/web' },
    owner: { S: 'acme' },
    repo: { S: 'web' },
    url: { S: 'https://github.com/acme/web' },
    summary: { S: 'Web app.' },
  });
  expect(kept?.repoId).toBe('acme/web');
  expect(reposFromQueryItems([{ owner: { S: 'acme' } }])).toEqual([]);
});
