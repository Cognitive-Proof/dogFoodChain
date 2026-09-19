#!/usr/bin/env node
import { Command } from 'commander';
import { confirm } from './commands/confirm';
import { initGovernance } from './commands/initGovernance';
import { sealBlock } from './commands/sealBlock';
import { submitTransaction } from './commands/submitTransaction';
import { verify } from './commands/verify';
import { startNode } from './server';
import type { IdentityRole } from './nodeConfig';

const program = new Command();
program.name('dogfoodchain').description('Reference implementation CLI for the dogFoodChain log');

program
  .command('init')
  .description('create a new log with a genesis governance line')
  .argument('<log>', 'JSONL log to create: a local file path, or gs://bucket/object.jsonl')
  .action(async (log: string) => {
    await initGovernance(log);
  });

program
  .command('submit')
  .description('sign a transaction and hold it pending until the next seal-block')
  .argument('<log>')
  .requiredOption('--as <identity>', 'submitter identity: writer|confirmer-b|confirmer-c')
  .requiredOption('--data <json>', 'JSON-encoded transaction data')
  .action(async (log: string, opts: { as: string; data: string }) => {
    await submitTransaction(log, opts.as, JSON.parse(opts.data));
  });

program
  .command('seal-block')
  .description('batch pending transactions into a new block, signed by the writer')
  .argument('<log>')
  .action(async (log: string) => {
    await sealBlock(log);
  });

program
  .command('confirm')
  .description('confirm (or reject) a block or pending governance proposal')
  .argument('<log>')
  .requiredOption('--as <identity>', 'confirmer identity: confirmer-b|confirmer-c')
  .requiredOption('--target-type <type>', 'block|governance')
  .requiredOption('--target-seq <seq>', 'seq of the line being confirmed', (v) => parseInt(v, 10))
  .option('--vote <vote>', 'approve|reject', 'approve')
  .action(
    async (
      log: string,
      opts: { as: string; targetType: 'block' | 'governance'; targetSeq: number; vote: 'approve' | 'reject' }
    ) => {
      await confirm(log, opts.as, opts.targetType, opts.targetSeq, opts.vote);
    }
  );

program
  .command('verify')
  .description('replay the whole log, verifying every signature and quorum rule')
  .argument('<log>')
  .action(async (log: string) => {
    await verify(log);
  });

program
  .command('serve')
  .description('run this process as a node: HTTP API + peer sync, so other nodes can share this chain')
  .requiredOption('--port <port>', 'HTTP port to listen on', (v) => parseInt(v, 10))
  .requiredOption('--log <path>', 'JSONL log for this node: a local file path, or gs://bucket/object.jsonl')
  .option('--peers <urls>', 'comma-separated peer base URLs, e.g. http://localhost:4002,http://localhost:4003', (v) =>
    v.split(',').map((s) => s.trim()).filter(Boolean)
  )
  .option('--identity <role>', 'writer|confirmer-b|confirmer-c — omit for a read-only relay node')
  .action((opts: { port: number; log: string; peers?: string[]; identity?: IdentityRole }) => {
    startNode({ port: opts.port, logPath: opts.log, peers: opts.peers ?? [], identityRole: opts.identity });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
