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

A project secret is a Secrets Manager secret named `minivela/<project>/<name>`. The acme git PAT is `minivela/acme/git-pat`. A Jira token for that project is `minivela/acme/jira`. The stack does not create these secrets and does not set a value. Create one with the value in a file, not on the command line:

```bash
aws secretsmanager create-secret \
  --name minivela/acme/git-pat \
  --secret-string file://git-pat.txt \
  --profile my-profile \
  --region us-east-1
```

Every AgentCore runtime can read names under `minivela/` with `secretsmanager:GetSecretValue`. A new runtime gets that read on its own. It cannot read other secrets, and it cannot write them. Any agent calls `getProjectSecret(project, name)`. The name is the secret, such as `git-pat` or `jira`. The value stays out of logs.

Upload a WebVTT file to the transcripts bucket at `<project>/transcripts/<meeting>.vtt`.

```bash
aws s3 cp standup.vtt s3://<transcripts-bucket>/demo/transcripts/standup.vtt --profile my-profile --region us-east-1
```

That starts extraction. Decisions are stored in DynamoDB. The file stays in the transcripts bucket.

The documents bucket is the knowledge base data source. Put markdown there, with a sidecar beside each file. A put starts one ingestion job after a short wait, so a burst of files is one sync. Transcripts do not go in that bucket.

Deploy prints `AgentRuntimeArn`. That is the human interface. Pass `project` on every invoke. Pass `prompt` to retrieve that client plus `global`, and to search transcript decisions the same way. Pass `ticket` to read `<project>/jira/<ticket>.md` from the documents bucket and use that whole file. When `prompt` is omitted, that file is the prompt, including for decision search. A missing object is an error. The agent does not search the knowledge base for the key. Close decisions overrule documents. A documents question still works if search finds nothing. It will not search without a project.

Set `skill` to `check-readiness` to get a ready-or-blocked verdict. Set it to `draft-work-order` to store a work-order draft in DynamoDB. check-readiness loads that client's repo map. draft-work-order loads global rules and that client's repo map. Rules apply only on a work order. An empty repo map, or a repo map that fails to load, stops check-readiness and draft-work-order before the model runs, and a work order stores nothing. draft-breakdown stores that same stop as a refusal. Omit `skill` for a normal question. The draft names repos from that map only. DynamoDB always stores that draft as JSON. The stored draft copies the rules loaded for that call, global first, and this precedence line: "Where the code this change writes would break a rule, follow the rule. Do not widen the diff to fix other violations. On a policy conflict, the order wins. Do not stop to confirm a conflict this order already settles. A named fact that is absent, or a different value in the repo for a fact this order names, is a failed premise. Do not invent a replacement or copy the repo. A count, metric, log backend, or filename with no outcome means stop and ask. An acceptance line that needs a running environment, credentials, a third-party page, or production data is human-verified, even when the line does not say so. A test that runs in the checkout stays for the agent. Global rules always apply. A client rule may add but cannot drop a global rule. Rules override constraints." The markdown places that line with the repos and again under Global rules. A premise is a verify-before-building line. An acceptance line the agent cannot check ends with "human-verified, not agent-verified". A failed rules query stores nothing. The command writes a JSON file, and the draft is the `response` string inside it. Omit `format` for that stored JSON. Set `format` to `markdown` for the same draft as an agent prompt. Pass `draftId` with `project` to fetch a stored draft. Omit `prompt`, `skill`, `page`, and `ticket` on a fetch. A fetch does not write a row. A draft-work-order that runs the model writes one SdlcRuns row, and a fetch by draftId writes none.

Set `skill` to `draft-breakdown` and pass `page`. `page` is the documents-bucket key. It starts with `<project>/`, ends with `.md`, and contains no `..`. The skill reads that object whole. Decision and document search use the first heading, or the first line when the page has none. The whole page is what gets split. A failed search stores nothing. It stores an epic and its stories, or one refusal, and the response is that document. Each ticket is labeled Epic or Story. The breakdown id is the `breakdownId` field on the JSON, not inside the document. The epic row records the page key. A refusal row records it too. A story row does not, and the key is not in the response. Omit `prompt`, `ticket`, `draftId`, `breakdownId`, and `format`. Pass `breakdownId` with `project` to fetch the same document. Omit `prompt`, `skill`, `page`, `ticket`, `draftId`, and `format` on that fetch. A ticket template is one DynamoDB row, sort key `ticket`. The project row replaces `global`. When neither row exists, the prompt tells the model to follow ordinary Jira practice. The generated tickets stay out of the documents bucket.

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

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <agent-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"project":"acme","page":"acme/notes/billing.md","skill":"draft-breakdown"}' \
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
  --payload '{"project":"acme","breakdownId":"<breakdown-id>"}' \
  --qualifier DEFAULT \
  --profile my-profile \
  --region us-east-1 \
  --cli-binary-format raw-in-base64-out \
  outfile.json
```

Deploy prints `GooseRuntimeArn`. That runtime runs [Goose](https://goose-docs.ai/) on `deepseek.v3.2`. Pass `project` and `draftId` to load a stored work order. This invoke applies one repository. When the order names one repo, that is the clone. When it names more than one, pass `repo` as `owner/repo`. Goose loads the project secret `git-pat` before it clones. A missing or unreadable secret is `status: error` and Goose does not run. Clone of a public repo is unauthenticated HTTPS. After a non-empty diff with token counts, Goose commits as itself and pushes `goose/<draftId>`. The token is used for that push. A diff with no token counts is not pushed. If the SdlcRuns write fails after that push, Goose deletes the branch. Success returns the branch name and the diff, and means that branch exists on the remote. An existing `goose/<draftId>`, a push failure, or an empty diff is `status: error`. An empty diff is not pushed. Goose does not push the default branch and does not force-push. A Goose apply that runs the model writes one SdlcRuns row. The body is `{ status, response }` like the agent. `response` holds `diff`, `stdout`, and `branch` on success. The caller identity needs `bedrock-agentcore:InvokeAgentRuntime` on this runtime ARN and its `DEFAULT` endpoint, the same as the agent.

```bash
SESSION=$(uuidgen)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn <goose-runtime-arn> \
  --runtime-session-id "$SESSION" \
  --payload '{"project":"acme","draftId":"<draft-id>"}' \
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

Deploy prints `RulesTableName`. Hard rules are DynamoDB, queried by project. Load `global` when drafting a work order. They are not a knowledge base data source and have no vectors. `project` is a reserved word, so the query aliases it.

```bash
aws dynamodb query \
  --table-name <rules-table-name> \
  --key-condition-expression '#p = :p' \
  --expression-attribute-names '{"#p":"project"}' \
  --expression-attribute-values '{":p":{"S":"global"}}' \
  --profile my-profile \
  --region us-east-1
```

Deploy prints `TemplatesTableName`. The ticket template is DynamoDB, one row per project. The sort key is `templateId` and the only id is `ticket`. `body` is the template. It is not a knowledge base data source.

```bash
aws dynamodb get-item \
  --table-name <templates-table-name> \
  --key '{"project":{"S":"acme"},"templateId":{"S":"ticket"}}' \
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

The stack grants the agent its own role. The profile you use on these commands needs a separate identity policy. An IAM inline policy is capped at 2048 characters, so keep it one compact document. Fill in the region, account, stack name, and bucket names. `InvokeAgentRuntime` covers both runtimes.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem"],
      "Resource": "arn:aws:dynamodb:<region>:<account>:table/<stackName>-*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::<transcripts-bucket>/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": ["arn:aws:s3:::<documents-bucket>", "arn:aws:s3:::<documents-bucket>/*"]
    },
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntime",
      "Resource": [
        "arn:aws:bedrock-agentcore:<region>:<account>:runtime/*",
        "arn:aws:bedrock-agentcore:<region>:<account>:runtime/*/runtime-endpoint/DEFAULT"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:GetKnowledgeBase", "bedrock:GetDataSource", "bedrock:ListIngestionJobs", "bedrock:GetIngestionJob", "bedrock:StartIngestionJob", "bedrock:Retrieve"],
      "Resource": "arn:aws:bedrock:<region>:<account>:knowledge-base/*"
    }
  ]
}
```
