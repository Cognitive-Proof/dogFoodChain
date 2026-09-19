import { identifySigner, verifyLine } from './signing';
import type {
  BlockPayload,
  ConfirmationPayload,
  GovernancePayload,
  LineEnvelope,
  ParticipantRef,
} from './types';

export function requiredVotes(confirmerCount: number, threshold: number): number {
  return Math.floor(confirmerCount * threshold) + 1;
}

export interface ChainStateSummary {
  chainId: string;
  tipSeq: number;
  activeGovernance: {
    seq: number;
    writer: string;
    confirmers: string[];
    thresholds: { blockConfirmation: number; governanceChange: number };
  };
  pendingProposal: { seq: number; approvals: string[] } | null;
  blocks: Array<{ seq: number; transactionCount: number; confirmed: boolean; approvals: string[] }>;
}

/** JSON-serializable view of a ChainState (Sets -> arrays), for an HTTP /state response. */
export function summarizeState(state: ChainState): ChainStateSummary {
  return {
    chainId: state.chainId,
    tipSeq: state.tipSeq,
    activeGovernance: {
      seq: state.activeGovernance.seq,
      writer: state.activeGovernance.payload.writer.id,
      confirmers: state.activeGovernance.payload.confirmers.map((c) => c.id),
      thresholds: state.activeGovernance.payload.thresholds,
    },
    pendingProposal: state.pendingProposal
      ? { seq: state.pendingProposal.seq, approvals: [...state.pendingProposal.approvals] }
      : null,
    blocks: state.blocks.map((b) => ({
      seq: b.seq,
      transactionCount: b.payload.transactions.length,
      confirmed: b.confirmed,
      approvals: [...b.approvals],
    })),
  };
}

export interface GovernanceRecord {
  seq: number;
  payload: GovernancePayload;
}

export interface BlockRecord {
  seq: number;
  payload: BlockPayload;
  approvals: Set<string>;
  confirmed: boolean;
}

export interface PendingProposal extends GovernanceRecord {
  approvals: Set<string>;
}

export interface ChainState {
  chainId: string;
  /** Ratified governance lines in order; the last entry is always the active one. */
  governanceHistory: GovernanceRecord[];
  activeGovernance: GovernanceRecord;
  pendingProposal: PendingProposal | null;
  blocks: BlockRecord[];
  /** seq of the furthest-along line processed (governance update or latest block). */
  tipSeq: number;
}

function governanceRecordFor(state: ChainState, seq: number): GovernanceRecord {
  const rec = state.governanceHistory.find((g) => g.seq === seq);
  if (!rec) throw new Error(`no ratified governance record at seq ${seq}`);
  return rec;
}

/**
 * Replays a full JSONL log into a `ChainState`, verifying every line's signature and
 * every governance/quorum rule as it goes. Throws on the first violation — this function
 * IS the spec (spec/schema.md) made executable.
 *
 * NOTE: this checks each line's own signature and the *declared* seq references
 * (governanceRef/prevBlockRef/target) for structural consistency, but does not yet
 * cross-check the C2PA ingredient hash recorded in a line's manifest against the actual
 * bytes of the line it claims to chain from. That's a follow-up hardening step — see
 * spec/schema.md's open items.
 */
export async function replayChain(lines: LineEnvelope[]): Promise<ChainState> {
  if (lines.length === 0) throw new Error('empty log');

  const genesisLine = lines[0];
  if (genesisLine.lineType !== 'governance') {
    throw new Error('line 0 must be a governance line');
  }
  const genesisPayload = genesisLine.payload as GovernancePayload;
  if (genesisPayload.action !== 'genesis') {
    throw new Error('line 0 must be a governance genesis');
  }

  // Genesis trust is deliberately external/social (see spec/schema.md) — we only check
  // that the declared writer's own cert actually produced this signature, not that the
  // writer is who they claim to be in the world.
  const genesisCheck = await verifyLine(genesisLine, [genesisPayload.writer.certPem]);
  if (!genesisCheck.trusted) {
    throw new Error('genesis line failed to verify against its own declared writer cert');
  }

  const state: ChainState = {
    chainId: genesisLine.chainId,
    governanceHistory: [{ seq: 0, payload: genesisPayload }],
    activeGovernance: { seq: 0, payload: genesisPayload },
    pendingProposal: null,
    blocks: [],
    tipSeq: 0,
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.chainId !== state.chainId) {
      throw new Error(`line ${i}: belongs to chain ${line.chainId}, expected ${state.chainId}`);
    }
    if (line.seq !== i) {
      throw new Error(`line ${i}: has seq ${line.seq} — the log must be contiguous`);
    }

    if (line.lineType === 'governance') {
      await applyGovernanceLine(state, line as LineEnvelope<GovernancePayload>);
    } else if (line.lineType === 'block') {
      await applyBlockLine(state, line as LineEnvelope<BlockPayload>);
    } else if (line.lineType === 'confirmation') {
      await applyConfirmationLine(state, line as LineEnvelope<ConfirmationPayload>);
    } else {
      throw new Error(`line ${i}: unknown lineType`);
    }
  }

  return state;
}

async function applyGovernanceLine(
  state: ChainState,
  line: LineEnvelope<GovernancePayload>
): Promise<void> {
  const payload = line.payload;
  if (payload.action !== 'update') {
    throw new Error(`governance line ${line.seq}: only 'update' is valid after genesis`);
  }
  if (state.pendingProposal) {
    throw new Error(
      `governance line ${line.seq}: a proposal (seq ${state.pendingProposal.seq}) is already ` +
        'pending — only one governance proposal may be in flight at a time'
    );
  }
  if (!payload.supersedes || payload.supersedes.seq !== state.activeGovernance.seq) {
    throw new Error(
      `governance line ${line.seq}: must supersede the active governance line (seq ${state.activeGovernance.seq})`
    );
  }

  const signer = await identifySigner(line, state.activeGovernance.payload.confirmers);
  if (!signer) {
    throw new Error(`governance line ${line.seq}: not signed by a member of the current confirmer set`);
  }

  state.pendingProposal = { seq: line.seq, payload, approvals: new Set() };
  state.tipSeq = line.seq;
}

async function applyBlockLine(state: ChainState, line: LineEnvelope<BlockPayload>): Promise<void> {
  const payload = line.payload;
  if (payload.governanceRef.seq !== state.activeGovernance.seq) {
    throw new Error(
      `block ${line.seq}: governanceRef ${payload.governanceRef.seq} does not match active governance ${state.activeGovernance.seq}`
    );
  }

  const expectedPrev = state.blocks.length === 0 ? null : state.blocks[state.blocks.length - 1].seq;
  const actualPrev = payload.prevBlockRef ? payload.prevBlockRef.seq : null;
  if (actualPrev !== expectedPrev) {
    throw new Error(`block ${line.seq}: prevBlockRef ${actualPrev}, expected ${expectedPrev}`);
  }

  const writer: ParticipantRef = state.activeGovernance.payload.writer;
  const signer = await identifySigner(line, [writer]);
  if (!signer) {
    throw new Error(`block ${line.seq}: not signed by the active governance's writer`);
  }

  state.blocks.push({ seq: line.seq, payload, approvals: new Set(), confirmed: false });
  state.tipSeq = line.seq;
}

async function applyConfirmationLine(
  state: ChainState,
  line: LineEnvelope<ConfirmationPayload>
): Promise<void> {
  const payload = line.payload;

  if (payload.target.lineType === 'block') {
    const block = state.blocks.find((b) => b.seq === payload.target.seq);
    if (!block) {
      throw new Error(`confirmation ${line.seq}: target block ${payload.target.seq} not found`);
    }
    const governance = governanceRecordFor(state, block.payload.governanceRef.seq);
    const signer = await identifySigner(line, governance.payload.confirmers);
    if (!signer) {
      throw new Error(`confirmation ${line.seq}: not signed by a confirmer of the block's governance`);
    }
    if (payload.vote === 'approve') block.approvals.add(signer.id);
    const required = requiredVotes(governance.payload.confirmers.length, governance.payload.thresholds.blockConfirmation);
    block.confirmed = block.approvals.size >= required;
    return;
  }

  // target.lineType === 'governance'
  if (!state.pendingProposal || state.pendingProposal.seq !== payload.target.seq) {
    throw new Error(
      `confirmation ${line.seq}: no pending governance proposal at seq ${payload.target.seq}`
    );
  }
  const signer = await identifySigner(line, state.activeGovernance.payload.confirmers);
  if (!signer) {
    throw new Error(`confirmation ${line.seq}: not signed by a confirmer of the prior (active) governance`);
  }
  if (payload.vote === 'approve') state.pendingProposal.approvals.add(signer.id);

  const required = requiredVotes(
    state.activeGovernance.payload.confirmers.length,
    state.activeGovernance.payload.thresholds.governanceChange
  );
  if (state.pendingProposal.approvals.size >= required) {
    const ratified = state.pendingProposal;
    state.governanceHistory.push({ seq: ratified.seq, payload: ratified.payload });
    state.activeGovernance = { seq: ratified.seq, payload: ratified.payload };
    state.pendingProposal = null;
  }
}
