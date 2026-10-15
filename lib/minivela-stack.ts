import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export class MinivelaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    cdk.Validations.of(this).acknowledge({
      id: 'CloudFormation-Validate::F0001',
      reason: 'The stack has no resources.',
    });
  }
}
