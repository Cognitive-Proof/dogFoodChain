import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { summarizeState, replayChain } from './chain';
import { confirm } from './commands/confirm';
import { sealBlock } from './commands/sealBlock';
import { submitTransaction } from './commands/submitTransaction';
import { ConcurrentWriteError } from './gcsLogStore';
import { readLog } from './log';
import type { NodeConfig } from './nodeConfig';
import { receiveLine } from './receive';
import { pushToPeers, startSyncLoop } from './sync';

async function pushNewestLine(config: NodeConfig): Promise<void> {
  const lines = await readLog(config.logPath);
  const newest = lines[lines.length - 1];
  if (newest) await pushToPeers(config, newest);
}

/** Sends a write-command's error as 409 if it was a detected concurrent-write conflict
 *  (the caller should recompute and retry), 400 otherwise. */
function sendCommandError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  res.status(err instanceof ConcurrentWriteError ? 409 : 400).json({ error: message });
}

export function createServer(config: NodeConfig) {
  const app = express();
  // Permissive CORS: this is a local reference-implementation node, not a production
  // service, and the point is to let a locally-run UI (or curl, or a peer) hit it freely.
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, identity: config.identityRole ?? null, peers: config.peers });
  });

  // Full log, or everything from `since` onward — this is what peers pull from.
  app.get('/log', async (req: Request, res: Response) => {
    const since = Number(req.query.since ?? 0);
    const lines = await readLog(config.logPath);
    res.json(lines.filter((l) => l.seq >= since));
  });

  app.get('/state', async (_req: Request, res: Response) => {
    try {
      const state = await replayChain(await readLog(config.logPath));
      res.json(summarizeState(state));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // A peer (or a local operator) offering one new line to append.
  app.post('/log/lines', async (req: Request, res: Response) => {
    const outcome = await receiveLine(config.logPath, req.body);
    res.json({ outcome });
  });

  app.post('/transactions', async (req: Request, res: Response) => {
    if (!config.identityRole) {
      res.status(403).json({ error: 'this node has no signing identity configured (read-only relay)' });
      return;
    }
    try {
      await submitTransaction(config.logPath, config.identityRole, req.body);
      res.json({ ok: true });
    } catch (err) {
      sendCommandError(res, err);
    }
  });

  app.post('/blocks/seal', async (_req: Request, res: Response) => {
    if (config.identityRole !== 'writer') {
      res.status(403).json({ error: 'only a node configured with the writer identity can seal blocks' });
      return;
    }
    try {
      await sealBlock(config.logPath);
      await pushNewestLine(config);
      res.json({ ok: true });
    } catch (err) {
      sendCommandError(res, err);
    }
  });

  app.post('/confirmations', async (req: Request, res: Response) => {
    if (config.identityRole !== 'confirmer-b' && config.identityRole !== 'confirmer-c') {
      res.status(403).json({ error: 'this node has no confirmer identity configured' });
      return;
    }
    const { targetType, targetSeq, vote } = req.body as {
      targetType: 'block' | 'governance';
      targetSeq: number;
      vote?: 'approve' | 'reject';
    };
    try {
      await confirm(config.logPath, config.identityRole, targetType, targetSeq, vote ?? 'approve');
      await pushNewestLine(config);
      res.json({ ok: true });
    } catch (err) {
      sendCommandError(res, err);
    }
  });

  return app;
}

export function startNode(config: NodeConfig) {
  const app = createServer(config);
  const server = app.listen(config.port, () => {
    console.log(
      `dogFoodChain node listening on :${config.port}` +
        (config.identityRole ? ` as ${config.identityRole}` : ' (relay, no signing identity)') +
        (config.peers.length ? `, peers: ${config.peers.join(', ')}` : ', no peers configured')
    );
  });
  // Without this, a bind failure (e.g. the port is already held by another process —
  // including a stale instance of this same app) fails silently: callers keep talking
  // to whatever *is* listening on that port, attributing its responses to this node.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`dogFoodChain node: port ${config.port} is already in use — refusing to start`);
    } else {
      console.error(`dogFoodChain node: failed to start: ${err.message}`);
    }
    process.exit(1);
  });
  const syncTimer = startSyncLoop(config);
  return {
    server,
    close: () => {
      clearInterval(syncTimer);
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
