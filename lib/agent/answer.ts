import { projectRetrieveFilter } from '../project-filter.js';
import type { RetrievedDecision } from '../search-decisions.js';
import { isTicketKey } from '../ticket.js';
import type { DraftResponseFormat } from '../work-order.js';

export type { RetrievedDecision };

export type RetrievedChunk = {
  text: string;
  uri?: string;
};

export type AnswerStatus = 'success' | 'error';

export type AnswerResult = {
  response: string;
  status: AnswerStatus;
};

export type InvokeSkill = 'check-readiness' | 'draft-work-order';

export function parseInvokePayload(
  raw: unknown,
):
  | { project: string; prompt?: string; skill?: InvokeSkill; format?: DraftResponseFormat; ticket?: string }
  | { project: string; draftId: string; format?: DraftResponseFormat }
  | AnswerResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { response: 'Send JSON with prompt and project.', status: 'error' };
  }
  const body = raw as {
    prompt?: unknown;
    project?: unknown;
    skill?: unknown;
    format?: unknown;
    draftId?: unknown;
    ticket?: unknown;
  };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  const draftId = typeof body.draftId === 'string' ? body.draftId.trim() : '';
  if (body.ticket !== undefined && body.ticket !== '' && typeof body.ticket !== 'string') {
    return { response: 'Name a ticket key.', status: 'error' };
  }
  const ticket = typeof body.ticket === 'string' ? body.ticket.trim() : '';
  if (ticket && !isTicketKey(ticket)) {
    return { response: 'Name a ticket key.', status: 'error' };
  }
  if (!project) {
    return { response: 'Name a project. The agent will not search without one.', status: 'error' };
  }
  const format = parseFormat(body.format);
  if (typeof format !== 'string' && format !== undefined) {
    return format;
  }
  if (draftId) {
    if (prompt || ticket || (body.skill !== undefined && body.skill !== '')) {
      return { response: 'draftId fetches a stored draft. Omit prompt, skill, and ticket.', status: 'error' };
    }
    return format ? { project, draftId, format } : { project, draftId };
  }
  if (!prompt && !ticket) {
    return { response: 'Ask a question in prompt, or name a ticket.', status: 'error' };
  }
  if (
    body.skill !== undefined &&
    body.skill !== '' &&
    body.skill !== 'check-readiness' &&
    body.skill !== 'draft-work-order'
  ) {
    return { response: 'skill must be check-readiness or draft-work-order when set.', status: 'error' };
  }
  const skill = body.skill === 'check-readiness' || body.skill === 'draft-work-order' ? body.skill : undefined;
  if (format === undefined) {
    if (skill && ticket && prompt) {
      return { prompt, project, skill, ticket };
    }
    if (skill && ticket) {
      return { project, skill, ticket };
    }
    if (skill) {
      return { prompt, project, skill };
    }
    if (ticket && prompt) {
      return { prompt, project, ticket };
    }
    if (ticket) {
      return { project, ticket };
    }
    return { prompt, project };
  }
  if (skill !== 'draft-work-order') {
    return { response: 'format is only valid with skill draft-work-order.', status: 'error' };
  }
  if (ticket && prompt) {
    return { prompt, project, skill, format, ticket };
  }
  if (ticket) {
    return { project, skill, format, ticket };
  }
  return { prompt, project, skill, format };
}

function parseFormat(value: unknown): DraftResponseFormat | undefined | AnswerResult {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return { response: 'format must be json or markdown when set.', status: 'error' };
  }
  const format = value.trim();
  if (format === '') {
    return undefined;
  }
  if (format !== 'json' && format !== 'markdown') {
    return { response: 'format must be json or markdown when set.', status: 'error' };
  }
  return format;
}

export async function answerFromMemory(input: {
  prompt: string;
  project: string;
  ticketDocument?: RetrievedChunk;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  searchDecisions: (query: { prompt: string; project: string }) => Promise<RetrievedDecision[]>;
  complete: (query: {
    prompt: string;
    project: string;
    chunks: RetrievedChunk[];
    decisions: RetrievedDecision[];
  }) => Promise<string>;
}): Promise<AnswerResult> {
  const chunksPromise = input.ticketDocument
    ? Promise.resolve([input.ticketDocument])
    : input.retrieve({ prompt: input.prompt, project: input.project });
  const decisions = await input.searchDecisions({ prompt: input.prompt, project: input.project }).catch((error) => {
    console.error(error);
    return [];
  });
  const chunks = await chunksPromise;
  const response = await input.complete({
    prompt: input.prompt,
    project: input.project,
    chunks,
    decisions,
  });
  return { response, status: 'success' };
}

export function retrievalFilterFor(project: string): ReturnType<typeof projectRetrieveFilter> {
  return projectRetrieveFilter(project);
}
