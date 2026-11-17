import { identifySigner, lineHash, verifyLine, verifyTransaction } from './signing';
import type {
  BlockPayload,
  ConfirmationPayload,
  GovernancePayload,
  LineEnvelope,
  LineLink,
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
  /** Every transaction id already included in a block — ids must be unique per chain. */
  transactionIds: Set<string>;
}

/**
 * Checks a line's signed `org.dogfoodchain.line` assertion against its unsigned envelope
 * fields and against the actual previous line. This is what makes deleting, inserting,
 * reordering or renumbering lines, or moving them to another chain, detectable.
 */
function checkLink(line: LineEnvelope, link: LineLink | undefined, prev: LineEnvelope | null): void {
  const label = `line ${line.seq}`;
  if (!link) throw new Error(`${label}: manifest has no signed org.dogfoodchain.line assertion`);
  if (link.chainId !== line.chainId) throw new Error(`${label}: signed chainId does not match the envelope`);
  if (link.seq !== line.seq) throw new Error(`${label}: signed seq ${link.seq} does not match the envelope`);
  if (link.lineType !== line.lineType) throw new Error(`${label}: signed lineType does not match the envelope`);
  const expected = prev ? lineHash(prev) : null;
  if (link.prevHash !== expected) {
    throw new Error(`${label}: signed prevHash does not match the previous line — the log was altered`);
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Rejects governance that could never confirm anything, or would let anyone confirm. */
function validateGovernance(seq: number, payload: GovernancePayload): void {
  const label = `governance line ${seq}`;
  if (!payload.writer || !isNonEmptyString(payload.writer.id) || !isNonEmptyString(payload.writer.certPem)) {
    throw new Error(`${label}: writer must have an id and certPem`);
  }
  if (!Array.isArray(payload.confirmers) || payload.confirmers.length === 0) {
    throw new Error(`${label}: confirmers must be a non-empty list`);
  }
  const ids = new Set<string>();
  for (const c of payload.confirmers) {
    if (!c || !isNonEmptyString(c.id) || !isNonEmptyString(c.certPem)) {
      throw new Error(`${label}: every confirmer must have an id and certPem`);
    }
    if (ids.has(c.id)) throw new Error(`${label}: duplicate confirmer id "${c.id}"`);
    ids.add(c.id);
  }
  for (const [name, value] of Object.entries(payload.thresholds ?? {})) {
    // floor(N * t) + 1 <= N only while t < 1; a negative t would let a single vote pass.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw new Error(`${label}: threshold ${name} must be a number in [0, 1)`);
    }
  }
  if (!payload.thresholds || !('blockConfirmation' in payload.thresholds) || !('governanceChange' in payload.thresholds)) {
    throw new Error(`${label}: thresholds must include blockConfirmation and governanceChange`);
  }
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
 * Each line's signed link (see `checkLink`) must name the hash of the line before it, so
 * any edit, deletion, insertion or reordering breaks verification of every later line.
 * Dropping lines from the *end* of the log is not detectable from the log alone.
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
  validateGovernance(0, genesisPayload);
  const genesisCheck = await verifyLine(genesisLine, [genesisPayload.writer.certPem]);
  if (!genesisCheck.trusted) {
    throw new Error('genesis line failed to verify against its own declared writer cert');
  }
  if (genesisLine.seq !== 0) throw new Error('line 0: genesis must have seq 0');
  checkLink(genesisLine, genesisCheck.link, null);

  const state: ChainState = {
    chainId: genesisLine.chainId,
    governanceHistory: [{ seq: 0, payload: genesisPayload }],
    activeGovernance: { seq: 0, payload: genesisPayload },
    pendingProposal: null,
    blocks: [],
    tipSeq: 0,
    transactionIds: new Set(),
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.chainId !== state.chainId) {
      throw new Error(`line ${i}: belongs to chain ${line.chainId}, expected ${state.chainId}`);
    }
    if (line.seq !== i) {
      throw new Error(`line ${i}: has seq ${line.seq} — the log must be contiguous`);
    }

    const prev = lines[i - 1];
    if (line.lineType === 'governance') {
      await applyGovernanceLine(state, line as LineEnvelope<GovernancePayload>, prev);
    } else if (line.lineType === 'block') {
      await applyBlockLine(state, line as LineEnvelope<BlockPayload>, prev);
    } else if (line.lineType === 'confirmation') {
      await applyConfirmationLine(state, line as LineEnvelope<ConfirmationPayload>, prev);
    } else {
      throw new Error(`line ${i}: unknown lineType`);
    }
  }

  return state;
}

async function applyGovernanceLine(
  state: ChainState,
  line: LineEnvelope<GovernancePayload>,
  prev: LineEnvelope
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

  validateGovernance(line.seq, payload);

  const signed = await identifySigner(line, state.activeGovernance.payload.confirmers);
  if (!signed) {
    throw new Error(`governance line ${line.seq}: not signed by a member of the current confirmer set`);
  }
  checkLink(line, signed.link, prev);

  state.pendingProposal = { seq: line.seq, payload, approvals: new Set() };
  state.tipSeq = line.seq;
}

async function applyBlockLine(
  state: ChainState,
  line: LineEnvelope<BlockPayload>,
  prev: LineEnvelope
): Promise<void> {
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
  const signed = await identifySigner(line, [writer]);
  if (!signed) {
    throw new Error(`block ${line.seq}: not signed by the active governance's writer`);
  }
  checkLink(line, signed.link, prev);
  await checkTransactions(state, line);

  state.blocks.push({ seq: line.seq, payload, approvals: new Set(), confirmed: false });
  state.tipSeq = line.seq;
}

/**
 * Every transaction must carry a valid signature from its declared submitter cert. A
 * submitter id that names a chain participant must use that participant's cert, so a
 * transaction can't claim to come from a writer or confirmer that never signed it.
 */
async function checkTransactions(state: ChainState, line: LineEnvelope<BlockPayload>): Promise<void> {
  const { writer, confirmers } = state.activeGovernance.payload;
  const participants = new Map<string, string>([[writer.id, writer.certPem]]);
  for (const c of confirmers) participants.set(c.id, c.certPem);

  for (const tx of line.payload.transactions) {
    const label = `block ${line.seq}: transaction ${tx.id}`;
    if (state.transactionIds.has(tx.id)) throw new Error(`${label}: duplicate transaction id`);
    const participantCert = participants.get(tx.submitter.id);
    if (participantCert !== undefined && participantCert !== tx.submitter.certPem) {
      throw new Error(`${label}: submitter "${tx.submitter.id}" does not use that participant's cert`);
    }
    if (!(await verifyTransaction(tx, [tx.submitter.certPem]))) {
      throw new Error(`${label}: signature does not verify against the submitter's cert`);
    }
    state.transactionIds.add(tx.id);
  }
}

async function applyConfirmationLine(
  state: ChainState,
  line: LineEnvelope<ConfirmationPayload>,
  prev: LineEnvelope
): Promise<void> {
  const payload = line.payload;

  if (payload.target.lineType === 'block') {
    const block = state.blocks.find((b) => b.seq === payload.target.seq);
    if (!block) {
      throw new Error(`confirmation ${line.seq}: target block ${payload.target.seq} not found`);
    }
    const governance = governanceRecordFor(state, block.payload.governanceRef.seq);
    const signed = await identifySigner(line, governance.payload.confirmers);
    if (!signed) {
      throw new Error(`confirmation ${line.seq}: not signed by a confirmer of the block's governance`);
    }
    checkLink(line, signed.link, prev);
    if (payload.vote === 'approve') block.approvals.add(signed.signer.id);
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
  const signed = await identifySigner(line, state.activeGovernance.payload.confirmers);
  if (!signed) {
    throw new Error(`confirmation ${line.seq}: not signed by a confirmer of the prior (active) governance`);
  }
  checkLink(line, signed.link, prev);
  if (payload.vote === 'approve') state.pendingProposal.approvals.add(signed.signer.id);

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
