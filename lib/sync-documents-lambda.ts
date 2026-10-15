import { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import { startDocumentsIngestion } from './start-documents-ingestion.js';

const bedrock = new BedrockAgentClient({});

export async function handler(): Promise<void> {
  const knowledgeBaseId = requiredEnv('KNOWLEDGE_BASE_ID');
  const dataSourceId = requiredEnv('DATA_SOURCE_ID');
  await startDocumentsIngestion(bedrock, knowledgeBaseId, dataSourceId);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
