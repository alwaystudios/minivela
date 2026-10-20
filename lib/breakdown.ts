import type { AnswerResult } from './agent/answer.js';

export type BreakdownKind = 'epic' | 'story' | 'refusal';

export type BreakdownRow = {
  project: string;
  ticketId: string;
  breakdownId: string;
  kind: BreakdownKind;
  ordinal: number;
  body: string;
  createdAt: string;
};

export function breakdownTicketId(breakdownId: string, ordinal: number): string {
  return `${breakdownId}#${ordinal}`;
}

export function breakdownQueryInput(
  tableName: string,
  project: string,
  breakdownId: string,
): {
  TableName: string;
  KeyConditionExpression: string;
  ExpressionAttributeNames: { '#p': 'project'; '#t': 'ticketId' };
  ExpressionAttributeValues: { ':p': string; ':prefix': string };
} {
  return {
    TableName: tableName,
    KeyConditionExpression: '#p = :p AND begins_with(#t, :prefix)',
    ExpressionAttributeNames: { '#p': 'project', '#t': 'ticketId' },
    ExpressionAttributeValues: { ':p': project, ':prefix': `${breakdownId}#` },
  };
}

export function renderBreakdown(rows: BreakdownRow[]): string {
  const breakdownId = rows[0]?.breakdownId ?? '';
  const refusal = rows.find((row) => row.kind === 'refusal');
  if (refusal && rows.length === 1) {
    return document(breakdownId, [refusal.body]);
  }
  const epic = rows.find((row) => row.kind === 'epic');
  const stories = rows.filter((row) => row.kind === 'story').sort((left, right) => left.ordinal - right.ordinal);
  return document(breakdownId, [epic?.body ?? '', ...stories.map((row) => row.body)]);
}

export async function readBreakdown(input: {
  project: string;
  breakdownId: string;
  query: (key: { project: string; breakdownId: string }) => Promise<unknown[]>;
}): Promise<AnswerResult> {
  const items = await input.query({ project: input.project, breakdownId: input.breakdownId });
  const rows: BreakdownRow[] = [];
  let sawThisBreakdown = false;
  for (const item of items) {
    const classified = classifyRow(item, input.project, input.breakdownId);
    if (classified === 'other') {
      continue;
    }
    sawThisBreakdown = true;
    if (classified === 'invalid') {
      return { response: 'The stored breakdown could not be read.', status: 'error' };
    }
    rows.push(classified);
  }
  if (!sawThisBreakdown || rows.length === 0) {
    return { response: 'No breakdown with that id.', status: 'error' };
  }
  if (!isRenderable(rows)) {
    return { response: 'The stored breakdown could not be read.', status: 'error' };
  }
  return { response: renderBreakdown(rows), status: 'success' };
}

function document(breakdownId: string, bodies: string[]): string {
  return `Breakdown: ${breakdownId}\n\n${bodies.map((body) => body.trim()).join('\n\n')}\n`;
}

function classifyRow(item: unknown, project: string, breakdownId: string): BreakdownRow | 'other' | 'invalid' {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    return 'invalid';
  }
  const raw = item as Record<string, unknown>;
  const itemProject = typeof raw.project === 'string' ? raw.project : '';
  const itemBreakdownId = typeof raw.breakdownId === 'string' ? raw.breakdownId : '';
  const ticketId = typeof raw.ticketId === 'string' ? raw.ticketId : '';
  if (itemProject !== project || (itemBreakdownId !== breakdownId && !ticketId.startsWith(`${breakdownId}#`))) {
    return 'other';
  }
  const row = breakdownRowFromItem(raw);
  if (!row || row.project !== project || row.breakdownId !== breakdownId) {
    return 'invalid';
  }
  return row;
}

function breakdownRowFromItem(raw: Record<string, unknown>): BreakdownRow | undefined {
  const project = nonEmptyString(raw.project);
  const ticketId = nonEmptyString(raw.ticketId);
  const breakdownId = nonEmptyString(raw.breakdownId);
  const kind = raw.kind;
  const ordinal = raw.ordinal;
  const body = nonEmptyString(raw.body);
  const createdAt = nonEmptyString(raw.createdAt);
  if (
    !project ||
    !ticketId ||
    !breakdownId ||
    (kind !== 'epic' && kind !== 'story' && kind !== 'refusal') ||
    typeof ordinal !== 'number' ||
    !Number.isInteger(ordinal) ||
    ordinal < 0 ||
    !body ||
    !createdAt ||
    ticketId !== breakdownTicketId(breakdownId, ordinal)
  ) {
    return undefined;
  }
  return { project, ticketId, breakdownId, kind, ordinal, body, createdAt };
}

function isRenderable(rows: BreakdownRow[]): boolean {
  const refusals = rows.filter((row) => row.kind === 'refusal');
  if (refusals.length > 0) {
    return refusals.length === 1 && rows.length === 1 && refusals[0].ordinal === 0;
  }
  const epics = rows.filter((row) => row.kind === 'epic');
  const stories = rows.filter((row) => row.kind === 'story');
  if (epics.length !== 1 || epics[0].ordinal !== 0 || stories.length !== rows.length - 1) {
    return false;
  }
  const ordinals = new Set(stories.map((row) => row.ordinal));
  return ordinals.size === stories.length && stories.every((row) => row.ordinal >= 1);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text ? text : undefined;
}
