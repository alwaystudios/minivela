import { InvokeModelCommand, type BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { EMBED_MODEL_ID, EMBEDDING_DIMENSIONS } from './models.js';

export async function embedText(bedrock: BedrockRuntimeClient, text: string): Promise<number[]> {
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
  if (payload.embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`expected embedding length ${EMBEDDING_DIMENSIONS}`);
  }
  return payload.embedding;
}
