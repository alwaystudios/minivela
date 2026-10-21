# Minivela

Minivela is the open-source, self-hosted baby brother of [Supervela](https://www.supervela.com). It keeps project memory, breaks one page into an epic and its stories, and drafts a one-shot work-order prompt from a Jira ticket and the knowledge base: meeting decisions, notes, and handbooks.

The same stack runs [Goose](https://goose-docs.ai/) in a second AgentCore runtime. Pass a stored work-order draft. Goose edits a shallow clone of one repository on that order and the runtime returns the diff.

## Components

```mermaid
flowchart TB
  caller[Caller] -->|IAM| agent[Agent]
  caller -->|IAM| goose[Goose]

  transcripts[S3 transcripts] -->|".vtt"| extract[Lambda]
  extract --> bedrock[Bedrock]
  extract --> decisions[(DynamoDB decisions)]
  extract -.->|failures| extractDlq[SQS]

  documents[S3 documents] --> ingestQueue[SQS]
  ingestQueue --> ingest[Lambda]
  ingest --> kb[Bedrock Knowledge Base]
  kb --> vectors[S3 Vectors]

  agent --> kb
  agent --> bedrock
  agent --> decisions
  agent --> tables[(DynamoDB rules, repos, drafts, breakdowns, templates)]
  agent --> documents

  goose --> bedrock
  goose --> tables
```

## Provision

Deploy the CDK stack into your own AWS account. You pay the Bedrock tokens. There is no subscription and no console.

```bash
npx cdk deploy --profile my-profile --region us-east-1
```

The region must be `us-east-1`, `us-east-2`, or `us-west-2`. The stack name defaults to `minivela`.

Uploading transcripts, dropping documents, and invoking the agent are in the [how-to](docs/how-to.md).

## License

[MIT](LICENSE)
