# dogFoodChain

A governed, C2PA-signed JSONL append-only log. See the [FAQ](FAQ.md) for
what this is and why; design in [spec/schema.md](spec/schema.md);
reference implementation in [src/](src).

A single writer appends blocks of transactions; a confirmer quorum (defined
in the log's own genesis governance line) approves each block and, when
needed, votes to change governance itself. Every line is a real C2PA
manifest, ingredient-chained to the line before it — that's what makes the
log tamper-evident.

## Setup

```bash
npm install
```

Pulls [`c2pa-rs-javascript-library`](https://www.npmjs.com/package/c2pa-rs-javascript-library)
straight from npm — no sibling repo checkout needed.

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

## Running as a node

`serve` turns the same core (`src/chain.ts`/`src/signing.ts`) into a
long-running HTTP node, so three separate people — each running their own
process, each holding only their own private key — can maintain one chain
together. Nodes push newly-appended lines to their peers immediately and
periodically pull to catch up on anything missed; every incoming line is
independently revalidated (`src/receive.ts`) before being accepted, never
just trusted because a peer sent it.

A genesis line has to be distributed out-of-band before any node starts —
see spec/schema.md on why genesis trust is deliberately outside the
protocol. Once each participant has the same genesis line in their own log
file:

```bash
# Terminal 1 — the writer's node
npx tsx src/cli.ts serve --port 4101 --log writer.jsonl \
  --peers http://localhost:4102,http://localhost:4103 --identity writer

# Terminal 2 — confirmer-b's node
npx tsx src/cli.ts serve --port 4102 --log confirmer-b.jsonl \
  --peers http://localhost:4101,http://localhost:4103 --identity confirmer-b

# Terminal 3 — confirmer-c's node
npx tsx src/cli.ts serve --port 4103 --log confirmer-c.jsonl \
  --peers http://localhost:4101,http://localhost:4102 --identity confirmer-c
```

Each node exposes: `GET /health`, `GET /log[?since=N]`, `GET /state`,
`POST /log/lines` (peer sync), `POST /transactions`, `POST /blocks/seal`
(writer only), `POST /confirmations` (confirmers only). A node started
without `--identity` is a read-only relay — it still validates, stores, and
forwards lines, it just can't sign new ones.

```bash
curl -X POST localhost:4101/transactions -H 'Content-Type: application/json' \
  -d '{"msg":"hello"}'
curl -X POST localhost:4101/blocks/seal
curl -X POST localhost:4102/confirmations -H 'Content-Type: application/json' \
  -d '{"targetType":"block","targetSeq":1,"vote":"approve"}'
curl -X POST localhost:4103/confirmations -H 'Content-Type: application/json' \
  -d '{"targetType":"block","targetSeq":1,"vote":"approve"}'
curl localhost:4101/state   # same state on 4102 and 4103 once sync catches up
```

`test/network.test.ts` runs this exact flow against three real in-process
HTTP servers and asserts all three converge on identical, independently
re-verified state.

### Storing a node's log in a bucket instead of a local file

Pass `--log gs://your-bucket/writer.jsonl` instead of a local path — that's
the only thing that changes. Each node is expected to own its own bucket
object; pointing two nodes at the *same* object turns this from "three
independently-verified replicas" into one shared store with three API
fronts in front of it, which is a different trust model than the rest of
this design assumes.

Auth is via [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials) —
either run `gcloud auth application-default login` locally, or set
`GOOGLE_APPLICATION_CREDENTIALS` to a service account key file. The bucket
itself has to already exist (this doesn't create one); `init`/`serve` will
create the *object* the first time a genesis line is written to it.

Appends to a `gs://` log are guarded against concurrent writers using GCS's
generation preconditions (`ifGenerationMatch`) — a losing writer gets a 409
back (`ConcurrentWriteError`) rather than corrupting the log, which local
file paths currently don't guard against at all (see `src/gcsLogStore.ts`).
`test/gcsLogStore.test.ts` exercises this against an in-memory fake (no real
bucket needed).

**Real-bucket smoke testing.** Three test buckets exist in the
`cognitive-proof-dev` GCP project — `dogfood1`, `dogfood2`, `dogfood3`
(`us-central1`), one per identity (writer/confirmer-b/confirmer-c). Requires
`gcloud auth application-default login` first.

```bash
# Genuine concurrent-write race against a real bucket, not a fake:
DOGFOODCHAIN_GCS_SMOKE_BUCKET=dogfood1 npx vitest run test/gcsLogStore.smoke.test.ts
```

The full 3-node flow has also been run by hand against all three buckets
(`--log gs://dogfood1/writer.jsonl` etc.) and confirmed to converge —
see the session history rather than a checked-in script, since it's the same
`serve` walkthrough above with `gs://` paths instead of local files. Buckets
are left empty between runs; nothing about them is deleted by `npm test`.

## UI

A small Vite + React dashboard in [ui/](ui) points at one node at a time
(default `http://localhost:4101`, editable and remembered per-browser) and
polls `/state` and `/log` every 2s.

- **Send test block** — submits a canned transaction and seals it. Only
  works against a node running with the `writer` identity; shows that
  node's own error message otherwise.
- **Confirm** (per unconfirmed block) — signs as whichever identity *this
  node* holds, so point Node URL at a confirmer's node first.
- **View JSON** — opens a block's full signed line (payload + manifest) in
  a modal, so you can see exactly what you're agreeing to before clicking
  Confirm.

```bash
npm run ui   # or: npm --prefix ui run dev
```

Requires at least one `serve` node already running (CORS is enabled on the
node side for this).

## Test

```bash
npm test
```

## Try the whole thing with Docker Compose

Boots three nodes (writer, confirmer-b, confirmer-c) and the UI, all wired
together, no local Node/npm setup required beyond Docker itself:

```bash
docker compose up -d
open http://localhost:5173   # UI, defaults to the writer's node
```

- `writer` → `localhost:4101`, `confirmer-b` → `localhost:4102`,
  `confirmer-c` → `localhost:4103`. Nodes talk to each other over the
  compose network (`http://writer:4101` etc.); the UI talks to them over
  `localhost` since it runs in your browser, outside that network.
- All three start from the same checked-in genesis line
  (`fixtures/docker-genesis.jsonl`) — see `docker/entrypoint.sh`. Three
  independently-started nodes can't each generate their own genesis and
  still expect to converge (see spec/schema.md on why genesis distribution
  is inherently out-of-band); this is that step, automated for the demo.
- Storage is local-file, inside each container — `docker compose down`
  resets the chain to genesis. (Point `DOGFOODCHAIN_LOG` at a `gs://` path
  instead if you want a bucket-backed node in Compose; you'd also need to
  mount GCP credentials into the container, which isn't wired up here.)
- Try it: `curl -X POST localhost:4101/transactions ...` /
  `.../blocks/seal` /  `.../confirmations` as in the walkthrough above, or
  just click through the UI at `:5173`.

```bash
docker compose down   # stop and remove containers (chain data goes with them)
```
