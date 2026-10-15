# minivela

Read this before changing the stack or ingesting a client's files.

## Two buckets

Transcripts and the knowledge base are different buckets and different processes.

- Transcripts bucket: WebVTT only, at `<client>/transcripts/<meeting>.vtt`. A put runs extraction and writes decisions to DynamoDB. Do not add this bucket as a knowledge base data source. Do not upload anything except `.vtt` here.
- Documents bucket: the only knowledge base data source. Client markdown goes here.

## Sidecar

Every file you upload to the documents bucket needs a sidecar beside it. For `notes.md`, the sidecar is `notes.md.metadata.json`.

```json
{
  "metadataAttributes": {
    "project": "<client-id>",
    "source": "<where it came from>"
  }
}
```

`project` is the client id, such as `bpp`, or `global` when the document applies to every client. A ticket prefix or a product name is not a client id.

Do not upload a file without this sidecar. A filtered retrieve would miss it, and an unfiltered retrieve would return it for every client.

## Ingestion

Ingestion is not code in this repo. Do not add an importer, a sidecar writer, or a script that knows one client's files. Each client arrives as a different pile of files.

When asked to ingest:

1. Put the files and their sidecars in the documents bucket only.
2. Start an ingestion job. Deploy prints `KnowledgeBaseId` and `DocumentsDataSourceId`. Creating the knowledge base does not watch the bucket. Sync is incremental and runs only when started.

```bash
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id "$KNOWLEDGE_BASE_ID" \
  --data-source-id "$DATA_SOURCE_ID" \
  --profile my-profile \
  --region us-east-1
```

3. Leave the transcripts bucket alone. Do not copy a transcript into the documents bucket in any format.
