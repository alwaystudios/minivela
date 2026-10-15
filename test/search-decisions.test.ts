import {
  DECISION_MAX_COSINE_DISTANCE,
  DECISIONS_VECTOR_INDEX,
  decisionFromItem,
  decisionsSearchInput,
  rankDecisions,
  scoredDecisionsFromSearchResults,
  searchDecisionsAcrossProjects,
  searchVectorFromEmbedding,
  selectDecisions,
  type RetrievedDecision,
  type ScoredDecision,
} from '../lib/search-decisions.js';

const csv: RetrievedDecision = {
  project: 'bpp',
  decisionId: 'abc',
  title: 'CSV only',
  content: 'v1 ships CSV, not Excel.',
  quote: 'Excel is out of scope.',
  speaker: 'Marcus Webb',
  timestamp: '00:00:20.500',
  loggedAt: '2026-10-15T12:00:00.000Z',
  sourceKey: 'bpp/transcripts/standup.vtt',
};

function scored(decision: RetrievedDecision, score: number): ScoredDecision {
  return { decision, score };
}

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
  const searchOne = jest.fn(async (project: string) => [
    scored({ ...csv, project, decisionId: project, title: `${project} topic` }, 0.1),
  ]);
  const found = await searchDecisionsAcrossProjects({
    project: 'bpp',
    embedding: [1],
    searchOne,
  });
  expect(searchOne.mock.calls.map((call) => call[0])).toEqual(['bpp', 'global']);
  expect(found.map((row) => row.project)).toEqual(['bpp', 'global']);
});

test('a global search does not open other clients', async () => {
  const searchOne = jest.fn(async (_project: string) => [] as ScoredDecision[]);
  await searchDecisionsAcrossProjects({
    project: 'global',
    embedding: [1],
    searchOne,
  });
  expect(searchOne.mock.calls.map((call) => call[0])).toEqual(['global']);
});

test('a failed partition search does not drop the other', async () => {
  const searchOne = jest.fn(async (project: string) => {
    if (project === 'global') {
      throw new Error('search-dynamodb unreachable');
    }
    return [scored(csv, 0.1)];
  });
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const found = await searchDecisionsAcrossProjects({
      project: 'bpp',
      embedding: [1],
      searchOne,
    });
    expect(found).toEqual([csv]);
  } finally {
    error.mockRestore();
  }
});

test('a complete scored item is kept and an incomplete one is dropped', () => {
  expect(decisionFromItem({ title: { S: 'missing keys' } })).toBeUndefined();
  expect(
    scoredDecisionsFromSearchResults([
      { Item: { title: { S: 'missing keys' } }, Score: 0.1 },
      {
        Item: {
          project: { S: csv.project },
          decisionId: { S: csv.decisionId },
          title: { S: csv.title },
          content: { S: csv.content },
          quote: { S: csv.quote },
          speaker: { S: csv.speaker },
          timestamp: { S: csv.timestamp },
          loggedAt: { S: csv.loggedAt },
          sourceKey: { S: csv.sourceKey },
        },
        Score: 0.2,
      },
      {
        Item: {
          project: { S: csv.project },
          decisionId: { S: 'no-score' },
          title: { S: csv.title },
          content: { S: csv.content },
          quote: { S: csv.quote },
          speaker: { S: csv.speaker },
          timestamp: { S: csv.timestamp },
          loggedAt: { S: csv.loggedAt },
          sourceKey: { S: csv.sourceKey },
        },
      },
    ]),
  ).toEqual([scored(csv, 0.2)]);
});

test('a distant hit does not overrule documents', () => {
  const close = scored(csv, DECISION_MAX_COSINE_DISTANCE);
  const distant = scored({ ...csv, decisionId: 'far', title: 'Unrelated' }, DECISION_MAX_COSINE_DISTANCE + 0.01);
  expect(selectDecisions('bpp', [distant, close])).toEqual([csv]);
});

test('a project decision beats a newer global decision with the same title', () => {
  const olderProject = {
    ...csv,
    loggedAt: '2026-10-01T00:00:00.000Z',
  };
  const newerGlobal = {
    ...csv,
    project: 'global',
    decisionId: 'global-csv',
    loggedAt: '2026-10-20T00:00:00.000Z',
  };
  expect(selectDecisions('bpp', [scored(newerGlobal, 0.1), scored(olderProject, 0.1)])).toEqual([
    olderProject,
  ]);
});

test('later loggedAt wins inside one project, then later cue timestamp', () => {
  const earlier = {
    ...csv,
    decisionId: 'early',
    title: 'Export format',
    loggedAt: '2026-10-01T00:00:00.000Z',
    timestamp: '00:00:40.000',
  };
  const laterSameTime = {
    ...csv,
    decisionId: 'mid',
    title: 'Auth',
    loggedAt: '2026-10-15T00:00:00.000Z',
    timestamp: '00:00:10.000',
  };
  const laterCue = {
    ...csv,
    decisionId: 'late-cue',
    title: 'Auth extra',
    loggedAt: '2026-10-15T00:00:00.000Z',
    timestamp: '00:00:50.000',
  };
  expect(rankDecisions('bpp', [earlier, laterSameTime, laterCue]).map((row) => row.decisionId)).toEqual([
    'late-cue',
    'mid',
    'early',
  ]);
});
