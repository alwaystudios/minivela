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
  const readable = withoutRestatedRules(workOrder);
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
    safeBlock(readable.summary || workOrder.summary),
    '',
    '## Repos',
    '',
    ...workOrder.repos.map(repoLine),
  ];
  if (readable.constraints.length > 0) {
    lines.push('', '## Constraints', '', ...readable.constraints.map((line) => `- ${oneLine(line)}`));
  }
  if (readable.acceptance.length > 0) {
    lines.push('', '## Acceptance', '', ...readable.acceptance.map((line) => `- ${oneLine(line)}`));
  }
  lines.push(
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
    prompt?: string;
    decisions: Array<{ decisionId: string; title?: string; content?: string; quote?: string }>;
    chunks: Array<{ uri?: string; text?: string }>;
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
  const workOrder = retainDraftFacts(
    {
      intent,
      summary,
      repos,
      constraints,
      acceptance,
      rules: input.rules,
      rulePrecedence: RULE_PRECEDENCE,
      project: input.project,
    },
    sourceMaterial(input),
  );
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

const MECHANISM_PHRASES = ['dockerfile', 'dockerfiles', 'base image', 'base images', 'image layer', 'image layers'];

function retainDraftFacts(workOrder: WorkOrder, source: string): WorkOrder {
  const stripped: WorkOrder = {
    ...workOrder,
    summary: proseWithoutMechanism(workOrder.summary, source),
    constraints: workOrder.constraints.filter((line) => !inventedMechanism(line, source)),
    acceptance: workOrder.acceptance.filter((line) => !inventedMechanism(line, source)),
  };
  const readable = withoutRestatedRules(stripped);
  const summary = appendMissingAnchors(
    readable.summary || stripped.summary || workOrder.summary,
    source,
    [workOrder.intent, readable.summary, ...readable.constraints, ...readable.acceptance].join('\n'),
  );
  return {
    ...workOrder,
    summary,
    constraints: readable.constraints,
    acceptance: readable.acceptance,
  };
}

function withoutRestatedRules(workOrder: WorkOrder): { summary: string; constraints: string[]; acceptance: string[] } {
  return {
    summary: proseWithoutRules(workOrder.summary, workOrder.rules),
    constraints: workOrder.constraints.flatMap((line) => {
      const kept = bulletWithoutRules(line, workOrder.rules);
      return kept ? [kept] : [];
    }),
    acceptance: workOrder.acceptance.flatMap((line) => {
      const kept = bulletWithoutRules(line, workOrder.rules);
      return kept ? [kept] : [];
    }),
  };
}

function proseWithoutMechanism(text: string, source: string): string {
  const parts = sentences(text);
  const kept = parts.filter((part) => !inventedMechanism(part, source));
  if (kept.length === 0) {
    return '';
  }
  if (kept.length === parts.length) {
    return text.trim();
  }
  return kept.join(' ');
}

function proseWithoutRules(text: string, rules: Rule[]): string {
  const parts = sentences(text);
  const kept = parts.filter((part) => !restatesRule(part, rules));
  if (kept.length === 0 || kept.length === parts.length) {
    return text.trim();
  }
  return kept.join(' ');
}

function bulletWithoutRules(line: string, rules: Rule[]): string | undefined {
  const parts = line
    .split(/\s*(?:—|;)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) {
    return restatesRule(line, rules) ? undefined : line;
  }
  const kept = parts.filter((part) => !restatesRule(part, rules));
  if (kept.length === 0 || (kept.length === parts.length && restatesRule(line, rules))) {
    return undefined;
  }
  if (kept.length === parts.length) {
    return line;
  }
  return kept.join('; ');
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function inventedMechanism(line: string, source: string): boolean {
  const lineLower = line.toLowerCase();
  const sourceLower = source.toLowerCase();
  return MECHANISM_PHRASES.some((phrase) => lineLower.includes(phrase) && !sourceLower.includes(phrase));
}

function appendMissingAnchors(summary: string, source: string, haystack: string): string {
  let seen = haystack;
  const missing: string[] = [];
  for (const anchor of sourceAnchors(source)) {
    if (seen.includes(anchor)) {
      continue;
    }
    missing.push(anchor);
    seen = `${seen}\n${anchor}`;
  }
  if (missing.length === 0) {
    return summary.trim();
  }
  const base = summary.trim();
  return base ? `${base}\n${missing.join('\n')}` : missing.join('\n');
}

function sourceAnchors(text: string): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    anchors.push(trimmed);
  };
  for (const match of text.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) {
    add(match[1]);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
    add(match[0].replace(/[.,;:]+$/, ''));
  }
  for (const match of text.matchAll(/!\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const alt = match[1].trim();
    if (FILE_EXT.test(alt)) {
      add(alt);
    }
    const base = match[2].split('/').pop();
    if (base && FILE_EXT.test(base)) {
      add(base);
    }
  }
  for (const match of text.matchAll(/(?:^|[\s([/"'])([\w.-]+\.(?:png|jpe?g|webp|gif|pdf))/gi)) {
    add(match[1]);
  }
  for (const step of stepLines(text)) {
    add(step);
  }
  return anchors.filter(
    (anchor) =>
      !anchors.some(
        (other) =>
          other.length > anchor.length &&
          other.endsWith(anchor) &&
          /[\s_/-]/.test(other.charAt(other.length - anchor.length - 1)),
      ),
  );
}

const FILE_EXT = /\.(?:png|jpe?g|webp|gif|pdf)$/i;

function stepLines(text: string): string[] {
  const steps: string[] = [];
  let inSteps = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^(?:#{1,6}\s+|\*\*)?steps\b/i.test(trimmed) && trimmed.length < 40) {
      inSteps = true;
      continue;
    }
    if (!inSteps) {
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      const step = bullet[1].trim();
      if (step.length > 0 && step.length <= 240 && steps.length < 12) {
        steps.push(step);
      }
      continue;
    }
    if (trimmed === '') {
      continue;
    }
    break;
  }
  return steps;
}

function sourceMaterial(input: {
  prompt?: string;
  chunks: Array<{ text?: string }>;
  decisions: Array<{ title?: string; content?: string; quote?: string }>;
}): string {
  return [
    input.prompt ?? '',
    ...input.chunks.map((chunk) => chunk.text ?? ''),
    ...input.decisions.flatMap((decision) => [decision.title ?? '', decision.content ?? '', decision.quote ?? '']),
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n');
}

function restatesRule(constraint: string, rules: Rule[]): boolean {
  const constraintWords = new Set(words(constraint));
  if (constraintWords.size < 2) {
    return false;
  }
  return rules.some((rule) => {
    const ruleWords = new Set(words(`${rule.title} ${rule.body}`));
    const shared = [...constraintWords].filter((word) => ruleWords.has(word)).length;
    if (constraintWords.size >= 4 && shared / constraintWords.size >= 0.6) {
      return true;
    }
    if (constraintWords.size < 4 && shared === constraintWords.size) {
      return true;
    }
    const titleWords = words(rule.title);
    if (titleWords.length >= 3 && titleWords.every((word) => constraintWords.has(word))) {
      return true;
    }
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
