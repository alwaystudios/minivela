# minivela

Use a named profile from `~/.aws/config`. Pass the region on the command. It must be `us-east-1`, `us-east-2`, or `us-west-2`.

```bash
npx cdk deploy --profile my-profile --region us-east-1
```

The stack name defaults to `minivela`.

```bash
npx cdk deploy --profile my-profile --region us-east-1 -c stackName=acme
```

A stack name starts with a letter and contains only letters, digits, and hyphens.

Deploy prints the transcripts bucket name and the documents bucket name.

Upload a WebVTT file to the transcripts bucket at `<project>/transcripts/<meeting>.vtt`.

```bash
aws s3 cp standup.vtt s3://<transcripts-bucket>/demo/transcripts/standup.vtt --profile my-profile --region us-east-1
```

That starts extraction. Decisions are stored in DynamoDB. The file stays in the transcripts bucket.

The documents bucket is the knowledge base data source. Put markdown there, with a sidecar beside each file. A put starts one ingestion job after a short wait, so a burst of files is one sync. Transcripts do not go in that bucket.

Deploy prints `AgentRuntimeArn`. That is the human interface. Pass `prompt` and `project` on every invoke. The agent retrieves that client plus `global`. It will not search without a project.

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"prompt":"what did we decide about export format","project":"demo"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  outfile.json
```

Deploy prints `KnowledgeBaseId`. Direct retrieve is for debugging the index. A retrieve for `demo` includes `global`. Omit the filter and every client's chunks can come back.

```bash
aws bedrock-agent-runtime retrieve \
  --knowledge-base-id <knowledge-base-id> \
  --retrieval-query '{"text":"what did we decide about export format"}' \
  --retrieval-configuration '{"vectorSearchConfiguration":{"numberOfResults":3,"filter":{"in":{"key":"project","value":["demo","global"]}}}}' \
  --profile my-profile \
  --region us-east-1
```

Deploy prints `ReposTableName`. The repo map is DynamoDB, queried by project. It is not a knowledge base data source. `project` is a reserved word, so the query aliases it.

```bash
aws dynamodb query \
  --table-name <repos-table-name> \
  --key-condition-expression '#p = :p' \
  --expression-attribute-names '{"#p":"project"}' \
  --expression-attribute-values '{":p":{"S":"demo"}}' \
  --profile my-profile \
  --region us-east-1
```
