import { receiveLine } from './receive';
import { readLog } from './log';
import type { NodeConfig } from './nodeConfig';
import type { LineEnvelope } from './types';

/** Pulls any lines this node is missing from each configured peer. Best-effort per peer. */
export async function pullFromPeers(config: NodeConfig): Promise<void> {
  for (const peer of config.peers) {
    try {
      const since = (await readLog(config.logPath)).length;
      const res = await fetch(`${peer}/log?since=${since}`);
      if (!res.ok) continue;
      const newLines = (await res.json()) as LineEnvelope[];
      for (const line of [...newLines].sort((a, b) => a.seq - b.seq)) {
        await receiveLine(config.logPath, line);
      }
    } catch (err) {
      console.warn(`[sync] pull from ${peer} failed: ${(err as Error).message}`);
    }
  }
}

/** Best-effort push of a freshly-appended line to every peer, for low-latency propagation. */
export async function pushToPeers(config: NodeConfig, line: LineEnvelope): Promise<void> {
  await Promise.allSettled(
    config.peers.map((peer) =>
      fetch(`${peer}/log/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(line),
      })
    )
  );
}

export function startSyncLoop(config: NodeConfig): NodeJS.Timeout {
  return setInterval(() => {
    pullFromPeers(config).catch((err) => console.warn(`[sync] loop error: ${err}`));
  }, config.syncIntervalMs ?? 2000);
}
