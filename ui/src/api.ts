// Minimal client for a dogFoodChain node's HTTP API. Types mirror the JSON shapes
// returned by src/server.ts (summarizeState / GET /log) — kept local rather than
// imported from the backend package so this UI stays a standalone Vite app.

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
  blocks: Array<{
    seq: number;
    transactionCount: number;
    confirmed: boolean;
    approvals: string[];
  }>;
}

export interface LineEnvelope {
  lineType: 'governance' | 'block' | 'confirmation';
  seq: number;
  chainId: string;
  payload: { action: string; [key: string]: unknown };
  manifest: string;
}

async function asJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : res.statusText;
    throw new Error(message);
  }
  return body as T;
}

export function getHealth(nodeUrl: string): Promise<{ ok: boolean; identity: string | null; peers: string[] }> {
  return fetch(`${nodeUrl}/health`).then((r) => asJson(r));
}

export function getState(nodeUrl: string): Promise<ChainStateSummary> {
  return fetch(`${nodeUrl}/state`).then((r) => asJson(r));
}

export function getLog(nodeUrl: string): Promise<LineEnvelope[]> {
  return fetch(`${nodeUrl}/log`).then((r) => asJson(r));
}

export function submitTransaction(nodeUrl: string, data: unknown): Promise<{ ok: true }> {
  return fetch(`${nodeUrl}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then((r) => asJson(r));
}

export function sealBlock(nodeUrl: string): Promise<{ ok: true }> {
  return fetch(`${nodeUrl}/blocks/seal`, { method: 'POST' }).then((r) => asJson(r));
}

export function confirmTarget(
  nodeUrl: string,
  targetType: 'block' | 'governance',
  targetSeq: number,
  vote: 'approve' | 'reject' = 'approve'
): Promise<{ ok: true }> {
  return fetch(`${nodeUrl}/confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetType, targetSeq, vote }),
  }).then((r) => asJson(r));
}
