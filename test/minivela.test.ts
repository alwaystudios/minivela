import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app.js';
import { BEDROCK_REGIONS, EMBEDDING_DIMENSIONS } from '../lib/models.js';
import { DEFAULT_STACK_NAME } from '../lib/stack-name.js';

function stackOf(app: cdk.App, name: string): cdk.Stack {
  return app.node.findChild(name) as cdk.Stack;
}

test('the stack name defaults to minivela and a transcript put can write a decision', () => {
  const app = createApp();
  const stack = stackOf(app, DEFAULT_STACK_NAME);
  const template = Template.fromStack(stack);

  expect(stack.stackName).toBe('minivela');
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'project', KeyType: 'HASH' },
      { AttributeName: 'decisionId', KeyType: 'RANGE' },
    ],
    VectorIndexes: [
      Match.objectLike({
        IndexName: 'decisions-by-project',
        Dimensions: EMBEDDING_DIMENSIONS,
        DistanceFunction: 'COSINE',
        VectorAttribute: { AttributeName: 'embedding' },
        SearchSchema: [{ AttributeName: 'project', SearchSchemaElementType: 'HASH' }],
      }),
    ],
  });
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  template.hasResourceProperties('AWS::SQS::Queue', {
    MessageRetentionPeriod: 14 * 24 * 60 * 60,
  });
  template.hasResource('AWS::SQS::Queue', { DeletionPolicy: 'Retain' });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Timeout: 180,
    Runtime: 'nodejs22.x',
    DeadLetterConfig: {
      TargetArn: Match.anyValue(),
    },
    Environment: {
      Variables: Match.objectLike({
        DECISIONS_TABLE_NAME: Match.anyValue(),
      }),
    },
  });
  const templateJson = JSON.stringify(template.toJSON());
  expect(templateJson).toContain('bedrock:InvokeModel');
  for (const region of BEDROCK_REGIONS) {
    expect(templateJson).toContain(
      `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-6*`,
    );
  }
  expect(templateJson).toContain('amazon.titan-embed-text-v2:0');
  template.hasResourceProperties('Custom::S3BucketNotifications', {
    NotificationConfiguration: {
      LambdaFunctionConfigurations: [
        Match.objectLike({
          Events: ['s3:ObjectCreated:*'],
          Filter: {
            Key: {
              FilterRules: [{ Name: 'suffix', Value: '.vtt' }],
            },
          },
        }),
      ],
    },
  });
});

test('stackName context overrides the CloudFormation stack name', () => {
  const app = createApp({ context: { stackName: 'acme' } });
  const stack = stackOf(app, 'acme');

  expect(stack.stackName).toBe('acme');
});

test.each(['eu-west-1', 'us-west-1', 'ap-southeast-2'])('rejects Bedrock region %s', (region) => {
  const previousAccount = process.env.CDK_DEFAULT_ACCOUNT;
  const previousRegion = process.env.CDK_DEFAULT_REGION;
  process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
  process.env.CDK_DEFAULT_REGION = region;
  try {
    expect(() => createApp()).toThrow(/US Bedrock profile/);
  } finally {
    restoreEnv('CDK_DEFAULT_ACCOUNT', previousAccount);
    restoreEnv('CDK_DEFAULT_REGION', previousRegion);
  }
});

test('a US Bedrock region is accepted', () => {
  const previousAccount = process.env.CDK_DEFAULT_ACCOUNT;
  const previousRegion = process.env.CDK_DEFAULT_REGION;
  process.env.CDK_DEFAULT_ACCOUNT = '123456789012';
  process.env.CDK_DEFAULT_REGION = 'us-east-1';
  try {
    expect(stackOf(createApp(), DEFAULT_STACK_NAME).region).toBe('us-east-1');
  } finally {
    restoreEnv('CDK_DEFAULT_ACCOUNT', previousAccount);
    restoreEnv('CDK_DEFAULT_REGION', previousRegion);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test.each(['', '1acme', 'has_underscore', 'has space', `${'a'.repeat(129)}`])(
  'rejects stack name %j',
  (stackName) => {
    expect(() => createApp({ context: { stackName } })).toThrow(/stackName/);
  },
);
