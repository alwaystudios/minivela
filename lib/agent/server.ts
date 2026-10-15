import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { RetrieveCommand, BedrockAgentRuntimeClient } from '@aws-sdk/client-bedrock-agent-runtime';
import { InvokeModelCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { EXTRACT_MODEL_ID } from '../models.js';
import { answerFromDocuments, parseInvokePayload, retrievalFilterFor, type RetrievedChunk } from './answer.js';

const retrieveClient = new BedrockAgentRuntimeClient({});
const bedrock = new BedrockRuntimeClient({});

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

async function complete(query: {
  prompt: string;
  project: string;
  chunks: RetrievedChunk[];
}): Promise<string> {
  const context =
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
          'Answer using only the retrieved documents for this project. If there are none, say so. Do not invent. Name a source uri when you use a chunk.',
        messages: [
          {
            role: 'user',
            content: `project: ${query.project}\nquestion: ${query.prompt}\n\nretrieved:\n${context}`,
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
  const result = await answerFromDocuments({
    prompt: parsedPayload.prompt,
    project: parsedPayload.project,
    retrieve,
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
