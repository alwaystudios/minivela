import * as cdk from 'aws-cdk-lib/core';
import { MinivelaStack } from './minivela-stack.js';
import { stackNameFromContext } from './stack-name.js';

export function createApp(props?: cdk.AppProps): cdk.App {
  const app = new cdk.App({
    ...props,
    analyticsReporting: false,
  });
  const stackName = stackNameFromContext(app.node.tryGetContext('stackName'));
  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const region = process.env.CDK_DEFAULT_REGION;
  new MinivelaStack(app, stackName, {
    stackName,
    ...(account && region ? { env: { account, region } } : {}),
  });
  return app;
}
