export type LineType = 'governance' | 'block' | 'confirmation';

/** A signing identity: a role name plus the PEM cert/key used to sign as that role. */
export interface Identity {
  id: string;
  certPem: string;
  keyPem: Uint8Array;
}

export interface ParticipantRef {
  id: string;
  certPem: string;
}

export interface GovernancePayload {
  action: 'genesis' | 'update';
  supersedes: { seq: number } | null;
  writer: ParticipantRef;
  confirmers: ParticipantRef[];
  thresholds: {
    /** Fraction of confirmers required to finalize a block: floor(N * x) + 1. */
    blockConfirmation: number;
    /** Fraction of the *prior* confirmer set required to ratify a governance change. */
    governanceChange: number;
  };
  trustAnchor?: {
    description?: string;
    uri?: string;
  };
}

export interface TransactionEntry {
  id: string;
  submittedAt: string;
  data: unknown;
  submitter: ParticipantRef;
  /** base64 C2PA sidecar manifest bytes, signed by the submitter over canonicalize(data). */
  manifest: string;
}

export interface BlockPayload {
  action: 'block';
  governanceRef: { seq: number };
  prevBlockRef: { seq: number } | null;
  transactions: TransactionEntry[];
}

export interface ConfirmationPayload {
  action: 'confirm';
  target: { lineType: 'block' | 'governance'; seq: number };
  vote: 'approve' | 'reject';
}

export type LinePayload = GovernancePayload | BlockPayload | ConfirmationPayload;

/**
 * Signed into every line's manifest as the `org.dogfoodchain.line` assertion: binds the
 * envelope fields that sit outside `payload`, and the hash of the line before this one.
 */
export interface LineLink {
  chainId: string;
  seq: number;
  lineType: LineType;
  /** base64 SHA-256 of the previous line (see `lineHash`); null only for genesis. */
  prevHash: string | null;
}

/** Signed into a transaction's manifest as the `org.dogfoodchain.transaction` assertion. */
export interface TransactionLink {
  id: string;
  submittedAt: string;
  submitterId: string;
}

/** One line of the JSONL log. `manifest` is base64 C2PA sidecar bytes signing `payload`. */
export interface LineEnvelope<T extends LinePayload = LinePayload> {
  lineType: LineType;
  seq: number;
  chainId: string;
  payload: T;
  manifest: string;
}
