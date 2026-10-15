import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app.js';
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
        Dimensions: 1024,
        DistanceFunction: 'COSINE',
        VectorAttribute: { AttributeName: 'embedding' },
        SearchSchema: [{ AttributeName: 'project', SearchSchemaElementType: 'HASH' }],
      }),
    ],
  });
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Timeout: 180,
    Runtime: 'nodejs22.x',
    Environment: {
      Variables: Match.objectLike({
        EXTRACT_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
        EMBED_MODEL_ID: 'amazon.titan-embed-text-v2:0',
      }),
    },
  });
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

test.each(['', '1acme', 'has_underscore', 'has space', `${'a'.repeat(129)}`])(
  'rejects stack name %j',
  (stackName) => {
    expect(() => createApp({ context: { stackName } })).toThrow(/stackName/);
  },
);
