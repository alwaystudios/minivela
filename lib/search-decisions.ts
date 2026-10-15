import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { projectRetrieveValues } from './project-filter.js';

export const DECISIONS_VECTOR_INDEX = 'decisions-by-project';
export const DECISIONS_SEARCH_TOP_K = 5;

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

export function decisionsFromSearchResults(
  results: Array<{ Item?: Record<string, AttributeValue> }> | undefined,
): RetrievedDecision[] {
  return (results ?? []).flatMap((hit) => {
    const decision = decisionFromItem(hit.Item);
    return decision ? [decision] : [];
  });
}

export async function searchDecisionsAcrossProjects(input: {
  project: string;
  embedding: number[];
  searchOne: (project: string, embedding: number[]) => Promise<RetrievedDecision[]>;
}): Promise<RetrievedDecision[]> {
  const groups = await Promise.all(
    projectRetrieveValues(input.project).map((value) => input.searchOne(value, input.embedding)),
  );
  return groups.flat();
}

function stringAttr(item: Record<string, AttributeValue>, key: string): string | undefined {
  const value = item[key]?.S;
  return typeof value === 'string' ? value : undefined;
}
