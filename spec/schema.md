# dogFoodChain transaction log — line schemas (v0.2)

> **Implemented** in [`src/`](../src) — this document describes the design; the
> TypeScript types in [`src/types.ts`](../src/types.ts) and the signing/verification
> logic in [`src/signing.ts`](../src/signing.ts) / [`src/chain.ts`](../src/chain.ts)
> are the executable source of truth. Field names below use the wire's actual
> camelCase.

The log is a JSONL file. Each line is one of three `lineType`s: `governance`,
`block`, or `confirmation`. Every line carries a real C2PA sidecar manifest
signing its `payload`, and every line except genesis ingredient-chains to its
parent via a genuine C2PA `parentOf` ingredient (a hashedURI) — **this is
what makes the log tamper-evident, not any field inside the JSON payload
itself.**

## v0.1 → v0.2: what changed

v0.1 had the manifest as a hand-rolled `{claim_generator, signer, ingredients,
assertions, signature}` object, plus manual `hash` sub-fields on every
`governanceRef`/`prevBlockRef`/`target` reference (a parallel, hand-computed
SHA-256 chain alongside the manifest).

Both are gone in v0.2:

- **`manifest` is now real C2PA**: base64 JUMBF sidecar bytes produced by
  [`c2pa-rs-javascript-library`](https://github.com/mrappard/c2pa-rs-js-binding-library)'s
  `signAssetSidecar`/`signAssetSidecarWithIngredients`, verified with
  `verifyAssetFromSidecar`. Real cert-chain trust, real signatures, no
  custom crypto format to get subtly wrong.
- **No more manual hash fields.** A line's ingredient chain (in its C2PA
  manifest) is the sole source of truth for "this line follows that line" —
  a hand-computed hash sitting next to it in the JSON payload would just be
  a second, weaker copy of the same claim. References like
  `governanceRef`/`prevBlockRef`/`target` now carry only `{ lineType, seq }`
  — enough for a reader to locate the referenced line; the actual
  cryptographic binding lives in the manifest's ingredient.

## Canonicalization

A line's `payload` is signed as its RFC 8785 (JCS) canonical JSON form —
implemented via the [`canonicalize`](https://www.npmjs.com/package/canonicalize)
package. This is what makes `payload` (after `JSON.parse`) reproducibly
re-signable/re-verifiable regardless of how it was originally key-ordered or
formatted: canonicalizing the parsed object always reproduces the exact bytes
that were signed. See `payloadBytes()` in `src/signing.ts`.

## Common envelope

```json
{
  "lineType": "governance | block | confirmation",
  "seq": 42,
  "chainId": "urn:uuid:5f0c...",
  "payload": { "...": "type-specific, see below" },
  "manifest": "<base64 C2PA sidecar (JUMBF) bytes, signs canonicalize(payload)>"
}
```

- `chainId` ties every line to one genesis. Anyone can found their own chain
  (Org A/B/C), so this isn't a single global chain — it's an identifier for
  "which chain this line belongs to."
- `seq` is a convenience index for readers and must be contiguous
  (`line[i].seq === i`), but it is **not** itself a trust anchor — a
  verifier's confidence in a line's position comes from its manifest's
  ingredient, not from trusting the `seq` field.

## 1. Governance line

```json
{
  "action": "genesis",
  "supersedes": null,
  "writer": { "id": "writer", "certPem": "-----BEGIN CERTIFICATE-----..." },
  "confirmers": [
    { "id": "confirmer-b", "certPem": "..." },
    { "id": "confirmer-c", "certPem": "..." }
  ],
  "thresholds": { "blockConfirmation": 0.50, "governanceChange": 0.667 },
  "trustAnchor": { "description": "External attestation that this chain's founders are legitimate" }
}
```

- `action`: `"genesis"` for the first governance line in a chain, `"update"`
  for every subsequent one.
- `supersedes`: `null` for genesis; `{ seq }` of the prior governance line
  for an update — that prior line is also the update's ingredient parent.
- `thresholds` are fractions used as `required = floor(N * threshold) + 1`,
  where `N` is the size of the relevant confirmer set. Both values live in
  the governance object itself, so changing them later is itself a
  governance change, subject to the `governanceChange` rule.
- `trustAnchor` is deliberately outside the protocol — bootstrapping trust
  in a genesis line is a social/external question. The reference
  implementation only checks that the declared `writer` cert actually
  produced the genesis signature, not that the writer is who they claim to
  be in the world.

**Ratification rule:** a governance-update line is active once distinct
`confirmation` lines targeting it, signed by members of the **prior**
confirmer set (the one in the governance line it supersedes), reach the
`governanceChange` threshold computed against that prior set's size. Only
one governance proposal may be pending at a time per chain — a new update
line may only supersede the currently-active (not-yet-superseded) governance
line, so competing proposals off the same parent can't both be in flight.

## 2. Block line

```json
{
  "action": "block",
  "governanceRef": { "seq": 0 },
  "prevBlockRef": null,
  "transactions": [
    {
      "id": "urn:uuid:9a02...",
      "submittedAt": "2026-09-19T17:58:00Z",
      "data": { "...": "application-defined payload" },
      "submitter": { "id": "someone", "certPem": "..." },
      "manifest": "<base64 C2PA sidecar bytes, signs canonicalize(data)>"
    }
  ]
}
```

- Authored only by the identity named `writer` in the currently active
  governance line; the block line's own manifest is signed by the writer
  and ingredient-chains (`parentOf`) to the previous line (prior block, or
  the governance line if this is the first block).
- `transactions[]` are individually signed by their original submitters
  (arbitrary parties, not just the writer) — this is how per-transaction
  authorship is preserved even though transactions aren't top-level chain
  entries. The writer collects these off-chain and decides which to
  include and in what order; this design gives the writer full discretion
  over inclusion/ordering (no censorship-resistance guarantee) by choice,
  not oversight.
- `governanceRef` pins which governance line's writer/confirmer/threshold
  set applies to this block. `prevBlockRef` is `null` only for the first
  block after a given governance line; otherwise it names the prior block.

**Known gap:** the reference implementation currently verifies each line's
*own* signature and checks that `governanceRef`/`prevBlockRef` *declare* the
expected seq, but does not yet cross-check that a line's C2PA ingredient
hash actually matches the bytes of the line it claims to follow. See
`src/chain.ts`.

## 3. Confirmation line

```json
{
  "action": "confirm",
  "target": { "lineType": "block", "seq": 43 },
  "vote": "approve"
}
```

- `target.lineType` is `"block"` or `"governance"`. The confirmation line's
  manifest ingredient-chains (`parentOf`) to the target line.
- `vote` is `"approve"` or `"reject"`; only `"approve"` counts toward a
  threshold, `"reject"` is kept for the record/audit trail.
- The signer must be a member of the confirmer set that applies to the
  target: the governance line the block was issued under (for block
  confirmations), or the governance line being *superseded* (for governance
  confirmations).
- There is no explicit `"finalized"` flag anywhere in the log. Finality is
  always *derived* by a verifier: count distinct approving confirmations
  targeting a given line, and compare against the threshold computed from
  the correct confirmer set.

## Worked example (4 lines)

```jsonl
{"lineType":"governance","seq":0,"chainId":"urn:uuid:5f0c...","payload":{"action":"genesis","supersedes":null,"writer":{"id":"writer","certPem":"..."},"confirmers":[{"id":"confirmer-b","certPem":"..."},{"id":"confirmer-c","certPem":"..."}],"thresholds":{"blockConfirmation":0.50,"governanceChange":0.667}},"manifest":"<base64>"}
{"lineType":"block","seq":1,"chainId":"urn:uuid:5f0c...","payload":{"action":"block","governanceRef":{"seq":0},"prevBlockRef":null,"transactions":[{"id":"urn:uuid:9a02...","submittedAt":"...","data":{"msg":"hello"},"submitter":{"id":"someone","certPem":"..."},"manifest":"<base64>"}]},"manifest":"<base64, ingredient parentOf seq 0>"}
{"lineType":"confirmation","seq":2,"chainId":"urn:uuid:5f0c...","payload":{"action":"confirm","target":{"lineType":"block","seq":1},"vote":"approve"},"manifest":"<base64, ingredient parentOf seq 1>"}
{"lineType":"confirmation","seq":3,"chainId":"urn:uuid:5f0c...","payload":{"action":"confirm","target":{"lineType":"block","seq":1},"vote":"approve"},"manifest":"<base64, ingredient parentOf seq 1>"}
```

With `blockConfirmation = 0.50` and 2 confirmers, `required = floor(2*0.5)+1 = 2`.
Lines 2 and 3 give block (seq 1) both approvals, so it's finalized.

## Open items not yet nailed down

- **Ingredient hash cross-checking** (see "Known gap" above): verifying that
  a line's declared `prevBlockRef`/`governanceRef`/`target` actually matches
  the ingredient hash recorded inside its own manifest, not just that the
  seq numbers line up.
- What a verifier does with a block that never reaches its confirmation
  threshold (stuck forever vs. some timeout/expiry rule).
- Whether `data` inside a transaction needs its own sub-schema/versioning,
  or stays fully application-defined.
- Real identity/cert management (today: three self-signed dev-only certs in
  `fixtures/dev-certs/`, one per role — not a production trust model).
