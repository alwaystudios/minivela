import * as cdk from 'aws-cdk-lib/core';
import { MinivelaStack } from './minivela-stack.js';
import { stackNameFromContext } from './stack-name.js';

export function createApp(props?: cdk.AppProps): cdk.App {
  const app = new cdk.App({
    ...props,
    analyticsReporting: false,
  });
  const stackName = stackNameFromContext(app.node.tryGetContext('stackName'));
  new MinivelaStack(app, stackName, { stackName });
  return app;
}
