import { decisionIdFor } from './decision-id.js';
import { decisionsFromModelText, transcriptUserMessage } from './extract-response.js';
import { EMBEDDING_DIMENSIONS, MAX_EMBED_INPUT_CHARS } from './models.js';
import { projectFromTranscriptKey } from './transcript-key.js';
import { type Cue, parseVtt } from './vtt.js';

export type DecisionWrite = {
  project: string;
  decisionId: string;
  title: string;
  content: string;
  quote: string;
  speaker: string;
  timestamp: string;
  loggedAt: string;
  sourceKey: string;
  embedding: number[];
};

export type ProcessResult =
  | { outcome: 'ignored' }
  | { outcome: 'stored'; stored: number; dropped: number };

export async function processTranscriptObject(input: {
  key: string;
  body: string;
  loggedAt: string;
  systemPrompt: string;
  userMessageTemplate: string;
  extract: (request: { system: string; user: string }) => Promise<string>;
  embed: (text: string) => Promise<number[]>;
  put: (item: DecisionWrite) => Promise<void>;
}): Promise<ProcessResult> {
  const project = projectFromTranscriptKey(input.key);
  if (!project) {
    return { outcome: 'ignored' };
  }
  const cues = parseVtt(input.body);
  if (cues.length === 0) {
    return { outcome: 'stored', stored: 0, dropped: 0 };
  }
  const modelText = await input.extract({
    system: input.systemPrompt,
    user: transcriptUserMessage(input.userMessageTemplate, input.body),
  });
  const extracted = decisionsFromModelText(modelText);
  const grounded: Array<{ decision: { title: string; content: string; quote: string }; cue: Cue }> = [];
  let dropped = 0;
  for (const decision of extracted) {
    const cue = soleCue(decision.quote, cues);
    if (!cue) {
      dropped += 1;
      continue;
    }
    grounded.push({ decision, cue });
  }
  for (const { decision, cue } of grounded) {
    const text = `${decision.title}\n${decision.content}`;
    if (text.length > MAX_EMBED_INPUT_CHARS) {
      throw new Error(`decision text exceeds ${MAX_EMBED_INPUT_CHARS} characters`);
    }
    const embedding = await input.embed(text);
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`expected embedding length ${EMBEDDING_DIMENSIONS}`);
    }
    await input.put({
      project,
      decisionId: decisionIdFor(input.key, decision.quote),
      title: decision.title,
      content: decision.content,
      quote: decision.quote,
      speaker: cue.speaker,
      timestamp: cue.start,
      loggedAt: input.loggedAt,
      sourceKey: input.key,
      embedding,
    });
  }
  return { outcome: 'stored', stored: grounded.length, dropped };
}

function soleCue(quote: string, cues: Cue[]): Cue | undefined {
  const matches = cues.filter((cue) => cue.text.includes(quote));
  return matches.length === 1 ? matches[0] : undefined;
}
