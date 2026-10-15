# minivela

Use a named profile from `~/.aws/config`. The profile must be in `us-east-1`, `us-east-2`, or `us-west-2`.

```bash
npx cdk deploy --profile my-profile
```

The stack name defaults to `minivela`.

```bash
npx cdk deploy --profile my-profile -c stackName=acme
```

A stack name starts with a letter and contains only letters, digits, and hyphens.

Deploy prints the transcripts bucket name. Drop a WebVTT file at `<project>/transcripts/<meeting>.vtt`. That starts extraction. Decisions are stored in DynamoDB. The file stays in the bucket.
