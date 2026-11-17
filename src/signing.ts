import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  signAssetSidecar,
  signAssetSidecarWithIngredients,
  verifyAssetFromSidecar,
} from 'c2pa-rs-javascript-library';
import type { Identity, LineEnvelope, LineLink, LinePayload, LineType, TransactionEntry, TransactionLink } from './types';

const FORMAT = 'jsonc' as const;
const LINE_LINK_LABEL = 'org.dogfoodchain.line';
const TRANSACTION_LINK_LABEL = 'org.dogfoodchain.transaction';
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

/**
 * SHA-256 (base64) of a whole line — envelope, payload and manifest — in canonical form.
 * The next line's signed `prevHash` commits to this, which is what chains the log: C2PA
 * ingredients built from a bare payload record only a title, never a hash of the parent.
 */
export function lineHash(line: LineEnvelope): string {
  return createHash('sha256').update(payloadBytes(line)).digest('base64');
}

function manifestDefinitionFor(title: string, extraAssertions: Array<{ label: string; data: unknown }> = []) {
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
      ...extraAssertions,
    ],
  };
}

/** Reads one custom assertion from a verified sidecar's active manifest. */
function readAssertion(
  outcome: { manifests: Array<{ id: string; assertions: unknown }>; manifestStore?: { activeManifest?: string } | null },
  label: string
): unknown {
  const active =
    outcome.manifests.find((m) => m.id === outcome.manifestStore?.activeManifest) ?? outcome.manifests[0];
  const assertions = active?.assertions;
  if (assertions instanceof Map) return assertions.get(label);
  return assertions && typeof assertions === 'object' ? (assertions as Record<string, unknown>)[label] : undefined;
}

export interface SignedLine<T extends LinePayload> {
  line: LineEnvelope<T>;
  /** The exact canonical bytes that were signed — needed as this line's asset when a
   *  later line ingredient-chains to it. Not persisted; derivable via payloadBytes(). */
  asset: Uint8Array;
}

/**
 * Signs a payload as one JSONL line. The manifest carries an `org.dogfoodchain.line`
 * assertion binding the envelope (`lineType`, `seq`, `chainId`) and the hash of `prev`,
 * the line immediately before this one (null only for genesis) — that hash chain is what
 * makes the log tamper-evident. `ingredients` add C2PA provenance for readers but carry
 * no hash of the parent, so verification does not rely on them.
 */
export async function signLine<T extends LinePayload>(
  lineType: LineType,
  seq: number,
  chainId: string,
  payload: T,
  signer: Identity,
  prev: LineEnvelope | null,
  ingredients: IngredientRef[] = []
): Promise<SignedLine<T>> {
  const asset = payloadBytes(payload);
  const link: LineLink = { chainId, seq, lineType, prevHash: prev ? lineHash(prev) : null };
  const manifestDefinition = manifestDefinitionFor(`${lineType}-${seq}`, [{ label: LINE_LINK_LABEL, data: link }]);
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
  /** The signed `org.dogfoodchain.line` assertion; only meaningful when `trusted`. */
  link: LineLink | undefined;
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
  return {
    trusted: outcome.state === true,
    asset,
    link: readAssertion(outcome, LINE_LINK_LABEL) as LineLink | undefined,
  };
}

/**
 * Identifies which of several candidate identities actually signed `line`, by trying
 * each candidate's cert alone as the trust anchor. Avoids trusting a self-declared
 * "signer id" field — the match is a genuine signature check, not a label.
 */
export async function identifySigner<C extends { id: string; certPem: string }>(
  line: LineEnvelope,
  candidates: C[]
): Promise<{ signer: C; link: LineLink | undefined } | null> {
  for (const candidate of candidates) {
    const { trusted, link } = await verifyLine(line, [candidate.certPem]);
    if (trusted) return { signer: candidate, link };
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
  const submittedAt = new Date().toISOString();
  const link: TransactionLink = { id, submittedAt, submitterId: submitter.id };
  const manifestDefinition = manifestDefinitionFor(`transaction-${id}`, [
    { label: TRANSACTION_LINK_LABEL, data: link },
  ]);
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
    submittedAt,
    data,
    submitter: { id: submitter.id, certPem: submitter.certPem },
    manifest: Buffer.from(result.manifest).toString('base64'),
  };
}

/**
 * Verifies a nested transaction entry's own manifest against its own data, and that the
 * signed `org.dogfoodchain.transaction` assertion matches the entry's `id`, `submittedAt`
 * and `submitter.id` — those fields sit outside the signed data otherwise.
 */
export async function verifyTransaction(
  tx: TransactionEntry,
  trustedCertificates: string[]
): Promise<boolean> {
  const asset = payloadBytes(tx.data);
  let sidecar: Uint8Array;
  let outcome: Awaited<ReturnType<typeof verifyAssetFromSidecar>>;
  try {
    sidecar = new Uint8Array(Buffer.from(tx.manifest, 'base64'));
    outcome = await verifyAssetFromSidecar({ format: FORMAT, asset, sidecar, trustedCertificates });
  } catch {
    return false;
  }
  if (outcome.state !== true) return false;
  const link = readAssertion(outcome, TRANSACTION_LINK_LABEL) as TransactionLink | undefined;
  return (
    link !== undefined &&
    link.id === tx.id &&
    link.submittedAt === tx.submittedAt &&
    link.submitterId === tx.submitter.id
  );
}
