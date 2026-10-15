import * as cdk from 'aws-cdk-lib/core';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';
import { EMBED_MODEL_ID, EXTRACT_MODEL_ID } from './models.js';

export class MinivelaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const transcripts = new s3.Bucket(this, 'Transcripts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const decisions = new dynamodb.Table(this, 'Decisions', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'decisionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const cfnDecisions = decisions.node.defaultChild as dynamodb.CfnTable;
    cfnDecisions.vectorIndexes = [
      {
        indexName: 'decisions-by-project',
        dimensions: 1024,
        distanceFunction: 'COSINE',
        vectorAttribute: { attributeName: 'embedding' },
        projection: { projectionType: 'ALL' },
        searchSchema: [{ attributeName: 'project', searchSchemaElementType: 'HASH' }],
      },
    ];

    const transcriptLogs = new logs.LogGroup(this, 'TranscriptLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const extractTranscript = new NodejsFunction(this, 'ExtractTranscript', {
      entry: 'lib/transcript-lambda.ts',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      logGroup: transcriptLogs,
      environment: {
        DECISIONS_TABLE_NAME: decisions.tableName,
        EXTRACT_MODEL_ID: EXTRACT_MODEL_ID,
        EMBED_MODEL_ID: EMBED_MODEL_ID,
      },
      bundling: {
        loader: { '.txt': 'text' },
      },
    });

    transcripts.grantRead(extractTranscript);
    decisions.grant(extractTranscript, 'dynamodb:PutItem');
    extractTranscript.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${EXTRACT_MODEL_ID}`,
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
          'arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0',
        ],
      }),
    );

    transcripts.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(extractTranscript), {
      suffix: '.vtt',
    });

    new cdk.CfnOutput(this, 'TranscriptBucketName', {
      value: transcripts.bucketName,
      description: 'Drop a .vtt file at <project>/transcripts/<meeting>.vtt',
    });
    new cdk.CfnOutput(this, 'DecisionsTableName', {
      value: decisions.tableName,
    });
  }
}
