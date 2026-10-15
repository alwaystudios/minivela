import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { projectRetrieveValues } from './project-filter.js';

export const DECISIONS_VECTOR_INDEX = 'decisions-by-project';
export const DECISIONS_SEARCH_TOP_K = 5;
export const DECISION_MAX_COSINE_DISTANCE = 0.5;

export type RetrievedDecision = {
  project: string;
  decisionId: string;
  title: string;
  content: string;
  quote: string;
  speaker: string;
  timestamp: string;
  loggedAt: string;
  sourceKey: string;
};

export type ScoredDecision = {
  decision: RetrievedDecision;
  score: number;
};

export function searchVectorFromEmbedding(embedding: number[]): Array<{ N: string }> {
  return embedding.map((value) => ({ N: String(value) }));
}

export function decisionsSearchInput(input: {
  tableName: string;
  project: string;
  embedding: number[];
}): {
  TableName: string;
  IndexName: string;
  TopK: number;
  SearchVector: Array<{ N: string }>;
  SearchConditionExpression: string;
  ExpressionAttributeNames: { '#p': 'project'; '#t': 'timestamp' };
  ExpressionAttributeValues: { ':p': { S: string } };
  ProjectionExpression: string;
} {
  return {
    TableName: input.tableName,
    IndexName: DECISIONS_VECTOR_INDEX,
    TopK: DECISIONS_SEARCH_TOP_K,
    SearchVector: searchVectorFromEmbedding(input.embedding),
    SearchConditionExpression: '#p = :p',
    ExpressionAttributeNames: {
      '#p': 'project',
      '#t': 'timestamp',
    },
    ExpressionAttributeValues: {
      ':p': { S: input.project },
    },
    ProjectionExpression: '#p, decisionId, title, content, quote, speaker, #t, loggedAt, sourceKey',
  };
}

export function decisionFromItem(
  item: Record<string, AttributeValue> | undefined,
): RetrievedDecision | undefined {
  if (!item) {
    return undefined;
  }
  const project = stringAttr(item, 'project');
  const decisionId = stringAttr(item, 'decisionId');
  const title = stringAttr(item, 'title');
  const content = stringAttr(item, 'content');
  const quote = stringAttr(item, 'quote');
  const loggedAt = stringAttr(item, 'loggedAt');
  const sourceKey = stringAttr(item, 'sourceKey');
  if (!project || !decisionId || !title || !content || !quote || !loggedAt || !sourceKey) {
    return undefined;
  }
  return {
    project,
    decisionId,
    title,
    content,
    quote,
    speaker: stringAttr(item, 'speaker') ?? '',
    timestamp: stringAttr(item, 'timestamp') ?? '',
    loggedAt,
    sourceKey,
  };
}

export function scoredDecisionsFromSearchResults(
  results: Array<{ Item?: Record<string, AttributeValue>; Score?: number }> | undefined,
): ScoredDecision[] {
  return (results ?? []).flatMap((hit) => {
    const decision = decisionFromItem(hit.Item);
    if (!decision || typeof hit.Score !== 'number') {
      return [];
    }
    return [{ decision, score: hit.Score }];
  });
}

export function selectDecisions(requested: string, scored: ScoredDecision[]): RetrievedDecision[] {
  const close = scored.filter((row) => row.score <= DECISION_MAX_COSINE_DISTANCE).map((row) => row.decision);
  return collapseConflicts(rankDecisions(requested, close));
}

export function rankDecisions(requested: string, decisions: RetrievedDecision[]): RetrievedDecision[] {
  return [...decisions].sort((left, right) => {
    const leftLevel = left.project === requested ? 0 : 1;
    const rightLevel = right.project === requested ? 0 : 1;
    if (leftLevel !== rightLevel) {
      return leftLevel - rightLevel;
    }
    const logged = right.loggedAt.localeCompare(left.loggedAt);
    if (logged !== 0) {
      return logged;
    }
    return right.timestamp.localeCompare(left.timestamp);
  });
}

export function collapseConflicts(ranked: RetrievedDecision[]): RetrievedDecision[] {
  const kept: RetrievedDecision[] = [];
  const seen = new Set<string>();
  for (const decision of ranked) {
    const key = decision.title.trim().toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(decision);
  }
  return kept;
}

export async function searchDecisionsAcrossProjects(input: {
  project: string;
  embedding: number[];
  searchOne: (project: string, embedding: number[]) => Promise<ScoredDecision[]>;
}): Promise<RetrievedDecision[]> {
  const groups = await Promise.all(
    projectRetrieveValues(input.project).map(async (value) => {
      try {
        return await input.searchOne(value, input.embedding);
      } catch (error) {
        console.error(error);
        return [];
      }
    }),
  );
  return selectDecisions(input.project, groups.flat());
}

function stringAttr(item: Record<string, AttributeValue>, key: string): string | undefined {
  const value = item[key]?.S;
  return typeof value === 'string' ? value : undefined;
}
