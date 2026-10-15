import { InvokeModelCommand, BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { systemPrompt, userMessageTemplate } from './extract/prompt.js';
import { EMBED_MODEL_ID, EMBEDDING_DIMENSIONS, EXTRACT_MODEL_ID } from './models.js';
import { type DecisionWrite, processTranscriptObject } from './process-transcript.js';
import { decodeS3Key, projectFromTranscriptKey } from './transcript-key.js';

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const decisions = DynamoDBDocumentClient.from(new DynamoDBClient({}));

type S3PutEvent = {
  Records?: Array<{
    s3?: {
      bucket?: { name?: string };
      object?: { key?: string };
    };
  }>;
};

export async function handler(event: S3PutEvent): Promise<void> {
  const tableName = requiredEnv('DECISIONS_TABLE_NAME');
  for (const record of event.Records ?? []) {
    const rawKey = record.s3?.object?.key;
    const bucket = record.s3?.bucket?.name;
    if (!rawKey || !bucket) {
      continue;
    }
    const key = decodeS3Key(rawKey);
    if (!projectFromTranscriptKey(key)) {
      console.info(JSON.stringify({ key, outcome: 'ignored' }));
      continue;
    }
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await object.Body?.transformToString('utf-8');
    if (body === undefined) {
      throw new Error(`empty object body for ${key}`);
    }
    const loggedAt = new Date().toISOString();
    const result = await processTranscriptObject({
      key,
      body,
      loggedAt,
      systemPrompt,
      userMessageTemplate,
      extract,
      embed,
      put: (item) => putDecision(tableName, item),
    });
    console.info(JSON.stringify({ key, ...result }));
  }
}

async function extract(request: { system: string; user: string }): Promise<string> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EXTRACT_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ text?: string }>;
  };
  const text = payload.content?.map((part) => part.text ?? '').join('') ?? '';
  if (!text) {
    throw new Error('extract model returned no text');
  }
  return text;
}

async function embed(text: string): Promise<number[]> {
  const response = await bedrock.send(
    new InvokeModelCommand({
      modelId: EMBED_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMENSIONS,
        normalize: true,
      }),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: number[] };
  if (!payload.embedding) {
    throw new Error('embed model returned no embedding');
  }
  return payload.embedding;
}

async function putDecision(tableName: string, item: DecisionWrite): Promise<void> {
  await decisions.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    }),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
