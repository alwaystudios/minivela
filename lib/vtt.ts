export type Cue = {
  start: string;
  speaker: string;
  text: string;
};

const TIMING = /^(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->/;

export function parseVtt(source: string): Cue[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0 || isPreamble(lines[0])) {
      continue;
    }
    let timingIndex = 0;
    if (!TIMING.test(lines[0]) && lines[1] && TIMING.test(lines[1])) {
      timingIndex = 1;
    }
    const timing = lines[timingIndex];
    if (!timing || !TIMING.test(timing)) {
      continue;
    }
    const payload = parsePayload(lines.slice(timingIndex + 1).join('\n'));
    if (!payload.text) {
      continue;
    }
    cues.push({
      start: timing.split('-->')[0].trim(),
      speaker: payload.speaker,
      text: payload.text,
    });
  }
  return cues;
}

function isPreamble(line: string): boolean {
  return /^WEBVTT\b/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line);
}

function parsePayload(payload: string): { speaker: string; text: string } {
  const voice = payload.match(/<v(?:\.[^\s>]+)*\s+([^>]+)>/);
  const speaker = voice?.[1]?.trim() ?? '';
  const text = payload
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { speaker, text };
}
