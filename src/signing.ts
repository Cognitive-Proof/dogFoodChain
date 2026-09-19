import canonicalize from 'canonicalize';
import {
  signAssetSidecar,
  signAssetSidecarWithIngredients,
  verifyAssetFromSidecar,
} from 'c2pa-rs-javascript-library';
import type { Identity, LineEnvelope, LinePayload, LineType, TransactionEntry } from './types';

const FORMAT = 'jsonc' as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The canonical bytes for a line's payload — what actually gets signed, and what a
 * verifier must reproduce from `payload` (after JSON round-tripping) to check the
 * signature. RFC 8785 (JCS) canonicalization makes this reproducible regardless of key
 * insertion order.
 */
export function payloadBytes(payload: unknown): Uint8Array {
  const canon = canonicalize(payload);
  if (canon === undefined) {
    throw new Error('payload could not be canonicalized (contains undefined/function values?)');
  }
  return textEncoder.encode(canon);
}

/** A parent (or sibling) line this line's manifest should ingredient-chain to. */
export interface IngredientRef {
  title: string;
  asset: Uint8Array;
  relationship?: 'parentOf' | 'componentOf' | 'inputTo';
}

function manifestDefinitionFor(title: string) {
  return {
    claim_generator_info: [{ name: 'dogfoodchain' }],
    title,
    assertions: [
      {
        label: 'c2pa.actions',
        data: {
          actions: [
            {
              action: 'c2pa.created',
              digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture',
            },
          ],
        },
      },
    ],
  };
}

export interface SignedLine<T extends LinePayload> {
  line: LineEnvelope<T>;
  /** The exact canonical bytes that were signed — needed as this line's asset when a
   *  later line ingredient-chains to it. Not persisted; derivable via payloadBytes(). */
  asset: Uint8Array;
}

/**
 * Signs a payload as one JSONL line. `ingredients` chains this line's manifest to
 * its parent(s) via real C2PA ingredient hashedURIs — this is what makes the log
 * tamper-evident, not any field inside `payload` itself.
 */
export async function signLine<T extends LinePayload>(
  lineType: LineType,
  seq: number,
  chainId: string,
  payload: T,
  signer: Identity,
  ingredients: IngredientRef[] = []
): Promise<SignedLine<T>> {
  const asset = payloadBytes(payload);
  const manifestDefinition = manifestDefinitionFor(`${lineType}-${seq}`);
  const signcert = textEncoder.encode(signer.certPem);

  const result =
    ingredients.length === 0
      ? await signAssetSidecar({
          format: FORMAT,
          asset,
          manifestDefinition,
          signcert,
          pkey: signer.keyPem,
          alg: 'es256',
        })
      : await signAssetSidecarWithIngredients(
          FORMAT,
          asset,
          manifestDefinition,
          signcert,
          signer.keyPem,
          'es256',
          ingredients.map((ref) => ({
            format: FORMAT,
            asset: ref.asset,
            title: ref.title,
            relationship: ref.relationship ?? 'parentOf',
          }))
        );

  // Sanity check: the bytes C2PA actually hashed must equal what we intended to sign,
  // or a verifier reconstructing `asset` from `payload` later would never match.
  const signedText = textDecoder.decode(result.signedAsset);
  const expectedText = textDecoder.decode(asset);
  if (signedText !== expectedText) {
    throw new Error(
      `signed asset bytes diverged from the canonical payload for ${lineType}-${seq}; ` +
        'the log would not be independently verifiable from payload + manifest alone'
    );
  }

  const manifest = Buffer.from(result.manifest).toString('base64');
  return {
    line: { lineType, seq, chainId, payload, manifest },
    asset: result.signedAsset,
  };
}

export interface VerifyResult {
  /** true iff the signature is cryptographically valid AND trusted against `trustedCertificates`. */
  trusted: boolean;
  asset: Uint8Array;
}

/** Verifies one line's manifest against its (reconstructed) payload bytes. */
export async function verifyLine(
  line: LineEnvelope,
  trustedCertificates: string[]
): Promise<VerifyResult> {
  const asset = payloadBytes(line.payload);
  const sidecar = new Uint8Array(Buffer.from(line.manifest, 'base64'));
  const outcome = await verifyAssetFromSidecar({
    format: FORMAT,
    asset,
    sidecar,
    trustedCertificates,
  });
  return { trusted: outcome.state === true, asset };
}

/**
 * Identifies which of several candidate identities actually signed `line`, by trying
 * each candidate's cert alone as the trust anchor. Avoids trusting a self-declared
 * "signer id" field — the match is a genuine signature check, not a label.
 */
export async function identifySigner<C extends { id: string; certPem: string }>(
  line: LineEnvelope,
  candidates: C[]
): Promise<C | null> {
  for (const candidate of candidates) {
    const { trusted } = await verifyLine(line, [candidate.certPem]);
    if (trusted) return candidate;
  }
  return null;
}

/**
 * Signs an off-chain transaction: a submitter's own manifest over their data, handed to
 * the writer to (maybe) include in a future block. Not a top-level JSONL line — this
 * gets nested inside a block's `payload.transactions[]`.
 */
export async function signTransaction(
  id: string,
  data: unknown,
  submitter: Identity
): Promise<TransactionEntry> {
  const asset = payloadBytes(data);
  const manifestDefinition = manifestDefinitionFor(`transaction-${id}`);
  const signcert = textEncoder.encode(submitter.certPem);

  const result = await signAssetSidecar({
    format: FORMAT,
    asset,
    manifestDefinition,
    signcert,
    pkey: submitter.keyPem,
    alg: 'es256',
  });

  const signedText = textDecoder.decode(result.signedAsset);
  if (signedText !== textDecoder.decode(asset)) {
    throw new Error(`signed asset bytes diverged from the canonical data for transaction ${id}`);
  }

  return {
    id,
    submittedAt: new Date().toISOString(),
    data,
    submitter: { id: submitter.id, certPem: submitter.certPem },
    manifest: Buffer.from(result.manifest).toString('base64'),
  };
}

/** Verifies a nested transaction entry's own manifest against its own data. */
export async function verifyTransaction(
  tx: TransactionEntry,
  trustedCertificates: string[]
): Promise<boolean> {
  const asset = payloadBytes(tx.data);
  const sidecar = new Uint8Array(Buffer.from(tx.manifest, 'base64'));
  const outcome = await verifyAssetFromSidecar({ format: FORMAT, asset, sidecar, trustedCertificates });
  return outcome.state === true;
}
