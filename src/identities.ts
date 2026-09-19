import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Identity } from './types';

const CERTS_DIR = join(__dirname, '..', 'fixtures', 'dev-certs');

/**
 * Dev/test-only identities backed by throwaway self-signed certs checked into
 * fixtures/dev-certs/. Not for production use — see fixtures/dev-certs/README.md.
 */
function load(role: string): Identity {
  return {
    id: role,
    certPem: readFileSync(join(CERTS_DIR, `${role}.pem`), 'utf8'),
    keyPem: new Uint8Array(readFileSync(join(CERTS_DIR, `${role}.key`))),
  };
}

export const devIdentities = {
  writer: () => load('writer'),
  confirmerB: () => load('confirmer-b'),
  confirmerC: () => load('confirmer-c'),
};
