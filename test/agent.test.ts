import { answerFromMemory, parseInvokePayload } from '../lib/agent/answer.js';
import { projectRetrieveFilter, projectRetrieveValues } from '../lib/project-filter.js';

test('a retrieve for a client includes global', () => {
  expect(projectRetrieveValues('bpp')).toEqual(['bpp', 'global']);
  expect(projectRetrieveFilter('bpp')).toEqual({ in: { key: 'project', value: ['bpp', 'global'] } });
});

test('a retrieve for global does not open other clients', () => {
  expect(projectRetrieveValues('global')).toEqual(['global']);
});

test('an empty project is invalid', () => {
  expect(() => projectRetrieveValues('  ')).toThrow(/project/);
});

test('invoke without a project is rejected', () => {
  expect(parseInvokePayload({ prompt: 'what is RFC 162' })).toEqual({
    response: 'Name a project. The agent will not search without one.',
    status: 'error',
  });
});

test('invoke without a prompt is rejected', () => {
  expect(parseInvokePayload({ project: 'bpp' })).toMatchObject({ status: 'error' });
});

test('answer uses retrieved decisions and documents for that project', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockResolvedValue([
    {
      project: 'bpp',
      decisionId: 'abc',
      title: 'CSV only',
      content: 'v1 ships CSV.',
      quote: 'Excel is out of scope.',
      speaker: 'Marcus Webb',
      timestamp: '00:00:20.500',
      loggedAt: '2026-10-15T12:00:00.000Z',
      sourceKey: 'bpp/transcripts/standup.vtt',
    },
  ]);
  const complete = jest.fn().mockResolvedValue('CSV only. Cite the later loggedAt.');
  const result = await answerFromMemory({
    prompt: 'RFC 162',
    project: 'bpp',
    retrieve,
    searchDecisions,
    complete,
  });
  expect(retrieve).toHaveBeenCalledWith({ prompt: 'RFC 162', project: 'bpp' });
  expect(searchDecisions).toHaveBeenCalledWith({ prompt: 'RFC 162', project: 'bpp' });
  expect(complete).toHaveBeenCalledWith({
    prompt: 'RFC 162',
    project: 'bpp',
    chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
    decisions: [
      {
        project: 'bpp',
        decisionId: 'abc',
        title: 'CSV only',
        content: 'v1 ships CSV.',
        quote: 'Excel is out of scope.',
        speaker: 'Marcus Webb',
        timestamp: '00:00:20.500',
        loggedAt: '2026-10-15T12:00:00.000Z',
        sourceKey: 'bpp/transcripts/standup.vtt',
      },
    ],
  });
  expect(result).toEqual({ response: 'CSV only. Cite the later loggedAt.', status: 'success' });
});

test('a failed decision search still answers from documents', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const searchDecisions = jest.fn().mockRejectedValue(new Error('SearchVectors failed'));
  const complete = jest.fn().mockResolvedValue('Use a single table.');
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await answerFromMemory({
      prompt: 'RFC 162',
      project: 'bpp',
      retrieve,
      searchDecisions,
      complete,
    });
    expect(complete).toHaveBeenCalledWith({
      prompt: 'RFC 162',
      project: 'bpp',
      chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
      decisions: [],
    });
    expect(result).toEqual({ response: 'Use a single table.', status: 'success' });
  } finally {
    error.mockRestore();
  }
});
