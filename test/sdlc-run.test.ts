import { estimateSdlcRun } from '../lib/sdlc-run.js';

test('one million input and output tokens for deepseek.v3.2 estimate to 2.47', () => {
  expect(
    estimateSdlcRun({ modelId: 'deepseek.v3.2', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  ).toEqual({ estimatedUsd: 2.47 });
});

test('one million input and output tokens for us.anthropic.claude-sonnet-4-6 estimate to 18', () => {
  expect(
    estimateSdlcRun({ modelId: 'us.anthropic.claude-sonnet-4-6', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  ).toEqual({ estimatedUsd: 18 });
});

test('an unknown model id is an error and has no price', () => {
  expect(estimateSdlcRun({ modelId: 'other', inputTokens: 1, outputTokens: 1 })).toEqual({ status: 'error' });
});
