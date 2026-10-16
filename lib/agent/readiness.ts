import type { RetrievedDecision } from '../search-decisions.js';
import type { Repo, Rule } from '../lookup.js';
import type { AnswerResult, RetrievedChunk } from './answer.js';

export async function checkReadiness(input: {
  prompt: string;
  project: string;
  ticketDocument?: RetrievedChunk;
  retrieve: (query: { prompt: string; project: string }) => Promise<RetrievedChunk[]>;
  searchDecisions: (query: { prompt: string; project: string }) => Promise<RetrievedDecision[]>;
  loadRules: (project: string) => Promise<Rule[]>;
  loadRepos: (project: string) => Promise<Repo[]>;
  complete: (query: {
    prompt: string;
    project: string;
    chunks: RetrievedChunk[];
    decisions: RetrievedDecision[];
    rules: Rule[];
    repos: Repo[];
  }) => Promise<string>;
}): Promise<AnswerResult> {
  const chunksPromise = input.ticketDocument
    ? Promise.resolve([input.ticketDocument])
    : input.retrieve({ prompt: input.prompt, project: input.project });
  const decisionsPromise = input.searchDecisions({ prompt: input.prompt, project: input.project }).catch((error) => {
    console.error(error);
    return [];
  });
  const rulesPromise = input.loadRules(input.project).catch((error) => {
    console.error(error);
    return [];
  });
  const reposPromise = input.loadRepos(input.project).catch((error) => {
    console.error(error);
    return [];
  });
  const [chunks, decisions, rules, repos] = await Promise.all([
    chunksPromise,
    decisionsPromise,
    rulesPromise,
    reposPromise,
  ]);
  const response = await input.complete({
    prompt: input.prompt,
    project: input.project,
    chunks,
    decisions,
    rules,
    repos,
  });
  return { response, status: 'success' };
}

export const READINESS_SYSTEM_PROMPT =
  'You check readiness for a piece of work. Answer ready or blocked, then why. Use only the rules, decisions, documents, and repos provided. Global rules always apply; a client rule may add but cannot drop a global rule. Decisions overrule documents. Project decisions beat global decisions. Cite a rule id, a decision quote and loggedAt when a later decision won, a document uri, or a repo. Do not invent a ticket, path, or repo that is not in the repo list. Ready means the work is specific enough, a target repo exists, nothing retrieved contradicts it, and the rules still hold. Blocked means missing repo, conflicting decisions, a rule that forbids it, or documents too thin to know. If rules failed to load, say so and treat that as blocked.';
