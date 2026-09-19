import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getGcsStore, isGcsRef } from './gcsLogStore';
import { parseJsonl } from './jsonl';
import type { LineEnvelope } from './types';

/**
 * `ref` is either a local file path or a `gs://bucket/object` URI. Every function here
 * dispatches on that prefix — callers (commands, server, sync) never need to know which
 * backend a given node is using, they just pass along whatever `logPath` they were
 * configured with. See src/gcsLogStore.ts for the GCS implementation and its
 * concurrency-safety notes.
 */

export async function readLog(ref: string): Promise<LineEnvelope[]> {
  if (isGcsRef(ref)) return getGcsStore(ref).readAll();
  if (!existsSync(ref)) return [];
  return parseJsonl(readFileSync(ref, 'utf8'));
}

/**
 * Appends one line. For a `gs://` ref this is guarded against concurrent writers (see
 * GcsLogStore.append) and can throw `ConcurrentWriteError`. For a local file path there
 * is currently no such guard — see the "no write-concurrency guard" note in
 * spec/schema.md's open items.
 */
export async function appendLine(ref: string, line: LineEnvelope): Promise<void> {
  if (isGcsRef(ref)) return getGcsStore(ref).append(line);
  appendFileSync(ref, JSON.stringify(line) + '\n', 'utf8');
}

export async function nextSeq(ref: string): Promise<number> {
  const lines = await readLog(ref);
  return lines.length === 0 ? 0 : lines[lines.length - 1].seq + 1;
}

export async function initLog(ref: string, genesis: LineEnvelope): Promise<void> {
  if (isGcsRef(ref)) return getGcsStore(ref).init(genesis);
  if (existsSync(ref)) {
    throw new Error(`${ref} already exists — refusing to overwrite an existing log`);
  }
  writeFileSync(ref, JSON.stringify(genesis) + '\n', 'utf8');
}
