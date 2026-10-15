import { projectRetrieveFilter } from '../project-filter.js';

export type RetrievedChunk = {
  text: string;
  uri?: string;
};

export type AnswerStatus = 'success' | 'error';

export type AnswerResult = {
  response: string;
  status: AnswerStatus;
};

export function parseInvokePayload(raw: unknown): { prompt: string; project: string } | AnswerResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { response: 'Send JSON with prompt and project.', status: 'error' };
  }
  const body = raw as { prompt?: unknown; project?: unknown };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const project = typeof body.project === 'string' ? body.project.trim() : '';
  if (!project) {
    return { response: 'Name a project. The agent will not search without one.', status: 'error' };
  }
  if (!prompt) {
    return { response: 'Ask a question in prompt.', status: 'error' };
  }
  return { prompt, project };
}

export async function answerFromDocuments(input: {
  prompt: string;
  project: string;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  complete: (query: { prompt: string; project: string; chunks: RetrievedChunk[] }) => Promise<string>;
}): Promise<AnswerResult> {
  const chunks = await input.retrieve({ prompt: input.prompt, project: input.project });
  const response = await input.complete({ prompt: input.prompt, project: input.project, chunks });
  return { response, status: 'success' };
}

export function retrievalFilterFor(project: string): ReturnType<typeof projectRetrieveFilter> {
  return projectRetrieveFilter(project);
}
