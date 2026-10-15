export type ModelDecision = {
  title: string;
  content: string;
  quote: string;
};

export function transcriptUserMessage(template: string, transcript: string): string {
  const token = '{{transcript}}';
  if (!template.includes(token)) {
    throw new Error('user message template is missing {{transcript}}');
  }
  return template.replace(token, transcript);
}

export function decisionsFromModelText(raw: string): ModelDecision[] {
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed.decisions)) {
    throw new Error('extract response did not contain a decisions array');
  }
  const decisions: ModelDecision[] = [];
  for (const item of parsed.decisions) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    const title = requiredText(record.title);
    const content = requiredText(record.content);
    const quote = requiredText(record.quote);
    if (!title || !content || !quote) {
      continue;
    }
    decisions.push({ title, content, quote });
  }
  return decisions;
}

function requiredText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(raw: string): { decisions?: unknown } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text) as { decisions?: unknown };
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('extract response was not JSON');
    }
    return JSON.parse(text.slice(start, end + 1)) as { decisions?: unknown };
  }
}
