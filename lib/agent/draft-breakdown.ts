import type { RetrievedDecision } from '../search-decisions.js';
import type { Repo } from '../lookup.js';
import { breakdownTicketId, renderBreakdown, type BreakdownRow } from '../breakdown.js';
import type { AnswerResult, RetrievedChunk } from './answer.js';

export const TICKET_TEMPLATE_ID = 'ticket';

const CUT_OFF = 'The model reply was cut off.';
const UNPARSED = 'The model reply could not be parsed.';
const DECISION_SEARCH_FAILED = 'Decision search failed.';
const DOCUMENT_SEARCH_FAILED = 'Document search failed.';

export async function draftBreakdown(input: {
  project: string;
  page: string;
  readPage: (key: string) => Promise<string | undefined>;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  searchDecisions: (query: { prompt: string; project: string }) => Promise<RetrievedDecision[]>;
  loadRepos: (project: string) => Promise<Repo[]>;
  loadTemplate: (project: string) => Promise<string | undefined>;
  complete: (query: {
    project: string;
    page: string;
    pageText: string;
    chunks: RetrievedChunk[];
    decisions: RetrievedDecision[];
    repos: Repo[];
    template?: string;
  }) => Promise<{ text: string; cutOff: boolean }>;
  put: (rows: BreakdownRow[]) => Promise<void>;
  breakdownId: string;
  createdAt: string;
}): Promise<AnswerResult> {
  const raw = await input.readPage(input.page);
  if (raw === undefined) {
    return storeRefusal(input, `No object at ${input.page}.`);
  }
  if (!raw.trim()) {
    return storeRefusal(input, 'The page is empty.');
  }
  const searchQuery = breakdownSearchQuery(raw);
  const [reposResult, decisionsResult, chunksResult, templateResult] = await Promise.all([
    settle(input.loadRepos(input.project)),
    settle(input.searchDecisions({ prompt: searchQuery, project: input.project })),
    settle(input.retrieve({ prompt: searchQuery, project: input.project })),
    settle(loadTemplate(input)),
  ]);
  if (reposResult.status === 'rejected') {
    console.error(reposResult.reason);
    return storeRefusal(input, 'The repo map failed to load.');
  }
  if (reposResult.value.length === 0) {
    return storeRefusal(input, 'The repo map is empty.');
  }
  if (decisionsResult.status === 'rejected') {
    console.error(decisionsResult.reason);
    return { response: DECISION_SEARCH_FAILED, status: 'error' };
  }
  if (chunksResult.status === 'rejected') {
    console.error(chunksResult.reason);
    return { response: DOCUMENT_SEARCH_FAILED, status: 'error' };
  }
  if (templateResult.status === 'rejected') {
    throw templateResult.reason;
  }
  const template = templateResult.value;
  const reply = await input.complete({
    project: input.project,
    page: input.page,
    pageText: raw,
    chunks: chunksResult.value.filter((chunk) => !chunkIsPage(chunk.uri, input.page)),
    decisions: decisionsResult.value,
    repos: reposResult.value,
    ...(template ? { template } : {}),
  });
  if (reply.cutOff) {
    return { response: CUT_OFF, status: 'error' };
  }
  const parsed = parseBreakdownReply(reply.text);
  if (parsed.kind === 'unparsed') {
    return { response: UNPARSED, status: 'error' };
  }
  const rows =
    parsed.kind === 'refusal'
      ? [row(input, 'refusal', 0, parsed.reasons)]
      : [
          row(input, 'epic', 0, parsed.epic),
          ...parsed.stories.map((body, index) => row(input, 'story', index + 1, body)),
        ];
  await input.put(rows);
  const refused = rows.length === 1 && rows[0].kind === 'refusal';
  return {
    response: renderBreakdown(rows),
    status: refused ? 'refused' : 'success',
    breakdownId: input.breakdownId,
  };
}

export const BREAKDOWN_SYSTEM_PROMPT =
  'You draft a Jira epic and its stories from one page. Return JSON only, not the combined document. If you can split the page, return {"epic":"","stories":[""]}. Each value is one ticket in markdown and starts with a heading. stories may be empty. There is no story-count cap. If you can read the page but cannot split it, return {"reasons":"why"}. That is a finished refusal. Use only the page, the template, the decisions, the other documents, and the repos provided. A knowledge-base chunk of this same page is not the page. Decisions overrule the page. Project decisions beat global decisions. Repo names come from the repo map only. Do not invent a repo. A module path in a story is a claim taken from the page, a decision, or a repo summary. Each ticket says the repo was not opened. Do not open a repo. When a template is provided, fill that one template for the epic and for every story. The body is the filled ticket. When no template is provided, follow ordinary Jira practice. Do not invent a template.';

async function loadTemplate(input: {
  project: string;
  loadTemplate: (project: string) => Promise<string | undefined>;
}): Promise<string | undefined> {
  const projectTemplate = await input.loadTemplate(input.project);
  if (projectTemplate?.trim()) {
    return projectTemplate;
  }
  if (input.project === 'global') {
    return undefined;
  }
  const globalTemplate = await input.loadTemplate('global');
  return globalTemplate?.trim() ? globalTemplate : undefined;
}

async function storeRefusal(
  input: {
    project: string;
    page: string;
    put: (rows: BreakdownRow[]) => Promise<void>;
    breakdownId: string;
    createdAt: string;
  },
  reason: string,
): Promise<AnswerResult> {
  const rows = [row(input, 'refusal', 0, reason)];
  await input.put(rows);
  return { response: renderBreakdown(rows), status: 'refused', breakdownId: input.breakdownId };
}

function row(
  input: { project: string; page: string; breakdownId: string; createdAt: string },
  kind: BreakdownRow['kind'],
  ordinal: number,
  body: string,
): BreakdownRow {
  const shared = {
    project: input.project,
    ticketId: breakdownTicketId(input.breakdownId, ordinal),
    breakdownId: input.breakdownId,
    ordinal,
    body,
    createdAt: input.createdAt,
  };
  if (kind === 'story') {
    return { ...shared, kind };
  }
  return { ...shared, kind, page: input.page };
}

export function breakdownSearchQuery(pageText: string): string {
  const lines = pageText.split(/\r?\n/);
  for (const line of lines) {
    const heading = /^#{1,6}\s+(\S.*?)\s*#*$/.exec(line.trim());
    if (heading) {
      return heading[1].trim();
    }
  }
  for (const line of lines) {
    const text = line.trim();
    if (text) {
      return text;
    }
  }
  return pageText.trim();
}

function chunkIsPage(uri: string | undefined, page: string): boolean {
  return uri === page || (uri?.endsWith(`/${page}`) ?? false);
}

function parseBreakdownReply(
  text: string,
): { kind: 'refusal'; reasons: string } | { kind: 'tickets'; epic: string; stories: string[] } | { kind: 'unparsed' } {
  const value = parseJsonObject(text);
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unparsed' };
  }
  const record = value as Record<string, unknown>;
  const hasReasons = Object.prototype.hasOwnProperty.call(record, 'reasons');
  const hasEpic = Object.prototype.hasOwnProperty.call(record, 'epic');
  const hasStories = Object.prototype.hasOwnProperty.call(record, 'stories');
  if (hasReasons) {
    if (hasEpic || hasStories) {
      return { kind: 'unparsed' };
    }
    const reasons = markdownBody(record.reasons);
    return reasons ? { kind: 'refusal', reasons } : { kind: 'unparsed' };
  }
  const epic = markdownBody(record.epic);
  if (!hasEpic || !hasStories || !epic || !Array.isArray(record.stories)) {
    return { kind: 'unparsed' };
  }
  const stories: string[] = [];
  for (const story of record.stories) {
    const body = markdownBody(story);
    if (!body) {
      return { kind: 'unparsed' };
    }
    stories.push(body);
  }
  return { kind: 'tickets', epic, stories };
}

function markdownBody(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  return value;
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

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}
