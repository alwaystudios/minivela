import {
  BedrockAgentClient,
  ConflictException,
  ListIngestionJobsCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

const RUNNING = new Set(['STARTING', 'IN_PROGRESS']);

export async function startDocumentsIngestion(
  client: BedrockAgentClient,
  knowledgeBaseId: string,
  dataSourceId: string,
): Promise<void> {
  const listed = await client.send(
    new ListIngestionJobsCommand({
      knowledgeBaseId,
      dataSourceId,
      filters: [{ attribute: 'STATUS', operator: 'EQ', values: ['STARTING', 'IN_PROGRESS'] }],
      maxResults: 1,
    }),
  );
  const running = listed.ingestionJobSummaries?.some((job) => job.status && RUNNING.has(job.status));
  if (running) {
    throw new Error('ingestion job already running');
  }

  try {
    await client.send(new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }));
  } catch (error) {
    if (error instanceof ConflictException) {
      throw new Error('ingestion job already running');
    }
    throw error;
  }
}
