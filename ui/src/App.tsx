import { useCallback, useEffect, useState } from 'react';
import './App.css';
import {
  type ChainStateSummary,
  type LineEnvelope,
  confirmTarget,
  getHealth,
  getLog,
  getState,
  sealBlock,
  submitTransaction,
} from './api';
import JsonModal from './JsonModal';

const NODE_URL_KEY = 'dogfoodchain.nodeUrl';

function useNodeUrl(): [string, (url: string) => void] {
  const [url, setUrl] = useState(() => localStorage.getItem(NODE_URL_KEY) ?? 'http://localhost:4101');
  const update = (next: string) => {
    setUrl(next);
    localStorage.setItem(NODE_URL_KEY, next);
  };
  return [url, update];
}

export default function App() {
  const [nodeUrl, setNodeUrl] = useNodeUrl();
  const [health, setHealth] = useState<{ identity: string | null; peers: string[] } | null>(null);
  const [state, setState] = useState<ChainStateSummary | null>(null);
  const [log, setLog] = useState<LineEnvelope[]>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmingSeq, setConfirmingSeq] = useState<number | null>(null);
  const [viewingSeq, setViewingSeq] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [h, s, l] = await Promise.all([getHealth(nodeUrl), getState(nodeUrl), getLog(nodeUrl)]);
      setHealth(h);
      setState(s);
      setLog(l);
      setConnectionError(null);
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : String(err));
    }
  }, [nodeUrl]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function handleSendTestBlock() {
    setSending(true);
    setActionError(null);
    try {
      await submitTransaction(nodeUrl, { msg: 'test transaction', sentAt: new Date().toISOString() });
      await sealBlock(nodeUrl);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function handleConfirm(seq: number) {
    setConfirmingSeq(seq);
    setActionError(null);
    try {
      await confirmTarget(nodeUrl, 'block', seq, 'approve');
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmingSeq(null);
    }
  }

  return (
    <div className="app">
      <h1>dogFoodChain</h1>

      <section className="panel">
        <label htmlFor="node-url">Node URL</label>
        <input
          id="node-url"
          value={nodeUrl}
          onChange={(e) => setNodeUrl(e.target.value)}
          placeholder="http://localhost:4101"
        />
        <button onClick={refresh}>Refresh</button>
        {connectionError && <p className="error">Can't reach {nodeUrl}: {connectionError}</p>}
        {health && (
          <p className="muted">
            identity: <strong>{health.identity ?? 'relay (no signing identity)'}</strong> · peers: {health.peers.length ? health.peers.join(', ') : 'none'}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Status</h2>
        {state ? (
          <>
            <p className="muted">
              chain <code>{state.chainId}</code> · tip seq {state.tipSeq}
            </p>
            <p>
              <strong>Governance</strong> (seq {state.activeGovernance.seq}): writer = {state.activeGovernance.writer}, confirmers = [
              {state.activeGovernance.confirmers.join(', ')}], thresholds = block{' '}
              {state.activeGovernance.thresholds.blockConfirmation}, governance {state.activeGovernance.thresholds.governanceChange}
            </p>
            {state.pendingProposal && (
              <p className="warn">
                Pending governance proposal at seq {state.pendingProposal.seq} — approvals: [{state.pendingProposal.approvals.join(', ')}]
              </p>
            )}
            <h3>Blocks</h3>
            <p className="muted">
              "View JSON" shows exactly what a block's signature covers — check it before
              confirming. The "Confirm" button signs as whichever identity <em>this node</em>{' '}
              holds — point Node URL at a confirmer's node (e.g. {state.activeGovernance.confirmers[0]}'s)
              before clicking it.
            </p>
            {state.blocks.length === 0 ? (
              <p className="muted">No blocks yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>seq</th>
                    <th>transactions</th>
                    <th>confirmed</th>
                    <th>approvals</th>
                    <th></th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {state.blocks.map((b) => (
                    <tr key={b.seq}>
                      <td>{b.seq}</td>
                      <td>{b.transactionCount}</td>
                      <td>{b.confirmed ? '✅' : '—'}</td>
                      <td>{b.approvals.join(', ') || '—'}</td>
                      <td>
                        <button className="secondary" onClick={() => setViewingSeq(b.seq)}>
                          View JSON
                        </button>
                      </td>
                      <td>
                        {!b.confirmed && (
                          <button onClick={() => handleConfirm(b.seq)} disabled={confirmingSeq === b.seq}>
                            {confirmingSeq === b.seq ? 'Confirming…' : 'Confirm'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="muted">No state yet.</p>
        )}
      </section>

      <section className="panel">
        <h2>Send a test block</h2>
        <p className="muted">
          Submits a canned transaction to this node and seals it into a new block. Only works
          against a node configured with the <code>writer</code> identity.
        </p>
        <button onClick={handleSendTestBlock} disabled={sending}>
          {sending ? 'Sending…' : 'Send test block'}
        </button>
        {actionError && <p className="error">{actionError}</p>}
      </section>

      <section className="panel">
        <h2>Log</h2>
        {log.length === 0 ? (
          <p className="muted">Empty.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>seq</th>
                <th>type</th>
                <th>action</th>
                <th>details</th>
              </tr>
            </thead>
            <tbody>
              {log.map((line) => (
                <tr key={line.seq}>
                  <td>{line.seq}</td>
                  <td>{line.lineType}</td>
                  <td>{line.payload.action}</td>
                  <td className="details">{describeLine(line)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {viewingSeq !== null &&
        (() => {
          const viewingLine = log.find((l) => l.seq === viewingSeq && l.lineType === 'block');
          if (!viewingLine) return null;
          return (
            <JsonModal
              title={`Block seq ${viewingSeq}`}
              value={viewingLine}
              onClose={() => setViewingSeq(null)}
            />
          );
        })()}
    </div>
  );
}

function describeLine(line: LineEnvelope): string {
  const p = line.payload as Record<string, unknown>;
  if (line.lineType === 'block') {
    const txs = p.transactions as unknown[] | undefined;
    return `${txs?.length ?? 0} transaction(s)`;
  }
  if (line.lineType === 'confirmation') {
    const target = p.target as { lineType: string; seq: number } | undefined;
    return `${p.vote} → ${target?.lineType} seq ${target?.seq}`;
  }
  if (line.lineType === 'governance') {
    const confirmers = p.confirmers as Array<{ id: string }> | undefined;
    return `writer=${(p.writer as { id: string } | undefined)?.id}, confirmers=[${(confirmers ?? []).map((c) => c.id).join(', ')}]`;
  }
  return '';
}
