import { describe, expect, test } from 'vitest';
import { replayChain, requiredVotes } from '../src/chain';
import { devIdentities } from '../src/identities';
import { payloadBytes, signLine } from '../src/signing';
import type {
  BlockPayload,
  ConfirmationPayload,
  GovernancePayload,
  LineEnvelope,
  LinePayload,
} from '../src/types';

const writer = devIdentities.writer();
const confirmerB = devIdentities.confirmerB();
const confirmerC = devIdentities.confirmerC();

function chainId() {
  return 'urn:uuid:test-chain';
}

async function buildGenesis(
  overrides: Partial<GovernancePayload> = {}
): Promise<{ line: LineEnvelope<LinePayload>; asset: Uint8Array }> {
  const payload: GovernancePayload = {
    action: 'genesis',
    supersedes: null,
    writer: { id: writer.id, certPem: writer.certPem },
    confirmers: [
      { id: confirmerB.id, certPem: confirmerB.certPem },
      { id: confirmerC.id, certPem: confirmerC.certPem },
    ],
    thresholds: { blockConfirmation: 0.5, governanceChange: 0.667 },
    ...overrides,
  };
  return signLine('governance', 0, chainId(), payload, writer);
}

async function buildBlock(
  seq: number,
  prev: { line: LineEnvelope<LinePayload>; asset: Uint8Array },
  governanceSeq: number,
  prevBlockSeq: number | null
) {
  const payload: BlockPayload = {
    action: 'block',
    governanceRef: { seq: governanceSeq },
    prevBlockRef: prevBlockSeq === null ? null : { seq: prevBlockSeq },
    transactions: [],
  };
  return signLine('block', seq, chainId(), payload, writer, [
    { title: `line-${prev.line.seq}`, asset: prev.asset },
  ]);
}

async function buildConfirmation(
  seq: number,
  confirmer: typeof confirmerB,
  target: { line: LineEnvelope<LinePayload>; asset: Uint8Array },
  targetLineType: 'block' | 'governance',
  vote: 'approve' | 'reject' = 'approve'
) {
  const payload: ConfirmationPayload = {
    action: 'confirm',
    target: { lineType: targetLineType, seq: target.line.seq },
    vote,
  };
  return signLine('confirmation', seq, chainId(), payload, confirmer, [
    { title: `line-${target.line.seq}`, asset: target.asset },
  ]);
}

describe('requiredVotes', () => {
  test('floor(N*threshold)+1', () => {
    expect(requiredVotes(2, 0.5)).toBe(2);
    expect(requiredVotes(3, 0.5)).toBe(2);
    expect(requiredVotes(3, 0.667)).toBe(3);
    expect(requiredVotes(6, 0.667)).toBe(5);
  });
});

describe('golden path', () => {
  test('genesis -> block -> two confirmations finalizes the block', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const confirmB = await buildConfirmation(2, confirmerB, block, 'block');
    const confirmC = await buildConfirmation(3, confirmerC, block, 'block');

    const lines = [genesis.line, block.line, confirmB.line, confirmC.line];
    const state = await replayChain(lines);

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].confirmed).toBe(true);
    expect([...state.blocks[0].approvals].sort()).toEqual(['confirmer-b', 'confirmer-c']);
  });

  test('a single confirmation is not enough to finalize (needs 2 of 2)', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const confirmB = await buildConfirmation(2, confirmerB, block, 'block');

    const state = await replayChain([genesis.line, block.line, confirmB.line]);
    expect(state.blocks[0].confirmed).toBe(false);
  });

  test('a rejected vote does not count toward the threshold', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const rejectB = await buildConfirmation(2, confirmerB, block, 'block', 'reject');
    const confirmC = await buildConfirmation(3, confirmerC, block, 'block');

    const state = await replayChain([genesis.line, block.line, rejectB.line, confirmC.line]);
    expect(state.blocks[0].confirmed).toBe(false);
    expect([...state.blocks[0].approvals]).toEqual(['confirmer-c']);
  });
});

describe('tamper detection', () => {
  test('mutating a signed payload breaks verification', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const confirmB = await buildConfirmation(2, confirmerB, block, 'block');
    const confirmC = await buildConfirmation(3, confirmerC, block, 'block');

    const tampered = structuredClone(block.line);
    (tampered.payload as BlockPayload).transactions = [
      {
        id: 'urn:uuid:injected',
        submittedAt: new Date().toISOString(),
        data: { msg: 'injected after the fact' },
        submitter: { id: 'writer', certPem: writer.certPem },
        manifest: '',
      },
    ];

    await expect(
      replayChain([genesis.line, tampered, confirmB.line, confirmC.line])
    ).rejects.toThrow();
  });

  test('reordering lines breaks the contiguous-seq check', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const confirmB = await buildConfirmation(2, confirmerB, block, 'block');

    await expect(replayChain([genesis.line, confirmB.line, block.line])).rejects.toThrow(/seq/);
  });
});

describe('governance takeover', () => {
  test('a governance proposal ratifies once the prior confirmer set reaches the governanceChange threshold', async () => {
    const genesis = await buildGenesis();
    const newGovernancePayload: GovernancePayload = {
      action: 'update',
      supersedes: { seq: 0 },
      writer: { id: writer.id, certPem: writer.certPem },
      confirmers: [{ id: confirmerC.id, certPem: confirmerC.certPem }], // confirmerB voted out
      thresholds: { blockConfirmation: 0.5, governanceChange: 0.667 },
    };
    const proposal = await signLine('governance', 1, chainId(), newGovernancePayload, confirmerB, [
      { title: 'line-0', asset: genesis.asset },
    ]);

    const voteB = await buildConfirmation(2, confirmerB, proposal, 'governance');
    const voteC = await buildConfirmation(3, confirmerC, proposal, 'governance');

    // With 2 prior confirmers and governanceChange=0.667, required = floor(2*0.667)+1 = 2.
    const stateAfterOneVote = await replayChain([genesis.line, proposal.line, voteB.line]);
    expect(stateAfterOneVote.activeGovernance.seq).toBe(0);
    expect(stateAfterOneVote.pendingProposal).not.toBeNull();

    const stateAfterBothVotes = await replayChain([genesis.line, proposal.line, voteB.line, voteC.line]);
    expect(stateAfterBothVotes.activeGovernance.seq).toBe(1);
    expect(stateAfterBothVotes.pendingProposal).toBeNull();
    expect(stateAfterBothVotes.activeGovernance.payload.confirmers.map((c) => c.id)).toEqual(['confirmer-c']);
  });

  test('a second governance proposal cannot be submitted while one is pending', async () => {
    const genesis = await buildGenesis();
    const proposalPayload: GovernancePayload = {
      action: 'update',
      supersedes: { seq: 0 },
      writer: { id: writer.id, certPem: writer.certPem },
      confirmers: [{ id: confirmerC.id, certPem: confirmerC.certPem }],
      thresholds: { blockConfirmation: 0.5, governanceChange: 0.667 },
    };
    const proposal1 = await signLine('governance', 1, chainId(), proposalPayload, confirmerB, [
      { title: 'line-0', asset: genesis.asset },
    ]);
    // A second proposal also (incorrectly) claiming to supersede seq 0, submitted while
    // proposal1 is still pending.
    const proposal2 = await signLine('governance', 2, chainId(), proposalPayload, confirmerC, [
      { title: 'line-1', asset: proposal1.asset },
    ]);

    await expect(replayChain([genesis.line, proposal1.line, proposal2.line])).rejects.toThrow(
      /already pending/
    );
  });
});

test('payloadBytes is deterministic regardless of key order', () => {
  const a = payloadBytes({ b: 1, a: 2 });
  const b = payloadBytes({ a: 2, b: 1 });
  expect(Buffer.from(a).toString()).toBe(Buffer.from(b).toString());
});
