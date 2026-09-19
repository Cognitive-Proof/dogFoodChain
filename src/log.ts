import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { LineEnvelope } from './types';

export function readLog(path: string): LineEnvelope[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LineEnvelope);
}

export function appendLine(path: string, line: LineEnvelope): void {
  appendFileSync(path, JSON.stringify(line) + '\n', 'utf8');
}

export function nextSeq(path: string): number {
  const lines = readLog(path);
  return lines.length === 0 ? 0 : lines[lines.length - 1].seq + 1;
}

export function initLog(path: string, genesis: LineEnvelope): void {
  if (existsSync(path)) {
    throw new Error(`${path} already exists — refusing to overwrite an existing log`);
  }
  writeFileSync(path, JSON.stringify(genesis) + '\n', 'utf8');
}
