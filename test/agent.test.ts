import { answerFromDocuments, parseInvokePayload } from '../lib/agent/answer.js';
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

test('answer uses retrieved chunks for that project', async () => {
  const retrieve = jest.fn().mockResolvedValue([{ text: 'single table', uri: 's3://doc/rfc.md' }]);
  const complete = jest.fn().mockResolvedValue('Use a single table.');
  const result = await answerFromDocuments({
    prompt: 'RFC 162',
    project: 'bpp',
    retrieve,
    complete,
  });
  expect(retrieve).toHaveBeenCalledWith({ prompt: 'RFC 162', project: 'bpp' });
  expect(complete).toHaveBeenCalledWith({
    prompt: 'RFC 162',
    project: 'bpp',
    chunks: [{ text: 'single table', uri: 's3://doc/rfc.md' }],
  });
  expect(result).toEqual({ response: 'Use a single table.', status: 'success' });
});
