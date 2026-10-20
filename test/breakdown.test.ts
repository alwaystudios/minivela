import { breakdownQueryInput, breakdownTicketId, readBreakdown, type BreakdownRow } from '../lib/breakdown.js';

const createdAt = '2026-10-20T16:00:00.000Z';

function row(input: {
  breakdownId: string;
  kind: BreakdownRow['kind'];
  ordinal: number;
  body: string;
  project?: string;
}): BreakdownRow {
  return {
    project: input.project ?? 'acme',
    ticketId: breakdownTicketId(input.breakdownId, input.ordinal),
    breakdownId: input.breakdownId,
    kind: input.kind,
    ordinal: input.ordinal,
    body: input.body,
    createdAt,
  };
}

test('a breakdown sort key is the id and the ordinal', () => {
  expect(breakdownTicketId('bd-1', 0)).toBe('bd-1#0');
  expect(breakdownQueryInput('Breakdowns', 'acme', 'bd-1')).toEqual({
    TableName: 'Breakdowns',
    KeyConditionExpression: '#p = :p AND begins_with(#t, :prefix)',
    ExpressionAttributeNames: { '#p': 'project', '#t': 'ticketId' },
    ExpressionAttributeValues: { ':p': 'acme', ':prefix': 'bd-1#' },
  });
});

test('a refusal renders its body under the breakdown id', async () => {
  const stored = [
    row({ breakdownId: 'bd-r', kind: 'refusal', ordinal: 0, body: 'The page is empty.' }),
    row({ breakdownId: 'bd-1', kind: 'epic', ordinal: 0, body: '# Bill the new meter' }),
  ];
  const result = await readBreakdown({
    project: 'acme',
    breakdownId: 'bd-r',
    query: async () => stored,
  });
  expect(result).toEqual({
    response: 'Breakdown: bd-r\nStatus: refused\n\nThe page is empty.\n',
    status: 'refused',
  });
});

test('an epic is followed by its stories in ordinal order', async () => {
  const stored = [
    row({ breakdownId: 'bd-1', kind: 'story', ordinal: 2, body: '# Record the reading' }),
    row({ breakdownId: 'bd-1', kind: 'epic', ordinal: 0, body: '# Bill the new meter' }),
    row({ breakdownId: 'bd-1', kind: 'story', ordinal: 1, body: '# Show the tariff' }),
    row({ breakdownId: 'bd-2', kind: 'epic', ordinal: 0, body: '# Other epic' }),
    row({ breakdownId: 'bd-2', kind: 'story', ordinal: 1, body: '# Other story' }),
  ];
  const result = await readBreakdown({
    project: 'acme',
    breakdownId: 'bd-1',
    query: async (key) => {
      expect(key).toEqual({ project: 'acme', breakdownId: 'bd-1' });
      return stored;
    },
  });
  expect(result).toEqual({
    response: ['Breakdown: bd-1', 'Status: tickets', '', '# Bill the new meter', '', '# Show the tariff', '', '# Record the reading', ''].join(
      '\n',
    ),
    status: 'success',
  });
});

test('an unknown breakdown id returns an error', async () => {
  const result = await readBreakdown({
    project: 'acme',
    breakdownId: 'missing',
    query: async () => [row({ breakdownId: 'bd-1', kind: 'epic', ordinal: 0, body: '# Bill the new meter' })],
  });
  expect(result).toEqual({ response: 'No breakdown with that id.', status: 'error' });
});
