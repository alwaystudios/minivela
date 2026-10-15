const TRANSCRIPT_KEY = /^([^/]+)\/transcripts\/([^/]+)\.vtt$/;

export function decodeS3Key(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, ' '));
}

export function projectFromTranscriptKey(key: string): string | undefined {
  const match = TRANSCRIPT_KEY.exec(key);
  if (!match) {
    return undefined;
  }
  const project = match[1];
  if (project === '.' || project === '..') {
    return undefined;
  }
  return project;
}
