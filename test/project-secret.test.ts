import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Template } from 'aws-cdk-lib/assertions';
import { createApp } from '../lib/app.js';
import { DEFAULT_STACK_NAME } from '../lib/stack-name.js';
import { getProjectSecret, projectSecretName, type ProjectSecretClient } from '../lib/project-secret.js';

test('a project secret is minivela/<project>/<name>', () => {
  expect(projectSecretName('acme', 'git-pat')).toBe('minivela/acme/git-pat');
  expect(projectSecretName(' acme ', 'jira')).toBe('minivela/acme/jira');
});

test.each(['', 'acme/git', '..', 'git pat', 'minivela/acme/git-pat'])(
  'rejects secret segment %j',
  (segment) => {
    expect(() => projectSecretName(segment, 'git-pat')).toThrow(/minivela\/<project>\/<name>/);
    expect(() => projectSecretName('acme', segment)).toThrow(/minivela\/<project>\/<name>/);
  },
);

test('getProjectSecret reads that name and returns the string', async () => {
  const secretId = await captureSecretId(async () => 'token-value');
  expect(secretId).toBe('minivela/acme/git-pat');
  await expect(getProjectSecret('acme', 'git-pat', client(async () => 'token-value'))).resolves.toBe('token-value');
});

test('a missing or unreadable secret is an error and the value is not in the message', async () => {
  await expect(getProjectSecret('acme', 'git-pat', client(async () => undefined))).rejects.toThrow(
    'project secret minivela/acme/git-pat is missing or unreadable',
  );
  await expect(
    getProjectSecret(
      'acme',
      'git-pat',
      client(async () => {
        throw new Error('denied token-value');
      }),
    ),
  ).rejects.toThrow('project secret minivela/acme/git-pat is missing or unreadable');
  await expect(
    getProjectSecret(
      'acme',
      'git-pat',
      client(async () => {
        throw new Error('denied token-value');
      }),
    ),
  ).rejects.not.toThrow(/token-value/);
});

test('every agent runtime can read minivela secrets and no other role can', () => {
  const app = createApp();
  const stack = app.node.findChild(DEFAULT_STACK_NAME);
  const template = Template.fromStack(stack as import('aws-cdk-lib/core').Stack);
  expect(template.findResources('AWS::SecretsManager::Secret')).toEqual({});

  const runtimes = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime')) as Array<{
    Properties: { RoleArn: { 'Fn::GetAtt': string[] } };
  }>;
  expect(runtimes.length).toBeGreaterThan(1);
  const policies = template.findResources('AWS::IAM::Policy');
  const runtimeRoleIds = runtimes.map((runtime) => runtime.Properties.RoleArn['Fn::GetAtt'][0]);

  for (const roleId of runtimeRoleIds) {
    const rolePolicies = Object.values(policies).filter((policy) =>
      JSON.stringify(policy.Properties.Roles).includes(roleId),
    );
    const policy = JSON.stringify(rolePolicies);
    expect(policy).toContain('secretsmanager:GetSecretValue');
    expect(policy).toContain('secret:minivela/*');
    expect(policy).not.toContain('secretsmanager:PutSecretValue');
    expect(policy).not.toContain('secretsmanager:CreateSecret');
    expect(policy).not.toContain('secret:*');
  }

  const other = Object.values(policies).filter((policy) => {
    const text = JSON.stringify(policy);
    return text.includes('secretsmanager:') && !runtimeRoleIds.some((roleId) => text.includes(roleId));
  });
  expect(other).toEqual([]);
});

function client(read: () => Promise<string | undefined>): ProjectSecretClient {
  return {
    async send(command: GetSecretValueCommand) {
      expect(command.input.SecretId).toBe('minivela/acme/git-pat');
      return { SecretString: await read() };
    },
  };
}

async function captureSecretId(read: () => Promise<string | undefined>): Promise<string | undefined> {
  let secretId: string | undefined;
  await getProjectSecret('acme', 'git-pat', {
    async send(command: GetSecretValueCommand) {
      secretId = command.input.SecretId;
      return { SecretString: await read() };
    },
  });
  return secretId;
}
