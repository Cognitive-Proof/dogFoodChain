import { replayChain } from '../chain';
import { readLog } from '../log';

export async function verify(logPath: string): Promise<void> {
  const lines = readLog(logPath);
  const state = await replayChain(lines);

  console.log(`Chain ${state.chainId} — ${lines.length} line(s), ${state.blocks.length} block(s)`);
  console.log(
    `Active governance: seq ${state.activeGovernance.seq}, writer=${state.activeGovernance.payload.writer.id}, ` +
      `confirmers=[${state.activeGovernance.payload.confirmers.map((c) => c.id).join(', ')}]`
  );
  if (state.pendingProposal) {
    console.log(
      `Pending governance proposal: seq ${state.pendingProposal.seq}, approvals=[${[...state.pendingProposal.approvals].join(', ')}]`
    );
  }
  for (const block of state.blocks) {
    console.log(
      `Block seq ${block.seq}: ${block.payload.transactions.length} tx, confirmed=${block.confirmed}, ` +
        `approvals=[${[...block.approvals].join(', ')}]`
    );
  }
  console.log('OK — every line verified and the log is internally consistent.');
}
