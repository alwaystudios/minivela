import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { RetrieveCommand, BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { InvokeModelCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, GetItemCommand, QueryCommand, SearchVectorsCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand as DocQueryCommand } from '@aws-sdk/lib-dynamodb';
import { embedText } from '../embed.js';
import {
  loadPartitions,
  partitionQueryInput,
  repoPartitions,
  reposFromQueryItems,
  rulePartitions,
  rulesFromQueryItems,
  type Repo,
  type Rule,
} from '../lookup.js';
import { EXTRACT_MODEL_ID } from '../models.js';
import {
  decisionFromItem,
  decisionsSearchInput,
  scoredDecisionsFromSearchResults,
  searchDecisionsAcrossProjects,
  type RetrievedDecision,
  type ScoredDecision,
} from '../search-decisions.js';
import { breakdownQueryInput, readBreakdown, type BreakdownRow } from '../breakdown.js';
import type { DraftWrite } from '../work-order.js';
import { promptForInvoke, readTicketMarkdown } from '../ticket.js';
import { answerFromMemory, parseInvokePayload, retrievalFilterFor, type RetrievedChunk } from './answer.js';
import { BREAKDOWN_SYSTEM_PROMPT, draftBreakdown, TICKET_TEMPLATE_ID } from './draft-breakdown.js';
import { draftWorkOrder, DRAFT_SYSTEM_PROMPT, readWorkOrder } from './draft.js';
import { checkReadiness, READINESS_SYSTEM_PROMPT } from './readiness.js';

const retrieveClient = new BedrockAgentRuntimeClient({});
const bedrock = new BedrockRuntimeClient({});
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamodb);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readDocumentsObject(key: string): Promise<string | undefined> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: requiredEnv('DOCUMENTS_BUCKET_NAME'),
        Key: key,
      }),
    );
    return await result.Body?.transformToString();
  } catch (error) {
    if (isMissingObject(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return false;
  }
  const name = (error as { name: unknown }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

async function retrieve(query: { prompt: string; project: string }): Promise<RetrievedChunk[]> {
  const result = await retrieveClient.send(
    new RetrieveCommand({
      knowledgeBaseId: requiredEnv('KNOWLEDGE_BASE_ID'),
      retrievalQuery: { text: query.prompt },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 5,
          filter: retrievalFilterFor(query.project),
        },
      },
    }),
  );
  return (result.retrievalResults ?? []).flatMap((hit) => {
    const text = hit.content?.text?.trim();
    if (!text) {
      return [];
    }
    return [{ text, uri: hit.location?.s3Location?.uri }];
  });
}

async function searchOne(project: string, embedding: number[]): Promise<ScoredDecision[]> {
  const result = await dynamodb.send(
    new SearchVectorsCommand(
      decisionsSearchInput({
        tableName: requiredEnv('DECISIONS_TABLE_NAME'),
        project,
        embedding,
      }),
    ),
  );
  return scoredDecisionsFromSearchResults(result.SearchResults);
}

async function searchDecisionsStrict(query: { prompt: string; project: string }): Promise<RetrievedDecision[]> {
  const embedding = await embedText(bedrock, query.prompt);
  return searchDecisionsAcrossProjects({
    project: query.project,
    embedding,
    searchOne,
  });
}

async function searchDecisions(query: { prompt: string; project: string }): Promise<RetrievedDecision[]> {
  try {
    return await searchDecisionsStrict(query);
  } catch (error) {
    console.error(error);
    return [];
  }
}

async function loadRules(project: string): Promise<Rule[]> {
  return loadPartitions({
    projects: rulePartitions(project),
    loadOne: async (partition) => {
      const result = await dynamodb.send(
        new QueryCommand(partitionQueryInput(requiredEnv('RULES_TABLE_NAME'), partition)),
      );
      return rulesFromQueryItems(result.Items);
    },
  });
}

async function loadRepos(project: string): Promise<Repo[]> {
  return loadPartitions({
    projects: repoPartitions(project),
    loadOne: async (partition) => {
      const result = await dynamodb.send(
        new QueryCommand(partitionQueryInput(requiredEnv('REPOS_TABLE_NAME'), partition)),
      );
      return reposFromQueryItems(result.Items);
    },
  });
}

async function complete(query: {
  prompt: string;
  project: string;
  chunks: RetrievedChunk[];
  decisions: RetrievedDecision[];
}): Promise<string> {
  const decisionsContext =
    query.decisions.length === 0
      ? '(no decisions)'
      : query.decisions
          .map(
            (decision, index) =>
              `${index + 1}. decision ${decision.decisionId} project=${decision.project} loggedAt=${decision.loggedAt} timestamp=${decision.timestamp} source=${decision.sourceKey}\n${decision.title}\n${decision.content}\nquote: ${decision.quote}`,
          )
          .join('\n\n');
  const documentsContext =
    query.chunks.length === 0
      ? '(no documents)'
      : query.chunks
          .map((chunk, index) => `${index + 1}. ${chunk.uri ?? 'document'}\n${chunk.text}`)
          .join('\n\n');
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.ANSWER_MODEL_ID ?? EXTRACT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        system:
          'Answer using only the retrieved decisions and documents for this project. The decisions list is already ranked and conflicts are already resolved. Decisions overrule documents. Cite loggedAt when you follow a decision. If there are none, say so. Do not invent. Name a source key or uri when you use a hit.',
        messages: [
          {
            role: 'user',
            content: `project: ${query.project}\nquestion: ${query.prompt}\n\ndecisions:\n${decisionsContext}\n\ndocuments:\n${documentsContext}`,
          },
        ],
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ text?: string }>;
  };
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  if (!text) {
    throw new Error('answer model returned no text');
  }
  return text;
}

async function completeReadiness(query: {
  prompt: string;
  project: string;
  chunks: RetrievedChunk[];
  decisions: RetrievedDecision[];
  repos: Repo[];
}): Promise<string> {
  const reposContext =
    query.repos.length === 0
      ? '(no repos)'
      : query.repos
          .map(
            (repo, index) =>
              `${index + 1}. ${repo.owner}/${repo.repo} url=${repo.url}\n${repo.summary}`,
          )
          .join('\n\n');
  const decisionsContext =
    query.decisions.length === 0
      ? '(no decisions)'
      : query.decisions
          .map(
            (decision, index) =>
              `${index + 1}. decision ${decision.decisionId} project=${decision.project} loggedAt=${decision.loggedAt} timestamp=${decision.timestamp} source=${decision.sourceKey}\n${decision.title}\n${decision.content}\nquote: ${decision.quote}`,
          )
          .join('\n\n');
  const documentsContext =
    query.chunks.length === 0
      ? '(no documents)'
      : query.chunks
          .map((chunk, index) => `${index + 1}. ${chunk.uri ?? 'document'}\n${chunk.text}`)
          .join('\n\n');
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.ANSWER_MODEL_ID ?? EXTRACT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2048,
        system: READINESS_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `project: ${query.project}\nwork: ${query.prompt}\n\nrepos:\n${reposContext}\n\ndecisions:\n${decisionsContext}\n\ndocuments:\n${documentsContext}`,
          },
        ],
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ text?: string }>;
  };
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  if (!text) {
    throw new Error('answer model returned no text');
  }
  return text;
}

async function completeDraft(query: {
  prompt: string;
  project: string;
  chunks: RetrievedChunk[];
  decisions: RetrievedDecision[];
  rules: Rule[];
  repos: Repo[];
}): Promise<string> {
  const rulesContext =
    query.rules.length === 0
      ? '(no rules loaded)'
      : query.rules
          .map((rule, index) => `${index + 1}. rule ${rule.ruleId} project=${rule.project}\n${rule.title}\n${rule.body}`)
          .join('\n\n');
  const reposContext =
    query.repos.length === 0
      ? '(no repos)'
      : query.repos
          .map(
            (repo, index) =>
              `${index + 1}. ${repo.owner}/${repo.repo} url=${repo.url}\n${repo.summary}`,
          )
          .join('\n\n');
  const decisionsContext =
    query.decisions.length === 0
      ? '(no decisions)'
      : query.decisions
          .map(
            (decision, index) =>
              `${index + 1}. decision ${decision.decisionId} project=${decision.project} loggedAt=${decision.loggedAt} timestamp=${decision.timestamp} source=${decision.sourceKey}\n${decision.title}\n${decision.content}\nquote: ${decision.quote}`,
          )
          .join('\n\n');
  const documentsContext =
    query.chunks.length === 0
      ? '(no documents)'
      : query.chunks
          .map((chunk, index) => `${index + 1}. ${chunk.uri ?? 'document'}\n${chunk.text}`)
          .join('\n\n');
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.ANSWER_MODEL_ID ?? EXTRACT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        system: DRAFT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `project: ${query.project}\nwork: ${query.prompt}\n\nrules:\n${rulesContext}\n\nrepos:\n${reposContext}\n\ndecisions:\n${decisionsContext}\n\ndocuments:\n${documentsContext}`,
          },
        ],
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: { output_tokens?: number };
  };
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  console.error(
    JSON.stringify({
      draftStop: payload.stop_reason,
      draftTokens: payload.usage?.output_tokens,
      draftChars: text.length,
      draftTypes: payload.content?.map((part) => part.type),
    }),
  );
  if (!text) {
    throw new Error('draft model returned no text');
  }
  return text;
}

async function completeBreakdown(query: {
  project: string;
  page: string;
  pageText: string;
  chunks: RetrievedChunk[];
  decisions: RetrievedDecision[];
  repos: Repo[];
  template?: string;
}): Promise<{ text: string; cutOff: boolean }> {
  const templateContext = query.template ?? '(no template; follow ordinary Jira practice)';
  const reposContext = query.repos
    .map((repo, index) => `${index + 1}. ${repo.owner}/${repo.repo} url=${repo.url}\n${repo.summary}`)
    .join('\n\n');
  const decisionsContext =
    query.decisions.length === 0
      ? '(no decisions)'
      : query.decisions
          .map(
            (decision, index) =>
              `${index + 1}. decision ${decision.decisionId} project=${decision.project} loggedAt=${decision.loggedAt} timestamp=${decision.timestamp} source=${decision.sourceKey}\n${decision.title}\n${decision.content}\nquote: ${decision.quote}`,
          )
          .join('\n\n');
  const documentsContext =
    query.chunks.length === 0
      ? '(no documents)'
      : query.chunks.map((chunk, index) => `${index + 1}. ${chunk.uri ?? 'document'}\n${chunk.text}`).join('\n\n');
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: process.env.ANSWER_MODEL_ID ?? EXTRACT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        system: BREAKDOWN_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `project: ${query.project}\npage: ${query.page}\n\ntemplate:\n${templateContext}\n\npage text:\n${query.pageText}\n\nrepos:\n${reposContext}\n\ndecisions:\n${decisionsContext}\n\ndocuments:\n${documentsContext}`,
          },
        ],
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    stop_reason?: string;
    content?: Array<{ text?: string }>;
  };
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  const cutOff = payload.stop_reason === 'max_tokens';
  if (!text && !cutOff) {
    throw new Error('breakdown model returned no text');
  }
  return { text, cutOff };
}

async function loadTicketTemplate(project: string): Promise<string | undefined> {
  const result = await docClient.send(
    new GetCommand({
      TableName: requiredEnv('TEMPLATES_TABLE_NAME'),
      Key: { project, templateId: TICKET_TEMPLATE_ID },
    }),
  );
  const body = result.Item?.body;
  return typeof body === 'string' ? body : undefined;
}

async function putBreakdowns(rows: BreakdownRow[]): Promise<void> {
  for (const item of rows) {
    await docClient.send(
      new PutCommand({
        TableName: requiredEnv('BREAKDOWNS_TABLE_NAME'),
        Item: item,
      }),
    );
  }
}

async function putDraft(item: DraftWrite): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: requiredEnv('DRAFTS_TABLE_NAME'),
      Item: item,
    }),
  );
}

async function queryBreakdown(key: { project: string; breakdownId: string }): Promise<unknown[]> {
  const result = await docClient.send(
    new DocQueryCommand(breakdownQueryInput(requiredEnv('BREAKDOWNS_TABLE_NAME'), key.project, key.breakdownId)),
  );
  return result.Items ?? [];
}

async function getDraft(key: { project: string; draftId: string }): Promise<unknown> {
  const result = await docClient.send(
    new GetCommand({
      TableName: requiredEnv('DRAFTS_TABLE_NAME'),
      Key: key,
    }),
  );
  return result.Item;
}

async function loadCitedDecisions(project: string, ids: string[]): Promise<RetrievedDecision[]> {
  const partitions = project === 'global' ? ['global'] : [project, 'global'];
  const found: RetrievedDecision[] = [];
  for (const id of ids) {
    for (const partition of partitions) {
      const result = await dynamodb.send(
        new GetItemCommand({
          TableName: requiredEnv('DECISIONS_TABLE_NAME'),
          Key: { project: { S: partition }, decisionId: { S: id } },
        }),
      );
      const decision = decisionFromItem(result.Item);
      if (decision) {
        found.push(decision);
        break;
      }
    }
  }
  return found;
}

async function handleInvocations(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawText = await readBody(req);
  let parsed: unknown = {};
  if (rawText.trim()) {
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      json(res, 400, { response: 'Send JSON with prompt and project.', status: 'error' });
      return;
    }
  }
  const parsedPayload = parseInvokePayload(parsed);
  if ('status' in parsedPayload) {
    json(res, 400, parsedPayload);
    return;
  }
  if ('breakdownId' in parsedPayload) {
    const result = await readBreakdown({
      project: parsedPayload.project,
      breakdownId: parsedPayload.breakdownId,
      query: queryBreakdown,
    });
    json(res, 200, result);
    return;
  }
  if ('page' in parsedPayload) {
    const result = await draftBreakdown({
      project: parsedPayload.project,
      page: parsedPayload.page,
      readPage: readDocumentsObject,
      retrieve,
      searchDecisions: searchDecisionsStrict,
      loadRepos,
      loadTemplate: loadTicketTemplate,
      complete: completeBreakdown,
      put: putBreakdowns,
      breakdownId: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    json(res, 200, result);
    return;
  }
  if ('draftId' in parsedPayload) {
    const result = await readWorkOrder({
      project: parsedPayload.project,
      draftId: parsedPayload.draftId,
      format: parsedPayload.format,
      get: getDraft,
      loadDecisions: (ids) => loadCitedDecisions(parsedPayload.project, ids),
    });
    json(res, 200, result);
    return;
  }
  let ticketDocument: RetrievedChunk | undefined;
  if (parsedPayload.ticket) {
    const loaded = await readTicketMarkdown({
      bucket: requiredEnv('DOCUMENTS_BUCKET_NAME'),
      project: parsedPayload.project,
      ticket: parsedPayload.ticket,
      read: readDocumentsObject,
    });
    if ('status' in loaded) {
      json(res, 200, loaded);
      return;
    }
    ticketDocument = loaded.chunk;
  }
  const prompt = promptForInvoke(parsedPayload.prompt, ticketDocument?.text);
  const result =
    parsedPayload.skill === 'check-readiness'
      ? await checkReadiness({
          prompt,
          project: parsedPayload.project,
          ticketDocument,
          retrieve,
          searchDecisions,
          loadRepos,
          complete: completeReadiness,
        })
      : parsedPayload.skill === 'draft-work-order'
        ? await draftWorkOrder({
            prompt,
            project: parsedPayload.project,
            ticketDocument,
            retrieve,
            searchDecisions,
            loadRules,
            loadRepos,
            complete: completeDraft,
            put: putDraft,
            draftId: randomUUID(),
            createdAt: new Date().toISOString(),
            format: parsedPayload.format,
          })
        : await answerFromMemory({
            prompt,
            project: parsedPayload.project,
            ticketDocument,
            retrieve,
            searchDecisions,
            complete,
          });
  json(res, 200, result);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === 'GET' && req.url === '/ping') {
        json(res, 200, { status: 'Healthy' });
        return;
      }
      if (req.method === 'POST' && req.url === '/invocations') {
        await handleInvocations(req, res);
        return;
      }
      json(res, 404, { response: 'not found', status: 'error' });
    } catch (error) {
      console.error(error);
      json(res, 500, { response: 'The agent failed.', status: 'error' });
    }
  })();
});

server.listen(8080, '0.0.0.0');
