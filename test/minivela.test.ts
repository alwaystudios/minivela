import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app.js';
import { BEDROCK_REGIONS, EMBEDDING_DIMENSIONS, EXTRACT_MODEL_ID } from '../lib/models.js';
import { DECISIONS_VECTOR_INDEX } from '../lib/search-decisions.js';
import { DEFAULT_STACK_NAME } from '../lib/stack-name.js';

function stackOf(app: cdk.App, name: string): cdk.Stack {
  return app.node.findChild(name) as cdk.Stack;
}

test('the stack name defaults to minivela and a transcript put can write a decision', () => {
  const app = createApp();
  const stack = stackOf(app, DEFAULT_STACK_NAME);
  const template = Template.fromStack(stack);

  expect(stack.stackName).toBe('minivela');
  template.resourceCountIs('AWS::S3::Bucket', 2);
  template.resourceCountIs('AWS::DynamoDB::Table', 5);
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
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'project', KeyType: 'HASH' },
      { AttributeName: 'repoId', KeyType: 'RANGE' },
    ],
  });
  const tables = template.findResources('AWS::DynamoDB::Table');
  const repoTable = Object.values(tables).find((table) =>
    JSON.stringify(table.Properties.KeySchema).includes('repoId'),
  );
  expect(repoTable).toBeDefined();
  expect(repoTable?.Properties.VectorIndexes).toBeUndefined();
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'project', KeyType: 'HASH' },
      { AttributeName: 'ruleId', KeyType: 'RANGE' },
    ],
  });
  const rulesTable = Object.values(tables).find((table) =>
    JSON.stringify(table.Properties.KeySchema).includes('ruleId'),
  );
  expect(rulesTable).toBeDefined();
  expect(rulesTable?.Properties.VectorIndexes).toBeUndefined();
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'project', KeyType: 'HASH' },
      { AttributeName: 'draftId', KeyType: 'RANGE' },
    ],
  });
  const draftsTable = Object.values(tables).find((table) =>
    JSON.stringify(table.Properties.KeySchema).includes('draftId'),
  );
  expect(draftsTable).toBeDefined();
  expect(draftsTable?.Properties.VectorIndexes).toBeUndefined();
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'project', KeyType: 'HASH' },
      { AttributeName: 'ticketId', KeyType: 'RANGE' },
    ],
  });
  const breakdownsTable = Object.values(tables).find((table) =>
    JSON.stringify(table.Properties.KeySchema).includes('ticketId'),
  );
  expect(breakdownsTable).toBeDefined();
  expect(breakdownsTable?.Properties.VectorIndexes).toBeUndefined();
  template.hasOutput('BreakdownsTableName', {
    Description: Match.stringLikeRegexp('breakdownId'),
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

test('the knowledge base reads the documents bucket only', () => {
  const template = Template.fromStack(stackOf(createApp(), DEFAULT_STACK_NAME));
  const buckets = template.findResources('AWS::S3::Bucket');
  const transcriptBucketId = Object.keys(buckets).find((id) => id.startsWith('Transcripts'));
  const documentsBucketId = Object.keys(buckets).find((id) => id.startsWith('Documents'));
  expect(transcriptBucketId).toBeDefined();
  expect(documentsBucketId).toBeDefined();
  if (!transcriptBucketId || !documentsBucketId) {
    throw new Error('expected transcript and documents buckets');
  }

  const dataSources = template.findResources('AWS::Bedrock::DataSource');
  expect(Object.keys(dataSources)).toHaveLength(1);
  const dataSource = Object.values(dataSources)[0];
  expect(dataSource.Properties.DataSourceConfiguration).toEqual({
    Type: 'S3',
    S3Configuration: { BucketArn: { 'Fn::GetAtt': [documentsBucketId, 'Arn'] } },
  });
  expect(dataSource.Properties.DataDeletionPolicy).toBe('RETAIN');
  expect(JSON.stringify(dataSource)).not.toContain(transcriptBucketId);

  template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
    KnowledgeBaseConfiguration: {
      Type: 'VECTOR',
      VectorKnowledgeBaseConfiguration: {
        EmbeddingModelConfiguration: {
          BedrockEmbeddingModelConfiguration: { Dimensions: EMBEDDING_DIMENSIONS },
        },
      },
    },
    StorageConfiguration: {
      Type: 'S3_VECTORS',
      S3VectorsConfiguration: { IndexArn: Match.anyValue() },
    },
  });
  template.hasResourceProperties('AWS::S3Vectors::Index', {
    DataType: 'float32',
    Dimension: EMBEDDING_DIMENSIONS,
    DistanceMetric: 'cosine',
    MetadataConfiguration: {
      NonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
    },
  });
  template.hasResource('AWS::Bedrock::KnowledgeBase', { DeletionPolicy: 'Retain' });
  template.hasResource('AWS::S3Vectors::VectorBucket', { DeletionPolicy: 'Retain' });
  template.hasResource('AWS::S3Vectors::Index', { DeletionPolicy: 'Retain' });

  const knowledgeBases = template.findResources('AWS::Bedrock::KnowledgeBase');
  const knowledgeBaseId = Object.keys(knowledgeBases)[0];
  const policyIds = Object.keys(template.findResources('AWS::IAM::Policy')).filter((id) =>
    id.startsWith('KnowledgeBaseRoleDefaultPolicy'),
  );
  expect(policyIds).toHaveLength(1);
  expect(knowledgeBases[knowledgeBaseId].DependsOn).toEqual(expect.arrayContaining(policyIds));
  const roleId = Object.values(knowledgeBases)[0].Properties.RoleArn['Fn::GetAtt'][0];
  const rolePolicies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
    JSON.stringify(policy.Properties.Roles).includes(roleId),
  );
  const rolePolicy = JSON.stringify(rolePolicies);
  expect(rolePolicy).toContain(documentsBucketId);
  expect(rolePolicy).not.toContain(transcriptBucketId);
  expect(rolePolicy).toContain('amazon.titan-embed-text-v2:0');

  template.hasResourceProperties('AWS::Lambda::Function', {
    Timeout: 30,
    Environment: {
      Variables: Match.objectLike({
        KNOWLEDGE_BASE_ID: Match.anyValue(),
        DATA_SOURCE_ID: Match.anyValue(),
      }),
    },
  });
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    BatchSize: 100,
    MaximumBatchingWindowInSeconds: 30,
  });
  const queues = template.findResources('AWS::SQS::Queue');
  expect(
    Object.keys(queues).some((id) => id.startsWith('IngestDocuments') && !id.includes('Failure')),
  ).toBe(true);
  const documentNotifications = Object.values(template.findResources('Custom::S3BucketNotifications')).filter(
    (resource) => JSON.stringify(resource.Properties.BucketName).includes(documentsBucketId),
  );
  expect(documentNotifications).toHaveLength(1);
  expect(JSON.stringify(documentNotifications[0].Properties.NotificationConfiguration)).toContain('QueueConfigurations');

  template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    AgentRuntimeName: 'minivela_agent',
    ProtocolConfiguration: 'HTTP',
    EnvironmentVariables: Match.objectLike({
      KNOWLEDGE_BASE_ID: Match.anyValue(),
      ANSWER_MODEL_ID: EXTRACT_MODEL_ID,
      DECISIONS_TABLE_NAME: Match.anyValue(),
      RULES_TABLE_NAME: Match.anyValue(),
      REPOS_TABLE_NAME: Match.anyValue(),
      DRAFTS_TABLE_NAME: Match.anyValue(),
      BREAKDOWNS_TABLE_NAME: Match.anyValue(),
      DOCUMENTS_BUCKET_NAME: Match.anyValue(),
    }),
  });
  const runtime = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'))[0] as {
    Properties: { RoleArn: { 'Fn::GetAtt': string[] } };
  };
  const agentRoleId = runtime.Properties.RoleArn['Fn::GetAtt'][0];
  const agentPolicies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
    JSON.stringify(policy.Properties.Roles).includes(agentRoleId),
  );
  const agentPolicy = JSON.stringify(agentPolicies);
  const breakdownTableId = Object.keys(template.findResources('AWS::DynamoDB::Table')).find((id) =>
    JSON.stringify(template.findResources('AWS::DynamoDB::Table')[id].Properties.KeySchema).includes('ticketId'),
  );
  expect(breakdownTableId).toBeDefined();
  expect(agentPolicy.split(breakdownTableId ?? '').length - 1).toBe(3);
  expect(agentPolicy).toContain('s3:ListBucket');
  expect(agentPolicy).toContain('s3:GetObject');
  expect(agentPolicy).toContain(documentsBucketId);
  const templateJson = JSON.stringify(template.toJSON());
  expect(templateJson).toContain('bedrock:Retrieve');
  expect(templateJson).toContain('dynamodb:SearchVectors');
  expect(templateJson).toContain('dynamodb:Query');
  expect(templateJson).toContain('dynamodb:PutItem');
  expect(templateJson).toContain('dynamodb:GetItem');
  expect(templateJson).toContain(`/index/${DECISIONS_VECTOR_INDEX}`);
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
