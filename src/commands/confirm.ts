import { replayChain } from '../chain';
import { devIdentities } from '../identities';
import { appendLine, nextSeq, readLog } from '../log';
import { payloadBytes, signLine } from '../signing';
import type { ConfirmationPayload, Identity } from '../types';

const CONFIRMER_IDENTITIES: Record<string, () => Identity> = {
  'confirmer-b': devIdentities.confirmerB,
  'confirmer-c': devIdentities.confirmerC,
};

export async function confirm(
  logPath: string,
  confirmerRole: string,
  targetLineType: 'block' | 'governance',
  targetSeq: number,
  vote: 'approve' | 'reject' = 'approve'
): Promise<void> {
  const identityFn = CONFIRMER_IDENTITIES[confirmerRole];
  if (!identityFn) {
    throw new Error(
      `unknown confirmer "${confirmerRole}" — expected one of: ${Object.keys(CONFIRMER_IDENTITIES).join(', ')}`
    );
  }
  const confirmer = identityFn();

  const lines = await readLog(logPath);
  const state = await replayChain(lines); // validates the log before we extend it
  const target = lines.find((l) => l.seq === targetSeq && l.lineType === targetLineType);
  if (!target) {
    throw new Error(`no ${targetLineType} line at seq ${targetSeq}`);
  }

  const seq = await nextSeq(logPath);
  const payload: ConfirmationPayload = {
    action: 'confirm',
    target: { lineType: targetLineType, seq: targetSeq },
    vote,
  };

  const { line } = await signLine('confirmation', seq, state.chainId, payload, confirmer, [
    { title: `line-${targetSeq}`, asset: payloadBytes(target.payload) },
  ]);
  await appendLine(logPath, line);

  console.log(`${confirmer.id} ${vote}d ${targetLineType} seq ${targetSeq} (confirmation seq ${seq})`);
}
