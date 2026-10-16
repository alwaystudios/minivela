const TICKET_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export function isTicketKey(value: string): boolean {
  return TICKET_KEY.test(value);
}

export function ticketObjectKey(project: string, ticket: string): string {
  return `${project}/jira/${ticket}.md`;
}

export function promptForInvoke(prompt: string | undefined, ticketText: string | undefined): string {
  const question = prompt?.trim() ?? '';
  if (question) {
    return question;
  }
  return ticketText?.trim() ?? '';
}

export async function readTicketMarkdown(input: {
  bucket: string;
  project: string;
  ticket: string;
  read: (key: string) => Promise<string | undefined>;
}): Promise<{ chunk: { text: string; uri: string } } | { response: string; status: 'error' }> {
  const key = ticketObjectKey(input.project, input.ticket);
  const text = (await input.read(key))?.trim() ?? '';
  if (!text) {
    return { response: `No object at ${key}.`, status: 'error' };
  }
  return { chunk: { text, uri: `s3://${input.bucket}/${key}` } };
}
