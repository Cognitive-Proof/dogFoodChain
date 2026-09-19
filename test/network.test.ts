import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { replayChain, type ChainStateSummary } from '../src/chain';
import { devIdentities } from '../src/identities';
import { readLog } from '../src/log';
import { startNode } from '../src/server';
import { signLine } from '../src/signing';
import type { GovernancePayload } from '../src/types';

async function fetchState(url: string): Promise<ChainStateSummary> {
  const res = await fetch(`${url}/state`);
  return (await res.json()) as ChainStateSummary;
}

const PORT_WRITER = 4101;
const PORT_CONFIRMER_B = 4102;
const PORT_CONFIRMER_C = 4103;
const URL_WRITER = `http://localhost:${PORT_WRITER}`;
const URL_CONFIRMER_B = `http://localhost:${PORT_CONFIRMER_B}`;
const URL_CONFIRMER_C = `http://localhost:${PORT_CONFIRMER_C}`;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

describe('three independent nodes sharing one chain over HTTP', () => {
  let dir: string;
  let nodes: Array<{ close: () => Promise<void> }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'dogfoodchain-network-test-'));

    // Genesis is distributed out-of-band before any node starts (see spec/schema.md:
    // genesis trust is social/external, not something nodes gossip-discover).
    const writer = devIdentities.writer();
    const confirmerB = devIdentities.confirmerB();
    const confirmerC = devIdentities.confirmerC();
    const genesisPayload: GovernancePayload = {
      action: 'genesis',
      supersedes: null,
      writer: { id: writer.id, certPem: writer.certPem },
      confirmers: [
        { id: confirmerB.id, certPem: confirmerB.certPem },
        { id: confirmerC.id, certPem: confirmerC.certPem },
      ],
      thresholds: { blockConfirmation: 0.5, governanceChange: 0.667 },
    };
    const { line: genesisLine } = await signLine('governance', 0, 'urn:uuid:network-test', genesisPayload, writer);
    const genesisText = JSON.stringify(genesisLine) + '\n';

    const logWriter = join(dir, 'writer.jsonl');
    const logConfirmerB = join(dir, 'confirmer-b.jsonl');
    const logConfirmerC = join(dir, 'confirmer-c.jsonl');
    writeFileSync(logWriter, genesisText);
    writeFileSync(logConfirmerB, genesisText);
    writeFileSync(logConfirmerC, genesisText);

    // Fast sync interval so the test doesn't need to wait long for convergence.
    const syncIntervalMs = 200;

    const nodeWriter = startNode({
      port: PORT_WRITER,
      logPath: logWriter,
      peers: [URL_CONFIRMER_B, URL_CONFIRMER_C],
      identityRole: 'writer',
      syncIntervalMs,
    });
    const nodeConfirmerB = startNode({
      port: PORT_CONFIRMER_B,
      logPath: logConfirmerB,
      peers: [URL_WRITER, URL_CONFIRMER_C],
      identityRole: 'confirmer-b',
      syncIntervalMs,
    });
    const nodeConfirmerC = startNode({
      port: PORT_CONFIRMER_C,
      logPath: logConfirmerC,
      peers: [URL_WRITER, URL_CONFIRMER_B],
      identityRole: 'confirmer-c',
      syncIntervalMs,
    });
    nodes = [nodeWriter, nodeConfirmerB, nodeConfirmerC];

    // Give servers a moment to bind before the test issues requests.
    await new Promise((r) => setTimeout(r, 200));
  }, 15000);

  afterAll(async () => {
    await Promise.all(nodes.map((n) => n.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  test('a transaction submitted to the writer node ends up confirmed and identical on all three nodes', async () => {
    // 1. Submit a transaction directly to the writer's own node.
    const submitRes = await fetch(`${URL_WRITER}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg: 'hello from a 3-node network' }),
    });
    expect(submitRes.ok).toBe(true);

    // 2. The writer seals a block from its own pending pool.
    const sealRes = await fetch(`${URL_WRITER}/blocks/seal`, { method: 'POST' });
    expect(sealRes.ok).toBe(true);

    // 3. Wait until BOTH confirmer nodes have independently received the block via sync
    //    (not shared file access — each is polling the writer's /log over HTTP).
    await waitFor(async () => {
      const [bState, cState] = await Promise.all([fetchState(URL_CONFIRMER_B), fetchState(URL_CONFIRMER_C)]);
      return bState.blocks.length === 1 && cState.blocks.length === 1;
    });

    // 4. Each confirmer independently confirms the block, from its own node, using only
    //    its own key (the writer's node has no access to either confirmer's private key).
    const confirmBRes = await fetch(`${URL_CONFIRMER_B}/confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'block', targetSeq: 1, vote: 'approve' }),
    });
    expect(confirmBRes.ok).toBe(true);

    const confirmCRes = await fetch(`${URL_CONFIRMER_C}/confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType: 'block', targetSeq: 1, vote: 'approve' }),
    });
    expect(confirmCRes.ok).toBe(true);

    // 5. Wait for both confirmations to propagate to all three nodes and finalize the block.
    await waitFor(async () => {
      const states = await Promise.all([URL_WRITER, URL_CONFIRMER_B, URL_CONFIRMER_C].map(fetchState));
      return states.every((s) => s.blocks[0]?.confirmed === true);
    });

    // 6. All three nodes should now report the identical, finalized state.
    const finalStates = await Promise.all([URL_WRITER, URL_CONFIRMER_B, URL_CONFIRMER_C].map(fetchState));
    for (const state of finalStates) {
      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0].confirmed).toBe(true);
      expect([...state.blocks[0].approvals].sort()).toEqual(['confirmer-b', 'confirmer-c']);
    }

    // 7. And each node's own local log file, read directly (no HTTP), independently
    //    replays and verifies — proving convergence isn't just an in-memory illusion.
    const logs = [join(dir, 'writer.jsonl'), join(dir, 'confirmer-b.jsonl'), join(dir, 'confirmer-c.jsonl')];
    for (const logPath of logs) {
      const lines = await readLog(logPath);
      expect(lines).toHaveLength(4); // genesis, block, confirm, confirm
      const state = await replayChain(lines);
      expect(state.blocks[0].confirmed).toBe(true);
    }
  }, 20000);
});
