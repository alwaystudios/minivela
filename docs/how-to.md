# How to

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

Deploy prints `AgentRuntimeArn`. That is the human interface. Pass `project` on every invoke. Pass `prompt` to retrieve that client plus `global`, and to search transcript decisions the same way. Pass `ticket` to read `<project>/jira/<ticket>.md` from the documents bucket and use that whole file. When `prompt` is omitted, that file is the prompt, including for decision search. A missing object is an error. The agent does not search the knowledge base for the key. Close decisions overrule documents. A documents question still works if search finds nothing. It will not search without a project.

Set `skill` to `check-readiness` to get a ready-or-blocked verdict. Set it to `draft-work-order` to store a work-order draft in DynamoDB. Both paths load global rules and that client's repo map. Omit `skill` for a normal question. The draft names repos from that map only. DynamoDB always stores that draft as JSON. The stored draft copies the rules loaded for that call, global first, and this precedence line: "Global rules always apply. A client rule may add but cannot drop a global rule. Rules override constraints. Where the code this change writes would break a rule, follow the rule. Do not widen the diff to fix other violations. On a policy conflict, the order wins. Do not stop to confirm a conflict this order already settles. A named fact that is absent is a failed premise. Do not invent a replacement or copy the repo." The markdown places that line with the repos and again under Global rules. A premise is a verify-before-building line. An acceptance line the agent cannot check ends with "human-verified, not agent-verified". A failed rules query stores nothing. The command writes a JSON file, and the draft is the `response` string inside it. Omit `format` for that stored JSON. Set `format` to `markdown` for the same draft as an agent prompt. Pass `draftId` with `project` to fetch a stored draft. Omit `prompt`, `skill`, and `ticket` on a fetch. A fetch does not write a row.

Prove decision search with a `.vtt` at `<project>/transcripts/<meeting>.vtt`, then ask about that meeting. `test/fixtures/csv-export.vtt` is one such file.

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"prompt":"what did we decide about export format","project":"demo"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  outfile.json
```

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"prompt":"add CSV export","project":"acme","skill":"check-readiness"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  outfile.json
```

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"prompt":"add CSV export","project":"acme","skill":"draft-work-order"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  outfile.json
```

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"ticket":"ACME-12","project":"acme","skill":"draft-work-order"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  outfile.json
```

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"prompt":"add CSV export","project":"acme","skill":"draft-work-order","format":"markdown"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  outfile.json
```

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"project":"acme","draftId":"<draft-id>","format":"markdown"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
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

Deploy prints `RulesTableName`. Hard rules are DynamoDB, queried by project. Load `global` on every skill. They are not a knowledge base data source and have no vectors. `project` is a reserved word, so the query aliases it.

```bash
aws dynamodb query \
  --table-name <rules-table-name> \
  --key-condition-expression '#p = :p' \
  --expression-attribute-names '{"#p":"project"}' \
  --expression-attribute-values '{":p":{"S":"global"}}' \
  --profile my-profile \
  --region us-east-1
```

Deploy prints `DraftsTableName`. Work-order drafts are DynamoDB, partitioned by the project you passed. They are not a knowledge base data source. `project` is a reserved word, so the query aliases it.

```bash
aws dynamodb query \
  --table-name <drafts-table-name> \
  --key-condition-expression '#p = :p' \
  --expression-attribute-names '{"#p":"project"}' \
  --expression-attribute-values '{":p":{"S":"demo"}}' \
  --profile my-profile \
  --region us-east-1
```

The stack grants the agent its own role. The profile you use on these commands needs a separate identity policy. An IAM inline policy is capped at 2048 characters, so keep it one compact document. Fill in deploy outputs. `InvokeAgentRuntime` needs the runtime ARN and `/runtime-endpoint/DEFAULT`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:Query",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:<region>:<account>:table/<stackName>-*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<transcripts-bucket>/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::<documents-bucket>"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::<documents-bucket>/*"
    },
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntime",
      "Resource": [
        "<agent-runtime-arn>",
        "<agent-runtime-arn>/runtime-endpoint/DEFAULT"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:GetKnowledgeBase",
        "bedrock:GetDataSource",
        "bedrock:ListIngestionJobs",
        "bedrock:GetIngestionJob",
        "bedrock:StartIngestionJob",
        "bedrock:Retrieve"
      ],
      "Resource": [
        "arn:aws:bedrock:<region>:<account>:knowledge-base/<knowledge-base-id>",
        "arn:aws:bedrock:<region>:<account>:knowledge-base/<knowledge-base-id>/data-source/<data-source-id>"
      ]
    }
  ]
}
```
