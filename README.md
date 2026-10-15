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
