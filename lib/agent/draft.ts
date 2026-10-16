import type { RetrievedDecision } from '../search-decisions.js';
import type { Repo, Rule } from '../lookup.js';
import {
  formatDraftMarkdown,
  parseDraftModelText,
  RULE_PRECEDENCE,
  type DraftResponseFormat,
  type DraftWrite,
} from '../work-order.js';
import type { AnswerResult, RetrievedChunk } from './answer.js';

export async function draftWorkOrder(input: {
  prompt: string;
  project: string;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  searchDecisions: (query: { prompt: string; project: string }) => Promise<RetrievedDecision[]>;
  loadRules: (project: string) => Promise<Rule[]>;
  loadRepos: (project: string) => Promise<Repo[]>;
  complete: (query: {
    prompt: string;
    project: string;
    chunks: RetrievedChunk[];
    decisions: RetrievedDecision[];
    rules: Rule[];
    repos: Repo[];
  }) => Promise<string>;
  put: (item: DraftWrite) => Promise<void>;
  draftId: string;
  createdAt: string;
  format?: DraftResponseFormat;
}): Promise<AnswerResult> {
  const chunksPromise = input.retrieve({ prompt: input.prompt, project: input.project });
  const decisionsPromise = input.searchDecisions({ prompt: input.prompt, project: input.project }).catch((error) => {
    console.error(error);
    return [];
  });
  const rulesPromise = input.loadRules(input.project);
  const reposPromise = input.loadRepos(input.project).catch((error) => {
    console.error(error);
    return [];
  });
  const [chunks, decisions, repos] = await Promise.all([
    chunksPromise,
    decisionsPromise,
    reposPromise,
  ]);
  let rules: Rule[];
  try {
    rules = await rulesPromise;
  } catch (error) {
    console.error(error);
    return { response: 'Rules failed to load.', status: 'success' };
  }
  const text = await input.complete({
    prompt: input.prompt,
    project: input.project,
    chunks,
    decisions,
    rules,
    repos,
  });
  const parsed = parseDraftModelText(text, {
    project: input.project,
    repos,
    decisions,
    chunks,
    rules,
  });
  if (!parsed.ok) {
    return { response: parsed.response, status: 'success' };
  }
  const item: DraftWrite = {
    project: input.project,
    draftId: input.draftId,
    workOrder: parsed.workOrder,
    citations: parsed.citations,
    createdAt: input.createdAt,
  };
  await input.put(item);
  const response =
    input.format === 'markdown'
      ? formatDraftMarkdown(
          item,
          decisions.filter((decision) => parsed.citations.decisionIds.includes(decision.decisionId)),
        )
      : JSON.stringify(item, null, 2);
  return { response, status: 'success' };
}

export async function readWorkOrder(input: {
  project: string;
  draftId: string;
  format?: DraftResponseFormat;
  get: (key: { project: string; draftId: string }) => Promise<unknown>;
  loadDecisions: (ids: string[]) => Promise<RetrievedDecision[]>;
}): Promise<AnswerResult> {
  const stored = await input.get({ project: input.project, draftId: input.draftId });
  if (stored === undefined) {
    return { response: 'No draft with that id.', status: 'error' };
  }
  if (!isDraftWrite(stored)) {
    return { response: 'The stored draft could not be read.', status: 'error' };
  }
  if (input.format !== 'markdown') {
    return { response: JSON.stringify(stored, null, 2), status: 'success' };
  }
  const decisions = await input.loadDecisions(stored.citations.decisionIds).catch((error) => {
    console.error(error);
    return [];
  });
  return { response: formatDraftMarkdown(stored, decisions), status: 'success' };
}

function isDraftWrite(value: unknown): value is DraftWrite {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<DraftWrite>;
  const workOrder = item.workOrder;
  const citations = item.citations;
  if (
    typeof item.project !== 'string' ||
    typeof item.draftId !== 'string' ||
    typeof item.createdAt !== 'string' ||
    workOrder === null ||
    typeof workOrder !== 'object' ||
    typeof workOrder.intent !== 'string' ||
    typeof workOrder.summary !== 'string' ||
    !isStringArray(workOrder.constraints) ||
    !isStringArray(workOrder.acceptance) ||
    typeof workOrder.rulePrecedence !== 'string' ||
    !Array.isArray(workOrder.repos) ||
    !Array.isArray(workOrder.rules) ||
    citations === null ||
    typeof citations !== 'object' ||
    !isStringArray(citations.decisionIds) ||
    !isStringArray(citations.documentUris)
  ) {
    return false;
  }
  return (
    workOrder.repos.every(
      (repo) =>
        repo !== null &&
        typeof repo === 'object' &&
        typeof repo.owner === 'string' &&
        typeof repo.repo === 'string',
    ) &&
    workOrder.rules.every(
      (rule) =>
        rule !== null &&
        typeof rule === 'object' &&
        typeof rule.project === 'string' &&
        typeof rule.ruleId === 'string' &&
        typeof rule.title === 'string' &&
        typeof rule.body === 'string',
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export const DRAFT_SYSTEM_PROMPT =
  `You draft a work order from the rules, decisions, documents, and repos provided. Return JSON only. If you can draft, return {"intent":"","summary":"","repos":[{"owner":"","repo":""}],"constraints":[""],"acceptance":[""],"citations":{"decisionIds":[],"documentUris":[]}}. Optional paths on a repo if the work is a subtree. If you cannot draft, return {"blocked":"why"}. Use only the provided material. ${RULE_PRECEDENCE} Decisions overrule documents. Project decisions beat global decisions. Do not invent a ticket, path, or repo that is not in the repo list. Repos must be owner/repo pairs from that list. constraints and acceptance must be non-empty arrays. constraints are only what is special to this job. Do not copy or restate a loaded rule. Rules are attached separately. intent is the change in one line. summary is what to do and why. If rules failed to load, blocked.`;
