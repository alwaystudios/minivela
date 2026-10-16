import type { Repo, Rule } from './lookup.js';

export type WorkOrderRepo = {
  owner: string;
  repo: string;
  paths?: string[];
};

export type WorkOrder = {
  intent: string;
  summary: string;
  repos: WorkOrderRepo[];
  constraints: string[];
  acceptance: string[];
  rules: Rule[];
  project?: string;
};

export type DraftCitations = {
  decisionIds: string[];
  documentUris: string[];
};

export type DraftWrite = {
  project: string;
  draftId: string;
  workOrder: WorkOrder;
  citations: DraftCitations;
  createdAt: string;
};

export type DraftParse =
  | { ok: true; workOrder: WorkOrder; citations: DraftCitations }
  | { ok: false; response: string };

export function parseDraftModelText(
  text: string,
  input: {
    project: string;
    repos: Repo[];
    decisions: Array<{ decisionId: string }>;
    chunks: Array<{ uri?: string }>;
    rules: Rule[];
  },
): DraftParse {
  const parsed = parseJsonObject(text);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: 'The model did not return a work order.' };
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.blocked === 'string' && body.blocked.trim()) {
    return { ok: false, response: body.blocked.trim() };
  }
  const intent = nonEmptyString(body.intent);
  const summary = nonEmptyString(body.summary);
  const repos = parseRepos(body.repos);
  const constraints = nonEmptyStrings(body.constraints);
  const acceptance = nonEmptyStrings(body.acceptance);
  if (!intent || !summary || !repos || !constraints || !acceptance) {
    return { ok: false, response: 'The model did not return a work order.' };
  }
  const allowed = new Set(input.repos.map((repo) => `${repo.owner}/${repo.repo}`));
  if (repos.some((repo) => !allowed.has(`${repo.owner}/${repo.repo}`))) {
    return { ok: false, response: 'The draft named a repo that is not in the project map.' };
  }
  const knownDecisionIds = new Set(input.decisions.map((decision) => decision.decisionId));
  const knownDocumentUris = new Set(
    input.chunks.flatMap((chunk) => (chunk.uri ? [chunk.uri] : [])),
  );
  const citations = parseCitations(body.citations, knownDecisionIds, knownDocumentUris);
  const workOrder: WorkOrder = {
    intent,
    summary,
    repos,
    constraints,
    acceptance,
    rules: input.rules,
    project: input.project,
  };
  return { ok: true, workOrder, citations };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1].trim() : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function parseRepos(value: unknown): WorkOrderRepo[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const repos: WorkOrderRepo[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return undefined;
    }
    const owner = nonEmptyString((item as { owner?: unknown }).owner);
    const repo = nonEmptyString((item as { repo?: unknown }).repo);
    if (!owner || !repo) {
      return undefined;
    }
    const parsedPaths = parseOptionalPaths((item as { paths?: unknown }).paths);
    if (!parsedPaths.ok) {
      return undefined;
    }
    repos.push(parsedPaths.paths ? { owner, repo, paths: parsedPaths.paths } : { owner, repo });
  }
  return repos;
}

function parseOptionalPaths(value: unknown): { ok: true; paths?: string[] } | { ok: false } {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return { ok: true };
  }
  const paths = nonEmptyStrings(value);
  if (!paths) {
    return { ok: false };
  }
  return { ok: true, paths };
}

function parseCitations(
  value: unknown,
  knownDecisionIds: Set<string>,
  knownDocumentUris: Set<string>,
): DraftCitations {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { decisionIds: [], documentUris: [] };
  }
  const body = value as { decisionIds?: unknown; documentUris?: unknown };
  return {
    decisionIds: stringList(body.decisionIds).filter((id) => knownDecisionIds.has(id)),
    documentUris: stringList(body.documentUris).filter((uri) => knownDocumentUris.has(uri)),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const text = nonEmptyString(item);
    return text ? [text] : [];
  });
}

function nonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of value) {
    const text = nonEmptyString(item);
    if (!text) {
      return undefined;
    }
    items.push(text);
  }
  return items;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text ? text : undefined;
}
