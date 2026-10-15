# minivela

Use a named profile from `~/.aws/config`.

```bash
npx cdk synth --profile my-profile
npx cdk deploy --profile my-profile
```

The stack name defaults to `minivela`.

```bash
npx cdk deploy --profile my-profile -c stackName=acme
```

A stack name starts with a letter and contains only letters, digits, and hyphens. The stack has no resources yet, so deploy fails until a later change adds one.
