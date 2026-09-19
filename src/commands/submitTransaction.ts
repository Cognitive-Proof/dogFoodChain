import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devIdentities } from '../identities';
import { signTransaction } from '../signing';
import type { Identity } from '../types';

const SUBMITTER_IDENTITIES: Record<string, () => Identity> = {
  writer: devIdentities.writer,
  'confirmer-b': devIdentities.confirmerB,
  'confirmer-c': devIdentities.confirmerC,
};

/** Transactions are submitted off-chain, held here until the writer seals a block. */
export function pendingDirFor(logPath: string): string {
  return `${logPath}.pending`;
}

export async function submitTransaction(logPath: string, submitterRole: string, data: unknown): Promise<void> {
  const identityFn = SUBMITTER_IDENTITIES[submitterRole];
  if (!identityFn) {
    throw new Error(
      `unknown identity "${submitterRole}" — expected one of: ${Object.keys(SUBMITTER_IDENTITIES).join(', ')}`
    );
  }
  const submitter = identityFn();

  const id = `urn:uuid:${randomUUID()}`;
  const tx = await signTransaction(id, data, submitter);

  const dir = pendingDirFor(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${randomUUID()}.json`), JSON.stringify(tx, null, 2), 'utf8');

  console.log(`Submitted transaction ${id} from ${submitter.id} (pending — not yet in a block)`);
}
