import { ConflictException } from '@aws-sdk/client-bedrock-agent';
import { startDocumentsIngestion } from '../lib/start-documents-ingestion.js';

test('starts a job when none is running', async () => {
  const send = jest.fn().mockResolvedValueOnce({ ingestionJobSummaries: [] }).mockResolvedValueOnce({});
  await startDocumentsIngestion({ send } as never, 'kb', 'ds');
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1][0].input).toEqual({ knowledgeBaseId: 'kb', dataSourceId: 'ds' });
});

test('retries when a job is already running', async () => {
  const send = jest.fn().mockResolvedValueOnce({
    ingestionJobSummaries: [{ status: 'IN_PROGRESS' }],
  });
  await expect(startDocumentsIngestion({ send } as never, 'kb', 'ds')).rejects.toThrow(
    'ingestion job already running',
  );
  expect(send).toHaveBeenCalledTimes(1);
});

test('retries on a start conflict', async () => {
  const send = jest
    .fn()
    .mockResolvedValueOnce({ ingestionJobSummaries: [] })
    .mockRejectedValueOnce(new ConflictException({ message: 'conflict', $metadata: {} }));
  await expect(startDocumentsIngestion({ send } as never, 'kb', 'ds')).rejects.toThrow(
    'ingestion job already running',
  );
});
