import { randomUUID } from 'node:crypto';
import { estimateSdlcRun } from '../sdlc-run.js';
import type { RetrievedDecision } from '../search-decisions.js';
import type { Repo } from '../lookup.js';
import { AnswerModelUsageError, type AnswerResult, type AnswerStatus, type CheckReadinessRun, type ReadinessModelCompletion, type RetrievedChunk } from './answer.js';

export async function checkReadiness(input: {
  prompt: string;
  project: string;
  ticketDocument?: RetrievedChunk;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  searchDecisions: (query: { prompt: string; project: string }) => Promise<RetrievedDecision[]>;
  loadRepos: (project: string) => Promise<Repo[]>;
  complete: (query: {
    prompt: string;
    project: string;
    chunks: RetrievedChunk[];
    decisions: RetrievedDecision[];
    repos: Repo[];
  }) => Promise<string | ReadinessModelCompletion>;
  putRun: (row: CheckReadinessRun) => Promise<void>;
}): Promise<AnswerResult> {
  const chunksPromise = input.ticketDocument
    ? Promise.resolve([input.ticketDocument])
    : input.retrieve({ prompt: input.prompt, project: input.project });
  const decisionsPromise = input.searchDecisions({ prompt: input.prompt, project: input.project }).catch((error) => {
    console.error(error);
    return [];
  });
  const reposPromise = input.loadRepos(input.project);
  const [chunks, decisions, reposOutcome] = await Promise.all([
    chunksPromise,
    decisionsPromise,
    reposPromise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  if (!reposOutcome.ok) {
    console.error(reposOutcome.error);
    return { response: 'The repo map failed to load.', status: 'refused' };
  }
  const repos = reposOutcome.value;
  if (repos.length === 0) {
    return { response: 'The repo map is empty.', status: 'refused' };
  }
  let completed: string | ReadinessModelCompletion;
  try {
    completed = await input.complete({
      prompt: input.prompt,
      project: input.project,
      chunks,
      decisions,
      repos,
    });
  } catch (error) {
    if (error instanceof AnswerModelUsageError) {
      return { response: 'The readiness model returned no token counts.', status: 'error' };
    }
    throw error;
  }
  const text = typeof completed === 'string' ? completed : completed.text;
  const usage = typeof completed === 'string' ? undefined : completed;
  const status: AnswerStatus = 'success';
  await recordReadinessRun(input, usage, status);
  return { response: text, status };
}

async function recordReadinessRun(
  input: { project: string; putRun: (row: CheckReadinessRun) => Promise<void> },
  usage: ReadinessModelCompletion | undefined,
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
      step: 'check-readiness',
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

export const READINESS_SYSTEM_PROMPT =
  'You check readiness for a piece of work. Answer ready or blocked, then why. Use only the decisions, documents, and repos provided. Decisions overrule documents. Project decisions beat global decisions. Cite a decision quote and loggedAt when a later decision won, a document uri, or a repo. Do not invent a ticket, path, or repo that is not in the repo list. Ready means the work is specific enough, a target repo exists, and nothing retrieved contradicts it. Blocked means missing repo, conflicting decisions, or documents too thin to know.';
