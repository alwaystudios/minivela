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
  ticketDocument?: RetrievedChunk;
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
  const chunksPromise = input.ticketDocument
    ? Promise.resolve([input.ticketDocument])
    : input.retrieve({ prompt: input.prompt, project: input.project });
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
    prompt: input.prompt,
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
    !isOptionalStringArray(workOrder.consequences) ||
    !isPremises(workOrder.premises) ||
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

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isPremises(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.claim === 'string' &&
        item.claim.trim().length > 0,
    )
  );
}

export const DRAFT_SYSTEM_PROMPT =
  `You draft a work order from the rules, decisions, documents, and repos provided. Return JSON only. If you can draft, return {"intent":"","summary":"","repos":[{"owner":"","repo":""}],"constraints":[""],"acceptance":[""],"consequences":[""],"premises":[{"claim":"","ifFalse":"stop"}],"citations":{"decisionIds":[],"documentUris":[]}}. Optional paths on a repo if the work is a subtree. consequences and premises may be empty arrays. If you cannot draft, return {"blocked":"why"}. Use only the provided material. ${RULE_PRECEDENCE} Decisions overrule documents. Project decisions beat global decisions. Do not invent a ticket, path, or repo that is not in the repo list. If the source names the repo to change, use that repo. If it names none, infer the target from the repo map. If two parts of the scope name different repos, name both as targets. A repo named only as a design source or reference is not a target. A ticket with more than one step is one work order. Include every step in the summary. A later step stays a step. An exclusion on the first step does not replace a later step that changes that same path. Work that does not block the first step stays in the order when it is in scope or in acceptance. Copy every acceptance line from the source into acceptance. Copy a risk that sets the order of the work into the summary. Copy a path the source names as written. When the source does not choose which path, add a premise with ifFalse stop. Do not hedge a path. Repos must be owner/repo pairs from that list. Do not invent how the change is made. If the source does not name a mechanism, do not add one. Copy repro steps, links, and named files from the source into the summary. Copy a URL as written. Copy a file name the source shows as an existing file. When the source asks the change to write a record into a file that is not in the repo paths, name the module README, or the pull request body when no module is named. constraints and acceptance must be non-empty arrays. constraints are only what is special to this job. Do not copy or restate a loaded rule in the summary, the acceptance, or the constraints, including a paraphrase. A consequence of a loaded rule goes in consequences: one line for what this change must satisfy where it writes files, not the rule text. Rules are attached separately. premises lists each count, metric, log backend, and filename this job depends on. ifFalse is stop when that claim is the point of the work, and omit when the rest can proceed without it. If there are none, return an empty array. An acceptance line that needs a running environment, credentials, a third-party page, or production data ends with "human-verified, not agent-verified". A test that runs in the checkout stays unmarked. intent is the change in one line. summary is what to do and why. If rules failed to load, blocked.`;
