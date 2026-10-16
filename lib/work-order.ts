import type { Repo, Rule } from './lookup.js';
import type { RetrievedDecision } from './search-decisions.js';

export type WorkOrderRepo = {
  owner: string;
  repo: string;
  paths?: string[];
};

export const RULE_PRECEDENCE =
  'Global rules always apply. A client rule may add but cannot drop a global rule. Rules override constraints.';

export type WorkOrder = {
  intent: string;
  summary: string;
  repos: WorkOrderRepo[];
  constraints: string[];
  acceptance: string[];
  rules: Rule[];
  rulePrecedence: string;
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

export type DraftResponseFormat = 'json' | 'markdown';

export function formatDraftMarkdown(
  item: DraftWrite,
  decisions: Array<Pick<RetrievedDecision, 'decisionId' | 'quote' | 'speaker' | 'loggedAt'>> = [],
): string {
  const { workOrder } = item;
  const constraints = workOrder.constraints.filter((line) => !restatesRule(line, workOrder.rules));
  const lines = [
    `Project: ${item.project}`,
    `Draft: ${item.draftId}`,
    `Created: ${item.createdAt}`,
    '',
    '## Intent',
    '',
    safeBlock(workOrder.intent),
    '',
    '## Summary',
    '',
    safeBlock(workOrder.summary),
    '',
    '## Repos',
    '',
    ...workOrder.repos.map(repoLine),
  ];
  if (constraints.length > 0) {
    lines.push('', '## Constraints', '', ...constraints.map((line) => `- ${oneLine(line)}`));
  }
  lines.push(
    '',
    '## Acceptance',
    '',
    ...workOrder.acceptance.map((line) => `- ${oneLine(line)}`),
    '',
    '## Rules',
    '',
    workOrder.rulePrecedence,
  );
  if (workOrder.rules.length > 0) {
    lines.push('', ...ruleBlocks(workOrder.rules));
  }
  const citations = citationLines(item.citations, decisions);
  if (citations.length > 0) {
    lines.push('', '## Citations', '', ...citations);
  }
  return `${lines.join('\n')}\n`;
}

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
    rulePrecedence: RULE_PRECEDENCE,
    project: input.project,
  };
  return { ok: true, workOrder, citations };
}

function repoLine(repo: WorkOrderRepo): string {
  const label = `${oneLine(repo.owner)}/${oneLine(repo.repo)}`;
  const paths = repo.paths?.map(oneLine).filter((path) => path.length > 0);
  return paths && paths.length > 0 ? `- ${label} (${paths.join(', ')})` : `- ${label}`;
}

function ruleBlocks(rules: Rule[]): string[] {
  return rules.flatMap((rule, index) => {
    const block = [
      `### ${oneLine(rule.title)}`,
      '',
      `\`${oneLine(rule.project)}\` / \`${oneLine(rule.ruleId)}\``,
      '',
      safeBlock(rule.body),
    ];
    return index === 0 ? block : ['', ...block];
  });
}

function citationLines(
  citations: DraftCitations,
  decisions: Array<Pick<RetrievedDecision, 'decisionId' | 'quote' | 'speaker' | 'loggedAt'>>,
): string[] {
  const byId = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  const lines: string[] = [];
  for (const id of citations.decisionIds) {
    lines.push(`- decision ${oneLine(id)}`);
    const decision = byId.get(id);
    if (!decision) {
      continue;
    }
    lines.push(`  loggedAt: ${oneLine(decision.loggedAt)}`);
    const speaker = oneLine(decision.speaker);
    if (speaker) {
      lines.push(`  speaker: ${speaker}`);
    }
    const quote = safeBlock(decision.quote);
    if (quote) {
      lines.push(`  quote: ${quote.replace(/\n/g, '\n  ')}`);
    }
  }
  for (const uri of citations.documentUris) {
    lines.push(`- ${oneLine(uri)}`);
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function safeBlock(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const hash = line.indexOf('#');
      if (hash === -1 || line.slice(0, hash).trim() !== '') {
        return line;
      }
      return `${line.slice(0, hash)}\\${line.slice(hash)}`;
    })
    .join('\n')
    .trim();
}

const RULE_WORD_STOP = new Set([
  'this',
  'that',
  'with',
  'from',
  'into',
  'only',
  'your',
  'they',
  'them',
  'then',
  'than',
  'have',
  'does',
  'will',
  'when',
  'what',
  'were',
  'been',
  'also',
  'such',
  'same',
  'part',
]);

function restatesRule(constraint: string, rules: Rule[]): boolean {
  const constraintWords = new Set(words(constraint));
  if (constraintWords.size < 4) {
    return false;
  }
  return rules.some((rule) => {
    const ruleWords = new Set(words(`${rule.title} ${rule.body}`));
    const shared = [...constraintWords].filter((word) => ruleWords.has(word)).length;
    if (shared / constraintWords.size >= 0.6) {
      return true;
    }
    const titleWords = words(rule.title);
    if (titleWords.length < 5) {
      return false;
    }
    const titleShared = titleWords.filter((word) => constraintWords.has(word)).length;
    return titleShared / titleWords.length >= 0.6;
  });
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !RULE_WORD_STOP.has(word))
    .map((word) => word.replace(/(ness|tions|tion|ing|ly|s)$/, ''));
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
