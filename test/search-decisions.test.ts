import {
  DECISIONS_VECTOR_INDEX,
  decisionFromItem,
  decisionsFromSearchResults,
  decisionsSearchInput,
  searchDecisionsAcrossProjects,
  searchVectorFromEmbedding,
} from '../lib/search-decisions.js';

test('search is equality on one project because the vector index hashes project', () => {
  const input = decisionsSearchInput({
    tableName: 'decisions',
    project: 'bpp',
    embedding: [0.1, -0.2],
  });
  expect(input.IndexName).toBe(DECISIONS_VECTOR_INDEX);
  expect(input.SearchConditionExpression).toBe('#p = :p');
  expect(input.SearchConditionExpression).not.toMatch(/IN/i);
  expect(input.ExpressionAttributeNames['#p']).toBe('project');
  expect(input.ExpressionAttributeValues[':p']).toEqual({ S: 'bpp' });
  expect(input.SearchVector).toEqual(searchVectorFromEmbedding([0.1, -0.2]));
});

test('a client search hits that client then global', async () => {
  const searchOne = jest.fn(async (project: string) => [{ project } as never]);
  const found = await searchDecisionsAcrossProjects({
    project: 'bpp',
    embedding: [1],
    searchOne,
  });
  expect(searchOne.mock.calls.map((call) => call[0])).toEqual(['bpp', 'global']);
  expect(found.map((row) => row.project)).toEqual(['bpp', 'global']);
});

test('a global search does not open other clients', async () => {
  const searchOne = jest.fn(async () => []);
  await searchDecisionsAcrossProjects({
    project: 'global',
    embedding: [1],
    searchOne,
  });
  expect(searchOne.mock.calls.map((call) => call[0])).toEqual(['global']);
});

test('a complete decision item is kept and an incomplete one is dropped', () => {
  const kept = decisionFromItem({
    project: { S: 'bpp' },
    decisionId: { S: 'abc' },
    title: { S: 'CSV only' },
    content: { S: 'v1 ships CSV, not Excel.' },
    quote: { S: 'Excel is out of scope.' },
    speaker: { S: 'Marcus Webb' },
    timestamp: { S: '00:00:20.500' },
    loggedAt: { S: '2026-10-15T12:00:00.000Z' },
    sourceKey: { S: 'bpp/transcripts/standup.vtt' },
  });
  expect(kept).toEqual({
    project: 'bpp',
    decisionId: 'abc',
    title: 'CSV only',
    content: 'v1 ships CSV, not Excel.',
    quote: 'Excel is out of scope.',
    speaker: 'Marcus Webb',
    timestamp: '00:00:20.500',
    loggedAt: '2026-10-15T12:00:00.000Z',
    sourceKey: 'bpp/transcripts/standup.vtt',
  });
  expect(
    decisionsFromSearchResults([
      { Item: { title: { S: 'missing keys' } } },
      {
        Item: {
          project: { S: 'bpp' },
          decisionId: { S: 'abc' },
          title: { S: 'CSV only' },
          content: { S: 'v1 ships CSV, not Excel.' },
          quote: { S: 'Excel is out of scope.' },
          speaker: { S: 'Marcus Webb' },
          timestamp: { S: '00:00:20.500' },
          loggedAt: { S: '2026-10-15T12:00:00.000Z' },
          sourceKey: { S: 'bpp/transcripts/standup.vtt' },
        },
      },
    ]),
  ).toEqual([kept]);
});
