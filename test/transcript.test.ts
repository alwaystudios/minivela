import { readFileSync } from 'node:fs';
import { decisionIdFor } from '../lib/decision-id.js';
import { decisionsFromModelText, transcriptUserMessage } from '../lib/extract-response.js';
import { EMBEDDING_DIMENSIONS } from '../lib/models.js';
import { type DecisionWrite, processTranscriptObject } from '../lib/process-transcript.js';
import { decodeS3Key, projectFromTranscriptKey } from '../lib/transcript-key.js';
import { parseVtt } from '../lib/vtt.js';

const MEETING = `WEBVTT

NOTE This is a caption note

00:00:15.500 --> 00:00:20.000
<v Priya Shah>Great. And I think we agreed v1 ships CSV only, not Excel, right?</v>

00:00:20.500 --> 00:00:26.000
<v Marcus Webb>Yes, that's locked in. Excel export is out of scope for v1.</v>

00:00:38.500 --> 00:00:44.000
<v Priya Shah>Anything else? No? Ok let's wrap up.</v>
`;

const DECISION_QUOTE = "Yes, that's locked in. Excel export is out of scope for v1.";

function modelJson(decisions: unknown[]): string {
  return JSON.stringify({
    summary: 'A summary that must not be stored.',
    actions: [
      {
        title: 'Fix the bug',
        content: 'Marcus will fix it.',
        quote: 'I will fix it.',
        speaker: 'Marcus Webb',
        timestamp: '00:09',
      },
    ],
    decisions,
  });
}

test('parses cue speaker and start time, and skips notes', () => {
  const cues = parseVtt(MEETING);

  expect(cues.map((cue) => [cue.speaker, cue.start, cue.text])).toEqual([
    ['Priya Shah', '00:00:15.500', 'Great. And I think we agreed v1 ships CSV only, not Excel, right?'],
    ['Marcus Webb', '00:00:20.500', DECISION_QUOTE],
    ['Priya Shah', '00:00:38.500', 'Anything else? No? Ok let\'s wrap up.'],
  ]);
});

test('a cue with no speaker keeps an empty speaker', () => {
  const cues = parseVtt('WEBVTT\n\n00:01:00.000 --> 00:01:05.000\nWe agreed to keep the export as CSV.\n');

  expect(cues).toEqual([
    {
      start: '00:01:00.000',
      speaker: '',
      text: 'We agreed to keep the export as CSV.',
    },
  ]);
});

test('project comes from the transcripts prefix', () => {
  expect(projectFromTranscriptKey('demo/transcripts/standup.vtt')).toBe('demo');
  expect(projectFromTranscriptKey('global/transcripts/all-hands.vtt')).toBe('global');
  expect(projectFromTranscriptKey(decodeS3Key('demo/transcripts/sprint%20review.vtt'))).toBe('demo');
  expect(projectFromTranscriptKey('demo/jira/DEMO-1.vtt')).toBeUndefined();
  expect(projectFromTranscriptKey('demo/transcripts/nested/standup.vtt')).toBeUndefined();
  expect(projectFromTranscriptKey('transcripts/standup.vtt')).toBeUndefined();
});

test('the copied prompt still wraps the transcript as untrusted content', () => {
  const system = readFileSync('lib/extract/system-prompt.txt', 'utf8');
  const template = readFileSync('lib/extract/user-message-template.txt', 'utf8');
  const user = transcriptUserMessage(template, MEETING);

  expect(system).toContain('Pass 1 — discard non-speech cues');
  expect(system).toContain('Always include all three keys');
  expect(user.startsWith('<<<UNTRUSTED_CONTENT>>>')).toBe(true);
  expect(user.endsWith('<<<END_UNTRUSTED_CONTENT>>>\n') || user.endsWith('<<<END_UNTRUSTED_CONTENT>>>')).toBe(true);
  expect(user).toContain(MEETING);
  expect(user).not.toContain('{{transcript}}');
});

test('model summary and actions are discarded, and the cue supplies speaker and time', async () => {
  const extract = jest.fn(async () =>
    modelJson([
      {
        title: 'CSV-only v1 scope',
        content: 'v1 ships CSV export only; Excel export is out of scope for v1.',
        quote: DECISION_QUOTE,
        speaker: 'Someone Else',
        timestamp: '00:20',
      },
    ]),
  );
  const embed = jest.fn(async () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1));
  const written: DecisionWrite[] = [];

  const result = await processTranscriptObject({
    key: 'demo/transcripts/standup.vtt',
    body: MEETING,
    loggedAt: '2026-10-15T11:00:00.000Z',
    systemPrompt: 'system',
    userMessageTemplate: '<<<UNTRUSTED_CONTENT>>>\n{{transcript}}\n<<<END_UNTRUSTED_CONTENT>>>',
    extract,
    embed,
    put: async (item) => {
      written.push(item);
    },
  });

  expect(result).toEqual({ outcome: 'stored', stored: 1, dropped: 0 });
  expect(extract).toHaveBeenCalledTimes(1);
  expect(written).toEqual([
    {
      project: 'demo',
      decisionId: decisionIdFor('demo/transcripts/standup.vtt', DECISION_QUOTE),
      title: 'CSV-only v1 scope',
      content: 'v1 ships CSV export only; Excel export is out of scope for v1.',
      quote: DECISION_QUOTE,
      speaker: 'Marcus Webb',
      timestamp: '00:00:20.500',
      loggedAt: '2026-10-15T11:00:00.000Z',
      sourceKey: 'demo/transcripts/standup.vtt',
      embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1),
    },
  ]);
  expect(embed).toHaveBeenCalledWith(
    'CSV-only v1 scope\nv1 ships CSV export only; Excel export is out of scope for v1.',
  );
});

test('a global transcript is stored under project global', async () => {
  const written: DecisionWrite[] = [];
  await processTranscriptObject({
    key: 'global/transcripts/all-hands.vtt',
    body: MEETING,
    loggedAt: '2026-10-15T11:00:00.000Z',
    systemPrompt: 'system',
    userMessageTemplate: '{{transcript}}',
    extract: async () =>
      modelJson([
        { title: 'CSV-only v1 scope', content: 'CSV only.', quote: DECISION_QUOTE },
      ]),
    embed: async () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0),
    put: async (item) => {
      written.push(item);
    },
  });

  expect(written.map((item) => item.project)).toEqual(['global']);
});

test('a quote that is not one cue is dropped, and an ungrounded file writes nothing', async () => {
  const embed = jest.fn();
  const result = await processTranscriptObject({
    key: 'demo/transcripts/standup.vtt',
    body: MEETING,
    loggedAt: '2026-10-15T11:00:00.000Z',
    systemPrompt: 'system',
    userMessageTemplate: '{{transcript}}',
    extract: async () =>
      modelJson([
        { title: 'Invented', content: 'Not said.', quote: 'We will rewrite the billing service.' },
        { title: 'Repeated', content: 'Said twice.', quote: 'Excel' },
      ]),
    embed,
    put: async () => {
      throw new Error('should not write');
    },
  });

  expect(result).toEqual({ outcome: 'stored', stored: 0, dropped: 2 });
  expect(embed).not.toHaveBeenCalled();
});

test('objects outside the transcripts prefix are ignored', async () => {
  const extract = jest.fn();
  const result = await processTranscriptObject({
    key: 'demo/jira/DEMO-1.vtt',
    body: MEETING,
    loggedAt: '2026-10-15T11:00:00.000Z',
    systemPrompt: 'system',
    userMessageTemplate: '{{transcript}}',
    extract,
    embed: async () => [],
    put: async () => undefined,
  });

  expect(result).toEqual({ outcome: 'ignored' });
  expect(extract).not.toHaveBeenCalled();
});

test('the same file and quote keep the same decision id', () => {
  expect(decisionIdFor('demo/transcripts/standup.vtt', DECISION_QUOTE)).toBe(
    decisionIdFor('demo/transcripts/standup.vtt', DECISION_QUOTE),
  );
  expect(decisionIdFor('demo/transcripts/standup.vtt', DECISION_QUOTE)).not.toBe(
    decisionIdFor('demo/transcripts/other.vtt', DECISION_QUOTE),
  );
});

test('a response without a decisions array fails', () => {
  expect(() => decisionsFromModelText('not json')).toThrow(/JSON/);
  expect(() => decisionsFromModelText('{"summary":"only"}')).toThrow(/decisions/);
  expect(decisionsFromModelText(modelJson([]))).toEqual([]);
});
