import type { Repo, Rule } from './lookup.js';
import type { RetrievedDecision } from './search-decisions.js';

export type WorkOrderRepo = {
  owner: string;
  repo: string;
  paths?: string[];
};

export const RULE_PRECEDENCE =
  'Where the code this change writes would break a rule, follow the rule. Do not widen the diff to fix other violations. On a policy conflict, the order wins. Do not stop to confirm a conflict this order already settles. A named fact that is absent, or a different value in the repo for a fact this order names, is a failed premise. Do not invent a replacement or copy the repo. A count, metric, log backend, or filename with no outcome means stop and ask. An acceptance line that needs a running environment, credentials, a third-party page, or production data is human-verified, even when the line does not say so. A test that runs in the checkout stays for the agent. Global rules always apply. A client rule may add but cannot drop a global rule. Rules override constraints.';

export type PremiseIfFalse = 'stop' | 'omit';

export type WorkOrderPremise = {
  claim: string;
  ifFalse: PremiseIfFalse;
};

export type WorkOrder = {
  intent: string;
  summary: string;
  repos: WorkOrderRepo[];
  constraints: string[];
  acceptance: string[];
  consequences?: string[];
  premises?: WorkOrderPremise[];
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
  lines.push('', workOrder.rulePrecedence);
  const fileLines = linesBesideFiles(workOrder);
  if (fileLines.length > 0) {
    lines.push('', 'In the files this change writes:', '', ...fileLines.map((line) => `- ${oneLine(line)}`));
  }
  const premises = workOrder.premises ?? [];
  if (premises.length > 0) {
    lines.push('', '## Verify before building', '', ...premises.map(premiseLine));
  }
  if (readable.constraints.length > 0) {
    lines.push('', '## Constraints', '', ...readable.constraints.map((line) => `- ${oneLine(line)}`));
  }
  const acceptance = acceptanceLines(readable.acceptance);
  if (acceptance.length > 0) {
    lines.push('', '## Acceptance', '', ...acceptance.map((line) => `- ${oneLine(line)}`));
  }
  lines.push(...ruleSections(workOrder.rules, workOrder.rulePrecedence));
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
  const consequences = parseConsequences(body.consequences);
  const premises = parsePremises(body.premises);
  const workOrder = retainDraftFacts(
    {
      intent,
      summary,
      repos,
      constraints,
      acceptance,
      ...(consequences.length > 0 ? { consequences } : {}),
      ...(premises.length > 0 ? { premises } : {}),
      rules: input.rules,
      rulePrecedence: RULE_PRECEDENCE,
      project: input.project,
    },
    groundingSource(input, repos),
    input.prompt ?? '',
    acceptanceWords(input, repos),
  );
  return { ok: true, workOrder, citations };
}

function linesBesideFiles(workOrder: WorkOrder): string[] {
  const consequences = workOrder.consequences ?? [];
  const uncovered = workOrder.rules.flatMap((rule) => {
    const title = rule.title.trim();
    if (!title || consequences.some((line) => restatesRule(line, [rule]))) {
      return [];
    }
    return [title];
  });
  return [...consequences, ...uncovered];
}

function premiseLine(premise: WorkOrderPremise): string {
  const claim = oneLine(premise.claim).replace(/[.?!]+$/, '');
  const outcome =
    premise.ifFalse === 'omit'
      ? 'If this is false, omit it and say so in the pull request.'
      : stopsOnlyItsStep(claim)
        ? 'If this is false, stop that step and ask. Other steps do not wait.'
        : 'If this is false, stop and ask.';
  return `- ${claim}. ${outcome}`;
}

function stopsOnlyItsStep(claim: string): boolean {
  return /\/|\b[\w.-]+\.[a-z][a-z0-9]{0,4}\b|\bdockerfile\b/i.test(claim);
}

function acceptanceLines(acceptance: string[]): string[] {
  return acceptance.map(markHumanVerified);
}

function markHumanVerified(line: string): string {
  const text = oneLine(line);
  if (/human-verified/i.test(text) || !needsHuman(text)) {
    return text;
  }
  return `${text.replace(/\.+$/, '')}. human-verified, not agent-verified`;
}

function needsHuman(line: string): boolean {
  return /\b(environments?|deploy(?:ed|ing)?|running|sign(?:ed)?[- ]off|production|credentials?|destroy(?:ed|ing)?)\b/i.test(line);
}

function repoLine(repo: WorkOrderRepo): string {
  const label = `${oneLine(repo.owner)}/${oneLine(repo.repo)}`;
  const paths = repo.paths?.map(oneLine).filter((path) => path.length > 0);
  return paths && paths.length > 0 ? `- ${label} (${paths.join(', ')})` : `- ${label}`;
}

function ruleSections(rules: Rule[], precedence: string): string[] {
  const globalRules = rules.filter((rule) => rule.project.trim() === 'global');
  const clientProjects: string[] = [];
  const clientRules = new Map<string, Rule[]>();
  for (const rule of rules) {
    const project = rule.project.trim();
    if (project === 'global') {
      continue;
    }
    const group = clientRules.get(project);
    if (group) {
      group.push(rule);
      continue;
    }
    clientProjects.push(project);
    clientRules.set(project, [rule]);
  }
  const lines = ['', '## Global rules', '', precedence];
  if (globalRules.length > 0) {
    lines.push('', ...ruleBlocks(globalRules));
  }
  for (const project of clientProjects) {
    lines.push('', `## ${oneLine(project)} rules`, '', ...ruleBlocks(clientRules.get(project) ?? []));
  }
  return lines;
}

function ruleBlocks(rules: Rule[]): string[] {
  return rules.flatMap((rule, index) => {
    const block = [`### ${oneLine(rule.title)}`, '', safeBlock(rule.body)];
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

function retainDraftFacts(
  workOrder: WorkOrder,
  source: string,
  anchorsFrom: string,
  acceptanceSource: Set<string>,
): WorkOrder {
  const readable = withoutRestatedRules(workOrder);
  const sourceWords = new Set(words(source));
  const summaryText = withoutUngroundedPhrases(readable.summary || workOrder.summary, sourceWords);
  const constraints = readable.constraints.flatMap((line) => {
    const next = withoutUngroundedPhrases(line, sourceWords);
    return next ? [next] : [];
  });
  const acceptance = workOrder.acceptance.flatMap((line) => {
    const kept = acceptanceLine(line, workOrder.rules, acceptanceSource);
    if (!kept) {
      return [];
    }
    const next = withoutUngroundedPhrases(kept, acceptanceSource);
    return next ? [next] : [];
  });
  const summary = appendMissingAnchors(
    summaryText,
    anchorsFrom,
    [workOrder.intent, summaryText, ...constraints, ...acceptance].join('\n'),
  );
  return {
    ...workOrder,
    summary,
    constraints,
    acceptance,
  };
}

const PREP = new Set(['in', 'via', 'using', 'through']);
const FILE_EXT = /\.(?:png|jpe?g|webp|gif|pdf)$/i;

function withoutUngroundedPhrases(text: string, sourceWords: Set<string>): string {
  const tokens = text.match(/\s+|[^\s]+/g) ?? [];
  const drop = tokens.map(() => false);
  for (let i = 0; i < tokens.length; i++) {
    if (isSkippable(tokens[i])) {
      continue;
    }
    if (PREP.has(coreOf(tokens[i]).toLowerCase())) {
      markPrep(tokens, drop, sourceWords, i);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!drop[i] && !isSkippable(tokens[i]) && coreOf(tokens[i]).toLowerCase() === 'or') {
      markAlternative(tokens, drop, sourceWords, i);
    }
  }
  return tidyPhrase(tokens.map((token, index) => (drop[index] ? keptPunct(token) : token)).join(''));
}

function markPrep(tokens: string[], drop: boolean[], sourceWords: Set<string>, start: number): void {
  let content = 0;
  let sawSame = false;
  let last = start;
  for (let i = start + 1; i < tokens.length; i++) {
    if (/^\s+$/.test(tokens[i]) || isAtomic(tokens[i])) {
      if (isAtomic(tokens[i])) {
        break;
      }
      continue;
    }
    if (coreOf(tokens[i]).length === 0) {
      break;
    }
    const core = coreOf(tokens[i]).toLowerCase();
    if ((core === 'for' || core === 'to') && content > 0) {
      break;
    }
    if (core === 'same') {
      sawSame = true;
    }
    const contentWords = words(core);
    if (contentWords.length === 0) {
      continue;
    }
    if (contentWords.some((word) => sourceWords.has(word))) {
      break;
    }
    content += contentWords.length;
    last = i;
  }
  if (content < 2 && !(content === 1 && sawSame)) {
    return;
  }
  for (let i = start; i <= last; i++) {
    drop[i] = true;
  }
  if (sawSame) {
    const previous = previousContent(tokens, start);
    if (previous !== undefined && ungroundedContent(tokens[previous], sourceWords)) {
      drop[previous] = true;
    }
  }
}

function markAlternative(tokens: string[], drop: boolean[], sourceWords: Set<string>, orAt: number): void {
  const left = ungroundedSide(tokens, orAt, -1, sourceWords);
  const right = ungroundedSide(tokens, orAt, 1, sourceWords);
  if (!left && !right) {
    return;
  }
  for (const side of [left, right]) {
    if (!side) {
      continue;
    }
    for (let i = side.from; i <= side.to; i++) {
      drop[i] = true;
    }
  }
  drop[orAt] = true;
}

function ungroundedSide(
  tokens: string[],
  orAt: number,
  direction: -1 | 1,
  sourceWords: Set<string>,
): { from: number; to: number } | undefined {
  let content = 0;
  let from = orAt;
  let to = orAt;
  for (let i = orAt + direction; i >= 0 && i < tokens.length; i += direction) {
    if (/^\s+$/.test(tokens[i])) {
      continue;
    }
    if (isAtomic(tokens[i]) || coreOf(tokens[i]).length === 0) {
      break;
    }
    const core = coreOf(tokens[i]).toLowerCase();
    if (core === 'or' || PREP.has(core) || core === 'for' || core === 'to') {
      break;
    }
    const contentWords = words(core);
    if (contentWords.length === 0) {
      if (direction < 0) {
        from = i;
      } else {
        to = i;
      }
      continue;
    }
    if (contentWords.some((word) => sourceWords.has(word))) {
      break;
    }
    content += contentWords.length;
    if (direction < 0) {
      from = i;
    } else {
      to = i;
    }
  }
  if (content < 2) {
    return undefined;
  }
  return direction < 0 ? { from, to: orAt - 1 } : { from: orAt + 1, to };
}

function coreOf(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function isAtomic(token: string): boolean {
  return /:\/\//.test(token) || FILE_EXT.test(token);
}

function tidyPhrase(text: string): string {
  return text
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+([,;!?])/g, '$1')
    .replace(/\s+\.(?![A-Za-z0-9./])/g, '.')
    .replace(/^[ \t]*[,;]\s*/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function previousContent(tokens: string[], start: number): number | undefined {
  for (let i = start - 1; i >= 0; i--) {
    if (/^\s+$/.test(tokens[i])) {
      continue;
    }
    if (isAtomic(tokens[i]) || coreOf(tokens[i]).length === 0) {
      return undefined;
    }
    if (words(coreOf(tokens[i])).length === 0) {
      continue;
    }
    return i;
  }
  return undefined;
}

function ungroundedContent(token: string, sourceWords: Set<string>): boolean {
  const contentWords = words(coreOf(token));
  return contentWords.length > 0 && contentWords.every((word) => !sourceWords.has(word));
}

function isSkippable(token: string): boolean {
  return /^\s+$/.test(token) || isAtomic(token);
}

function keptPunct(token: string): string {
  return token.match(/[)\]\.!?][^A-Za-z0-9]*$/)?.[0] ?? '';
}

function withoutRestatedRules(workOrder: WorkOrder): { summary: string; constraints: string[]; acceptance: string[] } {
  return {
    summary: proseWithoutRules(workOrder.summary, workOrder.rules),
    constraints: workOrder.constraints.flatMap((line) => {
      const kept = bulletWithoutRules(line, workOrder.rules);
      return kept ? [kept] : [];
    }),
    acceptance: workOrder.acceptance,
  };
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

function appendMissingAnchors(summary: string, source: string, haystack: string): string {
  let seen = haystack;
  const present = urlKeys(haystack);
  const missing: string[] = [];
  for (const anchor of sourceAnchors(source)) {
    const canonical = canonicalUrl(anchor);
    if (seen.includes(anchor) || seen.includes(canonical) || present.has(canonical)) {
      continue;
    }
    missing.push(anchor);
    seen = `${seen}\n${anchor}`;
    present.add(canonical);
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
  addUrls(text, add);
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

function addUrls(text: string, add: (value: string) => void): void {
  const own = ownAddress(text);
  const accept = (value: string) => {
    if (own && sameAddress(value, own)) {
      return;
    }
    add(value);
  };
  for (const match of text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) {
    accept(match[1]);
  }
  for (const line of text.split(/\r?\n/)) {
    const closer = line.indexOf('](');
    for (const match of line.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
      const index = match.index ?? 0;
      if (closer !== -1 && index < closer && line.lastIndexOf('[', index) !== -1) {
        continue;
      }
      accept(match[0].replace(/[.,;:]+$/, ''));
    }
  }
}

function ownAddress(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/\bURL:\**\s*(https?:\/\/\S+)/i);
    if (match) {
      return match[1].replace(/[.,;:]+$/, '');
    }
  }
  return undefined;
}

function sameAddress(left: string, right: string): boolean {
  const normalize = (url: string) => canonicalUrl(url).replace(/\/+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

function canonicalUrl(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function urlKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>)\]]+/g)) {
    keys.add(canonicalUrl(match[0].replace(/[.,;:]+$/, '')));
  }
  return keys;
}

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

function groundingSource(input: { prompt?: string; project: string }, repos: WorkOrderRepo[]): string {
  return [input.prompt ?? '', input.project, ...repos.flatMap((repo) => [repo.owner, repo.repo, ...(repo.paths ?? [])])].join(
    '\n',
  );
}

function acceptanceWords(
  input: {
    prompt?: string;
    project: string;
    decisions: Array<{ title?: string; content?: string; quote?: string }>;
    chunks: Array<{ text?: string }>;
  },
  repos: WorkOrderRepo[],
): Set<string> {
  return new Set(
    words(
      [
        groundingSource(input, repos),
        ...input.decisions.flatMap((decision) => [decision.title ?? '', decision.content ?? '', decision.quote ?? '']),
        ...input.chunks.map((chunk) => chunk.text ?? ''),
      ].join('\n'),
    ),
  );
}

function acceptanceLine(line: string, rules: Rule[], sourceWords: Set<string>): string | undefined {
  const parts = line
    .split(/\s*(?:—|;)\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const fromSource = (part: string) => !restatesRule(part, rules) || lineFromSource(part, sourceWords);
  if (parts.length < 2) {
    return fromSource(line) ? line : undefined;
  }
  const kept = parts.filter(fromSource);
  if (kept.length === 0 || (kept.length === parts.length && restatesRule(line, rules) && !lineFromSource(line, sourceWords))) {
    return undefined;
  }
  if (kept.length === parts.length) {
    return line;
  }
  return kept.join('; ');
}

function lineFromSource(line: string, sourceWords: Set<string>): boolean {
  const lineWords = words(line);
  if (lineWords.length === 0) {
    return false;
  }
  const shared = lineWords.filter((word) => sourceWords.has(word));
  return shared.length / lineWords.length >= 0.6;
}

function restatesRule(constraint: string, rules: Rule[]): boolean {
  const constraintWords = new Set(words(constraint));
  if (constraintWords.size < 2) {
    return false;
  }
  return rules.some((rule) => {
    const ruleWords = new Set(words(`${rule.title} ${rule.body}`));
    const sharedWords = [...constraintWords].filter((word) => ruleWords.has(word));
    if (constraintWords.size >= 4 && sharedWords.length / constraintWords.size >= 0.6) {
      return true;
    }
    if (constraintWords.size < 4 && sharedWords.length === constraintWords.size) {
      return true;
    }
    if (constraintWords.size === 3 && sharedWords.length >= 2 && sharedWords.some((word) => word.length >= 8)) {
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

function parseConsequences(value: unknown): string[] {
  return stringList(value);
}

function parsePremises(value: unknown): WorkOrderPremise[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const premises: WorkOrderPremise[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const claim = nonEmptyString((item as { claim?: unknown }).claim);
    if (!claim) {
      continue;
    }
    const ifFalse = (item as { ifFalse?: unknown }).ifFalse;
    premises.push({ claim, ifFalse: ifFalse === 'omit' ? 'omit' : 'stop' });
  }
  return premises;
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
