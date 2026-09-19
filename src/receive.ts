import { replayChain } from './chain';
import { ConcurrentWriteError } from './gcsLogStore';
import { appendLine, readLog } from './log';
import type { LineEnvelope } from './types';

export type ReceiveOutcome = 'appended' | 'duplicate' | 'rejected' | 'out-of-order' | 'conflict';

/**
 * Validates a candidate line (from a peer, or from this node's own operator actions)
 * against the local log before appending it. This is the single choke point every
 * incoming line passes through — local commands go through the same file-append path
 * (via the `commands/*` functions), but lines arriving *from other nodes* must be
 * revalidated here rather than trusted just because a peer sent them.
 */
export async function receiveLine(logPath: string, candidate: LineEnvelope): Promise<ReceiveOutcome> {
  const existing = await readLog(logPath);

  if (candidate.seq < existing.length) {
    const current = existing[candidate.seq];
    if (JSON.stringify(current) === JSON.stringify(candidate)) {
      return 'duplicate';
    }
    // Two different, differently-signed lines claiming the same seq — either an
    // equivocating writer/confirmer or a fork. v0 policy: first-seen wins locally;
    // the conflict is only logged, not otherwise resolved. See spec/schema.md open items.
    console.warn(
      `[receiveLine] conflicting line at seq ${candidate.seq} — keeping the one already on disk, rejecting the incoming one`
    );
    return 'rejected';
  }

  if (candidate.seq > existing.length) {
    // We're missing lines in between; the sync loop will backfill via /log?since=.
    return 'out-of-order';
  }

  const trial = [...existing, candidate];
  try {
    await replayChain(trial);
  } catch (err) {
    console.warn(`[receiveLine] rejected line ${candidate.seq}: ${(err as Error).message}`);
    return 'rejected';
  }

  try {
    await appendLine(logPath, candidate);
  } catch (err) {
    if (err instanceof ConcurrentWriteError) {
      // Someone else (another push, or this node's own operator action) appended in the
      // gap between our read and our write. Self-healing: the next sync tick re-fetches
      // from the peer and retries from the new tip.
      console.warn(`[receiveLine] ${err.message}`);
      return 'conflict';
    }
    throw err;
  }
  return 'appended';
}
