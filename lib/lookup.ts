import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { projectRetrieveValues } from './project-filter.js';

export type Rule = {
  project: string;
  ruleId: string;
  title: string;
  body: string;
};

export type Repo = {
  project: string;
  repoId: string;
  owner: string;
  repo: string;
  url: string;
  summary: string;
};

export function partitionQueryInput(
  tableName: string,
  project: string,
): {
  TableName: string;
  KeyConditionExpression: string;
  ExpressionAttributeNames: { '#p': 'project' };
  ExpressionAttributeValues: { ':p': { S: string } };
} {
  return {
    TableName: tableName,
    KeyConditionExpression: '#p = :p',
    ExpressionAttributeNames: { '#p': 'project' },
    ExpressionAttributeValues: { ':p': { S: project } },
  };
}

export function rulePartitions(project: string): string[] {
  const values = projectRetrieveValues(project);
  return ['global', ...values.filter((value) => value !== 'global')];
}

export function repoPartitions(project: string): string[] {
  return [project.trim()];
}

export function ruleFromItem(item: Record<string, AttributeValue> | undefined): Rule | undefined {
  if (!item) {
    return undefined;
  }
  const project = stringAttr(item, 'project');
  const ruleId = stringAttr(item, 'ruleId');
  const title = stringAttr(item, 'title');
  const body = stringAttr(item, 'body');
  if (!project || !ruleId || !title || !body) {
    return undefined;
  }
  return { project, ruleId, title, body };
}

export function repoFromItem(item: Record<string, AttributeValue> | undefined): Repo | undefined {
  if (!item) {
    return undefined;
  }
  const project = stringAttr(item, 'project');
  const repoId = stringAttr(item, 'repoId');
  const owner = stringAttr(item, 'owner');
  const repo = stringAttr(item, 'repo');
  const url = stringAttr(item, 'url');
  const summary = stringAttr(item, 'summary');
  if (!project || !repoId || !owner || !repo || !url || !summary) {
    return undefined;
  }
  return { project, repoId, owner, repo, url, summary };
}

export function rulesFromQueryItems(
  items: Array<Record<string, AttributeValue>> | undefined,
): Rule[] {
  return (items ?? []).flatMap((item) => {
    const rule = ruleFromItem(item);
    return rule ? [rule] : [];
  });
}

export function reposFromQueryItems(
  items: Array<Record<string, AttributeValue>> | undefined,
): Repo[] {
  return (items ?? []).flatMap((item) => {
    const repo = repoFromItem(item);
    return repo ? [repo] : [];
  });
}

export async function loadPartitions<T>(input: {
  projects: string[];
  loadOne: (project: string) => Promise<T[]>;
}): Promise<T[]> {
  const groups = await Promise.all(input.projects.map((project) => input.loadOne(project)));
  return groups.flat();
}

function stringAttr(item: Record<string, AttributeValue>, key: string): string | undefined {
  const value = item[key]?.S;
  return typeof value === 'string' ? value : undefined;
}
