import { describe, expect, test } from 'vitest';
import { replayChain, requiredVotes } from '../src/chain';
import { devIdentities } from '../src/identities';
import { payloadBytes, signLine, signTransaction } from '../src/signing';
import type {
  BlockPayload,
  ConfirmationPayload,
  GovernancePayload,
  LineEnvelope,
  LinePayload,
  TransactionEntry,
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
  return signLine('governance', 0, chainId(), payload, writer, null);
}

type Signed = { line: LineEnvelope<LinePayload>; asset: Uint8Array };

async function buildBlock(
  seq: number,
  prev: Signed,
  governanceSeq: number,
  prevBlockSeq: number | null,
  transactions: TransactionEntry[] = []
) {
  const payload: BlockPayload = {
    action: 'block',
    governanceRef: { seq: governanceSeq },
    prevBlockRef: prevBlockSeq === null ? null : { seq: prevBlockSeq },
    transactions,
  };
  return signLine('block', seq, chainId(), payload, writer, prev.line, [
    { title: `line-${prev.line.seq}`, asset: prev.asset },
  ]);
}

/** `prev` is the line immediately before this one; `target` is the line being voted on. */
async function buildConfirmation(
  seq: number,
  confirmer: typeof confirmerB,
  prev: Signed,
  target: Signed,
  targetLineType: 'block' | 'governance',
  vote: 'approve' | 'reject' = 'approve'
) {
  const payload: ConfirmationPayload = {
    action: 'confirm',
    target: { lineType: targetLineType, seq: target.line.seq },
    vote,
  };
  return signLine('confirmation', seq, chainId(), payload, confirmer, prev.line, [
    { title: `line-${target.line.seq}`, asset: target.asset },
  ]);
}

/** genesis -> block (with `transactions`) -> approvals from both confirmers. */
async function buildConfirmedChain(transactions: TransactionEntry[] = []) {
  const genesis = await buildGenesis();
  const block = await buildBlock(1, genesis, 0, null, transactions);
  const confirmB = await buildConfirmation(2, confirmerB, block, block, 'block');
  const confirmC = await buildConfirmation(3, confirmerC, confirmB, block, 'block');
  return [genesis.line, block.line, confirmB.line, confirmC.line];
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
    const state = await replayChain(await buildConfirmedChain());

    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].confirmed).toBe(true);
    expect([...state.blocks[0].approvals].sort()).toEqual(['confirmer-b', 'confirmer-c']);
  });

  test('a single confirmation is not enough to finalize (needs 2 of 2)', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const confirmB = await buildConfirmation(2, confirmerB, block, block, 'block');

    const state = await replayChain([genesis.line, block.line, confirmB.line]);
    expect(state.blocks[0].confirmed).toBe(false);
  });

  test('a rejected vote does not count toward the threshold', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const rejectB = await buildConfirmation(2, confirmerB, block, block, 'block', 'reject');
    const confirmC = await buildConfirmation(3, confirmerC, rejectB, block, 'block');

    const state = await replayChain([genesis.line, block.line, rejectB.line, confirmC.line]);
    expect(state.blocks[0].confirmed).toBe(false);
    expect([...state.blocks[0].approvals]).toEqual(['confirmer-c']);
  });
});

describe('tamper detection', () => {
  test('mutating a signed payload breaks verification', async () => {
    const [genesis, block, confirmB, confirmC] = await buildConfirmedChain();

    const tampered = structuredClone(block);
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
      replayChain([genesis, tampered, confirmB, confirmC])
    ).rejects.toThrow();
  });

  test('reordering lines breaks the contiguous-seq check', async () => {
    const genesis = await buildGenesis();
    const block = await buildBlock(1, genesis, 0, null);
    const confirmB = await buildConfirmation(2, confirmerB, block, block, 'block');

    await expect(replayChain([genesis.line, confirmB.line, block.line])).rejects.toThrow(/seq/);
  });

  test('deleting a line and renumbering the rest breaks the hash chain', async () => {
    const [genesis, block, , confirmC] = await buildConfirmedChain();
    await expect(replayChain([genesis, block, { ...confirmC, seq: 2 }])).rejects.toThrow(
      /signed seq|prevHash/
    );
  });

  test('rewriting chainId on every line is detected', async () => {
    const lines = await buildConfirmedChain();
    await expect(
      replayChain(lines.map((l) => ({ ...l, chainId: 'urn:uuid:someone-else' })))
    ).rejects.toThrow(/chainId/);
  });

  test('editing an earlier line breaks every later link, even with a valid re-signature', async () => {
    const [genesis, block, confirmB, confirmC] = await buildConfirmedChain();
    // The writer re-signs block 1 with different contents; the confirmations were signed
    // over the original block line, so their prevHash links no longer match.
    const resigned = await buildBlock(1, { line: genesis, asset: payloadBytes(genesis.payload) }, 0, null, [
      await signTransaction('urn:uuid:rewritten', { msg: 'rewritten' }, writer),
    ]);
    await expect(replayChain([genesis, resigned.line, confirmB, confirmC])).rejects.toThrow(/prevHash/);
  });
});

describe('transaction verification', () => {
  test('a valid transaction from a participant verifies', async () => {
    const tx = await signTransaction('urn:uuid:ok', { msg: 'hi' }, confirmerB);
    const state = await replayChain(await buildConfirmedChain([tx]));
    expect(state.transactionIds.has('urn:uuid:ok')).toBe(true);
  });

  test('a transaction with a garbage manifest is rejected', async () => {
    const tx = await signTransaction('urn:uuid:junk', { msg: 'hi' }, writer);
    tx.manifest = 'AAAA';
    await expect(replayChain(await buildConfirmedChain([tx]))).rejects.toThrow(/signature/);
  });

  test("a transaction claiming a participant's id with someone else's cert is rejected", async () => {
    const tx = await signTransaction('urn:uuid:mislabelled', { msg: 'forged' }, writer);
    tx.submitter.id = 'confirmer-b';
    await expect(replayChain(await buildConfirmedChain([tx]))).rejects.toThrow(/participant's cert/);
  });

  test('editing the unsigned id or submittedAt of a transaction is detected', async () => {
    const tx = await signTransaction('urn:uuid:orig', { msg: 'hi' }, writer);
    await expect(replayChain(await buildConfirmedChain([{ ...tx, id: 'urn:uuid:edited' }]))).rejects.toThrow(
      /signature/
    );
    await expect(
      replayChain(await buildConfirmedChain([{ ...tx, submittedAt: '2000-01-01T00:00:00.000Z' }]))
    ).rejects.toThrow(/signature/);
  });

  test('a transaction id may appear only once per chain', async () => {
    const tx = await signTransaction('urn:uuid:dup', { msg: 'hi' }, writer);
    await expect(replayChain(await buildConfirmedChain([tx, tx]))).rejects.toThrow(/duplicate/);
  });
});

describe('governance validation', () => {
  test.each([
    ['a threshold of 1 (unreachable)', { thresholds: { blockConfirmation: 1, governanceChange: 0.667 } }],
    ['a negative threshold', { thresholds: { blockConfirmation: -1, governanceChange: 0.667 } }],
    ['an empty confirmer set', { confirmers: [] }],
    [
      'duplicate confirmer ids',
      {
        confirmers: [
          { id: 'confirmer-b', certPem: confirmerB.certPem },
          { id: 'confirmer-b', certPem: confirmerC.certPem },
        ],
      },
    ],
  ])('genesis with %s is rejected', async (_name, overrides) => {
    const genesis = await buildGenesis(overrides as Partial<GovernancePayload>);
    await expect(replayChain([genesis.line])).rejects.toThrow(/governance line 0/);
  });

  test('a governance update with an unreachable threshold is rejected', async () => {
    const genesis = await buildGenesis();
    const payload: GovernancePayload = {
      action: 'update',
      supersedes: { seq: 0 },
      writer: { id: writer.id, certPem: writer.certPem },
      confirmers: [{ id: confirmerC.id, certPem: confirmerC.certPem }],
      thresholds: { blockConfirmation: 1.5, governanceChange: 0.667 },
    };
    const proposal = await signLine('governance', 1, chainId(), payload, confirmerB, genesis.line);
    await expect(replayChain([genesis.line, proposal.line])).rejects.toThrow(/threshold/);
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
    const proposal = await signLine('governance', 1, chainId(), newGovernancePayload, confirmerB, genesis.line, [
      { title: 'line-0', asset: genesis.asset },
    ]);

    const voteB = await buildConfirmation(2, confirmerB, proposal, proposal, 'governance');
    const voteC = await buildConfirmation(3, confirmerC, voteB, proposal, 'governance');

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
    const proposal1 = await signLine('governance', 1, chainId(), proposalPayload, confirmerB, genesis.line, [
      { title: 'line-0', asset: genesis.asset },
    ]);
    // A second proposal also (incorrectly) claiming to supersede seq 0, submitted while
    // proposal1 is still pending.
    const proposal2 = await signLine('governance', 2, chainId(), proposalPayload, confirmerC, proposal1.line, [
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
