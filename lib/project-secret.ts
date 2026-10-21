import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const SEGMENT = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function projectSecretName(project: string, name: string): string {
  const projectId = project.trim();
  const secretName = name.trim();
  if (!SEGMENT.test(projectId) || !SEGMENT.test(secretName)) {
    throw new Error('a project secret is minivela/<project>/<name>');
  }
  return `minivela/${projectId}/${secretName}`;
}

export type ProjectSecretClient = {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
};

export async function getProjectSecret(
  project: string,
  name: string,
  secrets?: ProjectSecretClient,
): Promise<string> {
  const secretId = projectSecretName(project, name);
  const client = secrets ?? new SecretsManagerClient({});
  let secret: string | undefined;
  try {
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    secret = response.SecretString;
  } catch {
    throw new Error(`project secret ${secretId} is missing or unreadable`);
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`project secret ${secretId} is missing or unreadable`);
  }
  return secret;
}
