import { randomUUID } from 'node:crypto';
import { projectRetrieveFilter } from '../project-filter.js';
import { estimateSdlcRun } from '../sdlc-run.js';
import type { RetrievedDecision } from '../search-decisions.js';
import { isDocumentsPageKey, isTicketKey } from '../ticket.js';
import type { DraftResponseFormat } from '../work-order.js';

export type { RetrievedDecision };

export type RetrievedChunk = {
  text: string;
  uri?: string;
};

export type AnswerStatus = 'success' | 'error' | 'refused';

export type AnswerModelCompletion = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt: string;
};

export type ReadinessModelCompletion = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  finishedAt: string;
};

export class AnswerModelUsageError extends Error {
  constructor() {
    super('answer model response is missing token counts');
    this.name = 'AnswerModelUsageError';
  }
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function readinessCompletionFromModel(input: {
  text: string;
  model: string;
  usage: { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  startedAt: string;
  finishedAt: string;
}): ReadinessModelCompletion {
  const inputTokens = input.usage?.input_tokens;
  const outputTokens = input.usage?.output_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    throw new AnswerModelUsageError();
  }
  return {
    text: input.text,
    model: input.model,
    inputTokens,
    outputTokens,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
}

export type CheckReadinessRun = {
  project: string;
  runId: string;
  step: 'check-readiness';
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  startedAt: string;
  finishedAt: string;
  status: AnswerStatus;
};

export type AnswerRun = {
  project: string;
  runId: string;
  step: 'answer';
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  startedAt: string;
  finishedAt: string;
  status: AnswerStatus;
};

export type AnswerResult = {
  response: string;
  status: AnswerStatus;
  breakdownId?: string;
};

export type InvokeSkill = 'check-readiness' | 'draft-work-order' | 'draft-breakdown';

export function parseInvokePayload(
  raw: unknown,
):
  | { project: string; prompt?: string; skill?: Exclude<InvokeSkill, 'draft-breakdown'>; format?: DraftResponseFormat; ticket?: string }
  | { project: string; skill: 'draft-breakdown'; page: string }
  | { project: string; draftId: string; format?: DraftResponseFormat }
  | { project: string; breakdownId: string }
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
    breakdownId?: unknown;
    ticket?: unknown;
    page?: unknown;
  };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  const draftId = typeof body.draftId === 'string' ? body.draftId.trim() : '';
  const breakdownId = typeof body.breakdownId === 'string' ? body.breakdownId.trim() : '';
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
  if (breakdownId) {
    return (
      rejectIfSet(
        'breakdownId fetches a stored breakdown. Omit prompt, skill, page, ticket, draftId, and format.',
        [prompt, body.skill, body.page, ticket, draftId, format],
      ) ?? { project, breakdownId }
    );
  }
  if (draftId) {
    return (
      rejectIfSet('draftId fetches a stored draft. Omit prompt, skill, page, and ticket.', [
        prompt,
        body.skill,
        body.page,
        ticket,
      ]) ?? {
        project,
        draftId,
        ...(format ? { format } : {}),
      }
    );
  }
  if (body.page !== undefined && body.page !== '' && typeof body.page !== 'string') {
    return { response: 'Name a page.', status: 'error' };
  }
  const page = typeof body.page === 'string' ? body.page.trim() : '';
  if (
    body.skill !== undefined &&
    body.skill !== '' &&
    body.skill !== 'check-readiness' &&
    body.skill !== 'draft-work-order' &&
    body.skill !== 'draft-breakdown'
  ) {
    return { response: 'skill must be check-readiness, draft-work-order, or draft-breakdown when set.', status: 'error' };
  }
  if (body.skill === 'draft-breakdown' || page) {
    if (body.skill !== 'draft-breakdown') {
      return { response: 'page is only valid with skill draft-breakdown.', status: 'error' };
    }
    if (!page) {
      return { response: 'Name a page.', status: 'error' };
    }
    if (!isDocumentsPageKey(project, page)) {
      return { response: 'Name a page in this project.', status: 'error' };
    }
    return (
      rejectIfSet('draft-breakdown reads one page. Omit prompt, ticket, draftId, breakdownId, and format.', [
        prompt,
        ticket,
        draftId,
        breakdownId,
        format,
      ]) ?? { project, skill: 'draft-breakdown', page }
    );
  }
  if (!prompt && !ticket) {
    return { response: 'Ask a question in prompt, or name a ticket.', status: 'error' };
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

function rejectIfSet(response: string, values: unknown[]): AnswerResult | undefined {
  if (values.some((value) => value !== undefined && value !== '')) {
    return { response, status: 'error' };
  }
  return undefined;
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

export function answerCompletionFromModel(input: {
  text: string;
  model: string;
  usage: { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  startedAt: string;
  finishedAt: string;
}): AnswerModelCompletion {
  const inputTokens = input.usage?.input_tokens;
  const outputTokens = input.usage?.output_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) {
    throw new AnswerModelUsageError();
  }
  return {
    text: input.text,
    model: input.model,
    inputTokens,
    outputTokens,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  };
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
  }) => Promise<string | AnswerModelCompletion>;
  putRun: (row: AnswerRun) => Promise<void>;
}): Promise<AnswerResult> {
  const chunksPromise = input.ticketDocument
    ? Promise.resolve([input.ticketDocument])
    : input.retrieve({ prompt: input.prompt, project: input.project });
  const decisions = await input.searchDecisions({ prompt: input.prompt, project: input.project }).catch((error) => {
    console.error(error);
    return [];
  });
  const chunks = await chunksPromise;
  let completed: string | AnswerModelCompletion;
  try {
    completed = await input.complete({
      prompt: input.prompt,
      project: input.project,
      chunks,
      decisions,
    });
  } catch (error) {
    if (error instanceof AnswerModelUsageError) {
      return { response: 'The answer model returned no token counts.', status: 'error' };
    }
    throw error;
  }
  const text = typeof completed === 'string' ? completed : completed.text;
  const usage = typeof completed === 'string' ? undefined : completed;
  const status: AnswerStatus = 'success';
  await recordAnswerRun(input, usage, status);
  return { response: text, status };
}

async function recordAnswerRun(
  input: { project: string; putRun: (row: AnswerRun) => Promise<void> },
  usage: AnswerModelCompletion | undefined,
  status: AnswerStatus,
): Promise<void> {
  if (usage === undefined) {
    return;
  }
  const priced = estimateSdlcRun({
    modelId: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
  if (!('estimatedUsd' in priced)) {
    return;
  }
  try {
    await input.putRun({
      project: input.project,
      runId: randomUUID(),
      step: 'answer',
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedUsd: priced.estimatedUsd,
      startedAt: usage.startedAt,
      finishedAt: usage.finishedAt,
      status,
    });
  } catch (error) {
    console.error(error);
  }
}

export function retrievalFilterFor(project: string): ReturnType<typeof projectRetrieveFilter> {
  return projectRetrieveFilter(project);
}
