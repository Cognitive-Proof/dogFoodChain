# dogFoodChain

A governed, C2PA-signed JSONL append-only log. Design in
[spec/schema.md](spec/schema.md); reference implementation in [src/](src).

A single writer appends blocks of transactions; a confirmer quorum (defined
in the log's own genesis governance line) approves each block and, when
needed, votes to change governance itself. Every line is a real C2PA
manifest, ingredient-chained to the line before it — that's what makes the
log tamper-evident.

## Setup

```bash
npm install
```

This installs [`c2pa-rs-javascript-library`](https://github.com/mrappard/c2pa-rs-js-binding-library)
from the sibling `../c2pa-rs-javascript-library` checkout (see `package.json`).

## Try it

```bash
npx tsx src/cli.ts init demo.jsonl
npx tsx src/cli.ts submit demo.jsonl --as writer --data '{"msg":"hello"}'
npx tsx src/cli.ts seal-block demo.jsonl
npx tsx src/cli.ts confirm demo.jsonl --as confirmer-b --target-type block --target-seq 1
npx tsx src/cli.ts confirm demo.jsonl --as confirmer-c --target-type block --target-seq 1
npx tsx src/cli.ts verify demo.jsonl
```

Identities (`writer`, `confirmer-b`, `confirmer-c`) are dev/test-only
self-signed certs under `fixtures/dev-certs/` — see that directory's README
before using this for anything beyond local testing.

## Test

```bash
npm test
```
