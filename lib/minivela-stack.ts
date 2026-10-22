import * as path from 'node:path';
import * as esbuild from 'esbuild';
import * as cdk from 'aws-cdk-lib/core';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { BEDROCK_REGIONS, EMBED_MODEL_ID, EMBEDDING_DIMENSIONS, EXTRACT_MODEL_ID, GOOSE_MODEL_ID } from './models.js';
import { DECISIONS_VECTOR_INDEX } from './search-decisions.js';

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

    const repos = new dynamodb.Table(this, 'Repos', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'repoId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const rules = new dynamodb.Table(this, 'Rules', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ruleId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const templates = new dynamodb.Table(this, 'Templates', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'templateId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const drafts = new dynamodb.Table(this, 'Drafts', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'draftId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const sdlcRuns = new dynamodb.Table(this, 'SdlcRuns', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'runId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const breakdowns = new dynamodb.Table(this, 'Breakdowns', {
      partitionKey: { name: 'project', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'ticketId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const cfnDecisions = decisions.node.defaultChild as dynamodb.CfnTable;
    cfnDecisions.vectorIndexes = [
      {
        indexName: DECISIONS_VECTOR_INDEX,
        dimensions: EMBEDDING_DIMENSIONS,
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

    const extractFailures = new sqs.Queue(this, 'ExtractTranscriptFailures', {
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const extractTranscript = new NodejsFunction(this, 'ExtractTranscript', {
      entry: 'lib/transcript-lambda.ts',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(3),
      memorySize: 512,
      logGroup: transcriptLogs,
      deadLetterQueue: extractFailures,
      environment: {
        DECISIONS_TABLE_NAME: decisions.tableName,
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
          ...BEDROCK_REGIONS.map(
            (region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-6*`,
          ),
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBED_MODEL_ID}`,
        ],
      }),
    );

    transcripts.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(extractTranscript), {
      suffix: '.vtt',
    });

    const documents = new s3.Bucket(this, 'Documents', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket');
    vectorBucket.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const vectorIndex = new s3vectors.CfnIndex(this, 'VectorIndex', {
      dataType: 'float32',
      dimension: EMBEDDING_DIMENSIONS,
      distanceMetric: 'cosine',
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      metadataConfiguration: {
        nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'],
      },
    });
    vectorIndex.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const knowledgeBaseRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID },
          ArnLike: {
            'aws:SourceArn': `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:knowledge-base/*`,
          },
        },
      }),
    });
    documents.grantRead(knowledgeBaseRole);
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBED_MODEL_ID}`],
      }),
    );
    knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:GetIndex',
          's3vectors:QueryVectors',
          's3vectors:PutVectors',
          's3vectors:GetVectors',
          's3vectors:DeleteVectors',
        ],
        resources: [vectorIndex.attrIndexArn],
      }),
    );

    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: cdk.Names.uniqueResourceName(documents, { maxLength: 100 }),
      roleArn: knowledgeBaseRole.roleArn,
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBED_MODEL_ID}`,
          embeddingModelConfiguration: {
            bedrockEmbeddingModelConfiguration: {
              dimensions: EMBEDDING_DIMENSIONS,
            },
          },
        },
      },
      storageConfiguration: {
        type: 'S3_VECTORS',
        s3VectorsConfiguration: {
          indexArn: vectorIndex.attrIndexArn,
        },
      },
    });
    knowledgeBase.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    knowledgeBase.node.addDependency(knowledgeBaseRole.node.findChild('DefaultPolicy'));

    const documentsDataSource = new bedrock.CfnDataSource(this, 'DocumentsDataSource', {
      name: 'documents',
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataDeletionPolicy: 'RETAIN',
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: documents.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'FIXED_SIZE',
          fixedSizeChunkingConfiguration: {
            maxTokens: 300,
            overlapPercentage: 20,
          },
        },
      },
    });
    documentsDataSource.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const ingestFailures = new sqs.Queue(this, 'IngestDocumentsFailures', {
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const ingestDocumentsQueue = new sqs.Queue(this, 'IngestDocuments', {
      visibilityTimeout: cdk.Duration.minutes(2),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: { queue: ingestFailures, maxReceiveCount: 20 },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const ingestLogs = new logs.LogGroup(this, 'IngestDocumentsLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const ingestDocuments = new NodejsFunction(this, 'IngestDocumentsFn', {
      entry: 'lib/sync-documents-lambda.ts',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      logGroup: ingestLogs,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        DATA_SOURCE_ID: documentsDataSource.attrDataSourceId,
      },
    });
    ingestDocuments.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'],
        resources: [knowledgeBase.attrKnowledgeBaseArn],
      }),
    );
    ingestDocuments.addEventSource(
      new SqsEventSource(ingestDocumentsQueue, {
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(30),
        reportBatchItemFailures: false,
      }),
    );
    documents.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(ingestDocumentsQueue));

    const agentArtifact = agentcore.AgentRuntimeArtifact.fromCodeAsset({
      path: path.join(process.cwd(), 'lib'),
      runtime: agentcore.AgentCoreRuntime.NODE_22,
      entrypoint: ['index.js'],
      bundling: {
        image: cdk.DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs22.x'),
        local: {
          tryBundle(outputDir: string): boolean {
            esbuild.buildSync({
              entryPoints: [path.join(process.cwd(), 'lib/agent/server.ts')],
              bundle: true,
              platform: 'node',
              format: 'cjs',
              outfile: path.join(outputDir, 'index.js'),
            });
            return true;
          },
        },
        command: ['bash', '-c', 'echo docker bundling is not used && exit 1'],
      },
    });
    const runtimeName = `${this.stackName.replace(/-/g, '_')}_agent`;
    const agent = new agentcore.Runtime(this, 'Agent', {
      runtimeName,
      description: 'Talk to minivela. Pass project on every invoke. The agent retrieves that client only.',
      agentRuntimeArtifact: agentArtifact,
      environmentVariables: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        ANSWER_MODEL_ID: EXTRACT_MODEL_ID,
        DECISIONS_TABLE_NAME: decisions.tableName,
        RULES_TABLE_NAME: rules.tableName,
        REPOS_TABLE_NAME: repos.tableName,
        DRAFTS_TABLE_NAME: drafts.tableName,
        SDLC_RUNS_TABLE_NAME: sdlcRuns.tableName,
        BREAKDOWNS_TABLE_NAME: breakdowns.tableName,
        TEMPLATES_TABLE_NAME: templates.tableName,
        DOCUMENTS_BUCKET_NAME: documents.bucketName,
      },
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
    });
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:Retrieve'],
        resources: [knowledgeBase.attrKnowledgeBaseArn],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [documents.bucketArn],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [documents.arnForObjects('*')],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${EXTRACT_MODEL_ID}`,
          ...BEDROCK_REGIONS.map(
            (region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-6*`,
          ),
          `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/${EMBED_MODEL_ID}`,
        ],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:SearchVectors'],
        resources: [decisions.tableArn, `${decisions.tableArn}/index/${DECISIONS_VECTOR_INDEX}`],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [decisions.tableArn, drafts.tableArn, breakdowns.tableArn, templates.tableArn],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [rules.tableArn, repos.tableArn, breakdowns.tableArn],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [drafts.tableArn, breakdowns.tableArn],
      }),
    );
    agent.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [sdlcRuns.tableArn],
      }),
    );
    new cdk.CfnOutput(this, 'TranscriptBucketName', {
      value: transcripts.bucketName,
      description: 'Drop a .vtt file at <project>/transcripts/<meeting>.vtt',
    });
    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: documents.bucketName,
      description: 'Knowledge base documents. Markdown and a sidecar beside each file. No transcripts.',
    });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.attrKnowledgeBaseId,
    });
    new cdk.CfnOutput(this, 'DocumentsDataSourceId', {
      value: documentsDataSource.attrDataSourceId,
    });
    new cdk.CfnOutput(this, 'DecisionsTableName', {
      value: decisions.tableName,
    });
    new cdk.CfnOutput(this, 'ReposTableName', {
      value: repos.tableName,
      description: 'Repo map. Query by project. Each item is owner, repo, url, summary.',
    });
    new cdk.CfnOutput(this, 'RulesTableName', {
      value: rules.tableName,
      description: 'Hard rules. Query global when drafting a work order. Each item is ruleId, title, body. No vectors.',
    });
    new cdk.CfnOutput(this, 'TemplatesTableName', {
      value: templates.tableName,
      description:
        'Ticket template. Partition project, sort templateId, and the only id is ticket. body is the template. The project row replaces global. No row means ordinary Jira practice.',
    });
    new cdk.CfnOutput(this, 'DraftsTableName', {
      value: drafts.tableName,
      description: 'Work-order drafts. Partition project, sort draftId. Each item is workOrder, citations, createdAt. workOrder.rules is the rules loaded for that draft. workOrder.rulePrecedence says the written code follows the rule, the order wins on policy, and a missing or conflicting fact is a failed premise. workOrder.consequences is what a rule requires of this change. workOrder.premises is what to confirm before building.',
    });
    new cdk.CfnOutput(this, 'BreakdownsTableName', {
      value: breakdowns.tableName,
      description:
        'Page breakdowns. Partition project, sort ticketId as <breakdownId>#<ordinal>. Each item is breakdownId, kind, ordinal, body, createdAt. The epic records the source page. A refusal records it too. A story does not. A fetch renders one breakdown.',
    });
    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agent.agentRuntimeArn,
      description: 'Talk to minivela here. Pass prompt and project. IAM auth.',
    });

    const gooseRuntimeName = `${this.stackName.replace(/-/g, '_').slice(0, 42)}_goose`;
    const goose = new agentcore.Runtime(this, 'Goose', {
      runtimeName: gooseRuntimeName,
      description: 'Apply a stored work order with Goose. Pass project and draftId. IAM auth.',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(process.cwd(), {
        file: 'goose/Dockerfile',
        platform: Platform.LINUX_ARM64,
        exclude: ['cdk.out', 'node_modules', 'test', 'docs', 'samples', '.git'],
      }),
      protocolConfiguration: agentcore.ProtocolType.HTTP,
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingIAM(),
      lifecycleConfiguration: {
        idleRuntimeSessionTimeout: cdk.Duration.seconds(300),
        maxLifetime: cdk.Duration.seconds(900),
      },
      environmentVariables: {
        GOOSE_PROVIDER: 'aws_bedrock',
        GOOSE_MODEL: GOOSE_MODEL_ID,
        GOOSE_MODE: 'auto',
        GOOSE_DISABLE_SESSION_NAMING: 'true',
        GOOSE_PATH_ROOT: '/tmp/goose',
        DRAFTS_TABLE_NAME: drafts.tableName,
        SDLC_RUNS_TABLE_NAME: sdlcRuns.tableName,
      },
    });
    goose.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:inference-profile/${GOOSE_MODEL_ID}`,
          ...BEDROCK_REGIONS.map(
            (region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-6*`,
          ),
        ],
      }),
    );
    goose.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem'],
        resources: [drafts.tableArn],
      }),
    );
    goose.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [sdlcRuns.tableArn],
      }),
    );
    new cdk.CfnOutput(this, 'GooseRuntimeArn', {
      value: goose.agentRuntimeArn,
      description: 'Apply a stored work order with Goose. Pass project and draftId. IAM auth.',
    });

    grantProjectSecretReadToEveryRuntime(this);
  }
}

function grantProjectSecretReadToEveryRuntime(scope: Construct): void {
  for (const child of scope.node.findAll()) {
    if (child instanceof agentcore.Runtime) {
      child.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:minivela/*`],
        }),
      );
    }
  }
}
