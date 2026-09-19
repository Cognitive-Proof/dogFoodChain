import type { LineEnvelope } from './types';

export function parseJsonl(text: string): LineEnvelope[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LineEnvelope);
}
