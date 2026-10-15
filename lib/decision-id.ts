import { createHash } from 'node:crypto';

export function decisionIdFor(sourceKey: string, quote: string): string {
  return createHash('sha256').update(sourceKey, 'utf8').update('\0').update(quote, 'utf8').digest('hex');
}
