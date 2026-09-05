# Launch 05 — Eliot Memory OS federation

Status: queued draft, unclaimed. Integration dependencies: #90 retrieval and #92 governed research.
Owners ER-22 and ER-24, with ER-13/39 persistence/evidence and ER-21 transport. Read the federation
packets/contracts, `apps/eliotr-core/src/federation-service.ts`, its tests,
`packages/cloudflare-federation`, `packages/interfaces/src/federation-api.ts` and composition root.
The boundary library is already implemented: compose/reconcile it, do not rewrite it from scratch.

## Small sequential checkpoints

- [ ] F1. Audit/reuse the durable federation reservation/job/result ports and current manifest identity.
  Bind principal, scopes, policy, generation, exact canonical request digest and idempotency identity.
  Add missing D1/R2 adapters with guarded replay/readback and no reverse canonical-write authority.
- [ ] F2. Wire authenticated service-only submit/status into the Worker with strict byte/query/version
  limits. Route to #92 execution; provider acceptance or a Queue ACK never completes a research job.
- [ ] F3. Wire monotone cancel and honest result mapping. Mandatory regression: transport COMPLETED plus
  internal INCONCLUSIVE must remain inconclusive; stale attempts cannot overwrite newer terminal state.
- [ ] F4. Implement bounded result/bundle/manifest/range/change reads. Cursors bind principal/scope and
  generation; immutable bundle bytes/checksums and exact range semantics are checked on every response.
- [ ] F5. Register exact erasure dependencies, token rotation/expiry and disclosure boundaries. Reusing
  another client's handle/cursor or a removed scope cannot reveal metadata, snippets or existence.
- [ ] F6. Exercise all seven public federation operations against actual local Worker/D1/R2 and an
  independent contract client; submit -> restart -> status -> cancel/result -> manifest/range/changes.
  Cover duplicates, lost ACK, poisoned output, forged citations, over-strong absence and peer outage.

Do one adapter/operation plus negatives per commit, normally 2–5 files. Keep existing packet ownership
and exact public versions; coordinate shared route/migration/barrel changes. Consume current main from
#90/#92 before integration, not copies of their execution/evidence services. Do not edit Memory OS in
this PR or silently claim compatibility with a peer version not actually tested.

## Completion

All seven current unavailable federation operations must execute bounded durable paths; update the
registry/gap records and capability advertisement together. Require repository/Rust gates, strict
Workers tests, local boot and exact-head CI. Keep draft until F1–F6 pass. Retain peer version/manifest
and test bytes; real mutual-auth remote receipts stay NOT_EXECUTED until complete staging. No partial
deployment, no client canonical-write privilege and no 'completed' placeholder result.
