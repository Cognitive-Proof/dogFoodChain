import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replayChain } from '../chain';
import { devIdentities } from '../identities';
import { appendLine, nextSeq, readLog } from '../log';
import { payloadBytes, signLine } from '../signing';
import type { BlockPayload, TransactionEntry } from '../types';
import { pendingDirFor } from './submitTransaction';

/** The writer batches pending off-chain transactions into a new block, chained to the tip. */
export async function sealBlock(logPath: string): Promise<void> {
  const lines = readLog(logPath);
  const state = await replayChain(lines);

  const writer = devIdentities.writer();
  if (state.activeGovernance.payload.writer.id !== writer.id) {
    throw new Error(
      `the active governance's writer is "${state.activeGovernance.payload.writer.id}", not the dev "writer" identity`
    );
  }

  const dir = pendingDirFor(logPath);
  const txFiles = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  if (txFiles.length === 0) {
    throw new Error('no pending transactions to seal — run `submit` first');
  }
  const transactions: TransactionEntry[] = txFiles.map(
    (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as TransactionEntry
  );

  const seq = nextSeq(logPath);
  const prevLine = lines[lines.length - 1];
  const payload: BlockPayload = {
    action: 'block',
    governanceRef: { seq: state.activeGovernance.seq },
    prevBlockRef: state.blocks.length === 0 ? null : { seq: state.blocks[state.blocks.length - 1].seq },
    transactions,
  };

  const { line } = await signLine('block', seq, state.chainId, payload, writer, [
    { title: `line-${prevLine.seq}`, asset: payloadBytes(prevLine.payload) },
  ]);
  appendLine(logPath, line);
  rmSync(dir, { recursive: true, force: true });

  console.log(`Sealed block seq ${seq} with ${transactions.length} transaction(s)`);
}
