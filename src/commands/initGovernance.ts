import { randomUUID } from 'node:crypto';
import { devIdentities } from '../identities';
import { initLog } from '../log';
import { signLine } from '../signing';
import type { GovernancePayload } from '../types';

export async function initGovernance(logPath: string): Promise<void> {
  const writer = devIdentities.writer();
  const confirmerB = devIdentities.confirmerB();
  const confirmerC = devIdentities.confirmerC();

  const chainId = `urn:uuid:${randomUUID()}`;
  const payload: GovernancePayload = {
    action: 'genesis',
    supersedes: null,
    writer: { id: writer.id, certPem: writer.certPem },
    confirmers: [
      { id: confirmerB.id, certPem: confirmerB.certPem },
      { id: confirmerC.id, certPem: confirmerC.certPem },
    ],
    thresholds: { blockConfirmation: 0.5, governanceChange: 0.667 },
    trustAnchor: {
      description:
        'Dev/test chain — genesis trust is social/external per spec/schema.md, not cryptographically enforced.',
    },
  };

  const { line } = await signLine('governance', 0, chainId, payload, writer);
  await initLog(logPath, line);
  console.log(`Initialized ${logPath}`);
  console.log(`  chain:      ${chainId}`);
  console.log(`  writer:     ${writer.id}`);
  console.log(`  confirmers: ${confirmerB.id}, ${confirmerC.id}`);
}
