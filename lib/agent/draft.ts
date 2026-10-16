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
  const response = input.format === 'markdown' ? formatDraftMarkdown(item) : JSON.stringify(item, null, 2);
  return { response, status: 'success' };
}

export const DRAFT_SYSTEM_PROMPT =
  `You draft a work order from the rules, decisions, documents, and repos provided. Return JSON only. If you can draft, return {"intent":"","summary":"","repos":[{"owner":"","repo":""}],"constraints":[""],"acceptance":[""],"citations":{"decisionIds":[],"documentUris":[]}}. Optional paths on a repo if the work is a subtree. If you cannot draft, return {"blocked":"why"}. Use only the provided material. ${RULE_PRECEDENCE} Decisions overrule documents. Project decisions beat global decisions. Do not invent a ticket, path, or repo that is not in the repo list. Repos must be owner/repo pairs from that list. constraints and acceptance must be non-empty arrays. intent is the change in one line. summary is what to do and why. If rules failed to load, blocked.`;
