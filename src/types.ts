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

/** One line of the JSONL log. `manifest` is base64 C2PA sidecar bytes signing `payload`. */
export interface LineEnvelope<T extends LinePayload = LinePayload> {
  lineType: LineType;
  seq: number;
  chainId: string;
  payload: T;
  manifest: string;
}
