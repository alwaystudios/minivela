import { projectRetrieveFilter } from '../project-filter.js';
import type { RetrievedDecision } from '../search-decisions.js';
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
): { prompt: string; project: string; skill?: InvokeSkill; format?: DraftResponseFormat } | AnswerResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { response: 'Send JSON with prompt and project.', status: 'error' };
  }
  const body = raw as { prompt?: unknown; project?: unknown; skill?: unknown; format?: unknown };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  if (!project) {
    return { response: 'Name a project. The agent will not search without one.', status: 'error' };
  }
  if (!prompt) {
    return { response: 'Ask a question in prompt.', status: 'error' };
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
  if (body.format === undefined || body.format === '') {
    return skill ? { prompt, project, skill } : { prompt, project };
  }
  if (body.format !== 'json' && body.format !== 'markdown') {
    return { response: 'format must be json or markdown when set.', status: 'error' };
  }
  if (skill !== 'draft-work-order') {
    return { response: 'format is only valid with skill draft-work-order.', status: 'error' };
  }
  return { prompt, project, skill, format: body.format };
}

export async function answerFromMemory(input: {
  prompt: string;
  project: string;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  searchDecisions: (query: { prompt: string; project: string }) => Promise<RetrievedDecision[]>;
  complete: (query: {
    prompt: string;
    project: string;
    chunks: RetrievedChunk[];
    decisions: RetrievedDecision[];
  }) => Promise<string>;
}): Promise<AnswerResult> {
  const chunksPromise = input.retrieve({ prompt: input.prompt, project: input.project });
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
