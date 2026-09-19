# dogFoodChain

**Live at:** [github.com/Cognitive-Proof/dogFoodChain](https://github.com/Cognitive-Proof/dogFoodChain)

## FAQ

**What is dogFoodChain?**

C2PA relies on a number of externally-hosted resources to establish trust — trust lists, revocation/status lists, soft-binding and watermark resolution APIs, and more. Today all of these are addressed the same way: a URI. That's simple, but it puts trust in whoever controls that URL, which cuts against C2PA's broader goal of distributed, verifiable trust.

dogFoodChain is a **governed, distributed ledger that uses C2PA itself as its trust mechanism** — every entry is a real, signed C2PA manifest, cryptographically chained to the one before it. The goal is to give a defined group of independent participants a way to jointly maintain and verify a shared record — the kind of registry, list, or reference data C2PA's ecosystem depends on — without any single one of them being a point of trust or failure.

**Why "dog food"?**

Because it uses C2PA to secure C2PA's own supporting infrastructure. Rather than inventing a new trust mechanism for this kind of distributed record-keeping, dogFoodChain dogfoods the one C2PA already defines: signed manifests, certificate-based identity, and ingredient hash-chaining.

**How does governance work?**

Each chain starts with a genesis line that names one *writer* (the only identity allowed to append new data) and a set of *confirmers* who must reach a quorum to approve it. Both the confirmation threshold and the threshold required to change governance itself are defined in that genesis line, so governance can evolve, but only with the agreement of the parties already trusted to run the chain — not by whoever happens to hold write access.

**How is it tamper-evident?**

Every entry is a real C2PA manifest, ingredient-chained to the entry before it — the same mechanism C2PA already uses to bind a derived asset to its parent. Altering or reordering history breaks that chain and is immediately detectable by any participant, without needing to trust whoever wrote it.

**Is this a blockchain?**

It borrows the properties that matter — an append-only, cryptographically-chained, multi-party-verified log — without the parts that don't apply here: no mining, no token, no open-ended consensus problem, since write access is explicitly scoped to one identity and confirmation is a defined quorum vote rather than competition. "Governed distributed ledger" is the more accurate term.

**Can I run it myself?**

Yes. The repo includes a full reference implementation: a CLI, a long-running HTTP node so separate participants can each run their own and sync with each other, an optional Google Cloud Storage-backed storage mode, a small web dashboard, and a Docker Compose setup that boots three independent nodes plus the UI with one command. See the [README](README.md) for the quickstart.

**What's the current status?**

dogFoodChain is an early-stage reference implementation, not a production system. The core mechanism — governance, quorum confirmation, C2PA-signed chaining, multi-node sync — works and is tested, including against real cloud storage. Open items, tracked in [spec/schema.md](spec/schema.md), include hardening around concurrent writes and end-to-end ingredient-hash verification.
