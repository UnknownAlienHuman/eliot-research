# Launch 05 / #93 — Connect the generic federation to real execution

Read execution-contract.md; code baseline f94bd7a. Canonical ELIOT_RESEARCH §§2,7.11,11.1–11.4,
13,15.1–15.5,19.11; language §§5–10. Owners ER-22 generic boundary, ER-41 D1 runtime, ER-01 schemas,
ER-03 policy, ER-24 transport/composition, ER-27 independent integration client. Client-side ELIOT
composition belongs to that repository and is not implemented by importing it into ERC.

## Existing foundation

Use `apps/eliotr-core/src/{federation-service,federation-scope-limits,federation-request-authorities}.ts`,
`packages/cloudflare-federation/{src,test}/`, `packages/interfaces/src/federation-api.ts`, existing
federation schemas/migration and exact evidence/scope stores. Immutable manifest/reservation/cancel/CAS
logic already exists. All seven public federation operations are disabled in baseline composition.
Do not reimplement existing storage or expose fake completed jobs to make the routes look active.

## Ordered local checkpoints

### F1 — Authenticated principal/manifest/authority composition (first task)

ER-22/41 services plus ER-21/24 HTTP. Derive requester/server identity and credential generations from
verified service authentication, not request fields. Resolve the exact allowed reference manifest,
client fence, frozen scope, bridge generation and purpose/disclosure/retention before passing to existing
reservation service. Store only bounded canonical bytes; no credential or client-state replication.
Tests through real local HTTP/D1: valid reserve/replay, foreign principal, changed credential/bridge/
fence/manifest/scope, expired capability and unknown load-bearing field. PASS: one immutable job per
exchange/idempotency; substitution rejects without another job; login alone grants no corpus access.
A reservation may be ACCEPTED without claiming research completion; executable completion is F3.

### F2 — Exact bundle, manifest, range and change reads (after F1)

ER-22/41 persistence, current ER-39 resolver, ER-21/24 seven-operation routing. Publish immutable bundle
manifests/sections through R2 readback and D1 receipt binding. Read results with bounded range/cursor
bound to job, principal, scope/fence, revision/digest and expiry. Recheck current deny/purge/owner before
return. Changes are replay-authoritative; notifications are hints. Do not invent a second artifact format.
Tests: tampered manifest/bytes/range, cross-job/source/session cursor, stale credential, truncated body,
missing part, expired result, purge during streaming, duplicate/omitted change pages. PASS: exact authorized
bytes/digest or typed narrower denial; no whole-result buffering above 512 KiB inline/8 MiB buffered R2,
no REDACTED content or private reference in error/metadata. Storage fixtures do not qualify F3 execution.

### F3 — Submit/status/cancel to existing research executor (after F1, #90 Q3, #92 W3/W6)

ER-24 composes the existing outbox and W2/W6 job services. Request acceptance plus outbox is atomic;
Queue is delivery, not authority. Cancellation is monotone and attempt-fenced. `research.pack` returns
audited evidence without unnecessary synthesis; run/audit/report use the selected governed executor.
Provider/transport COMPLETED and the nine research dispositions are separate fields throughout.
Tests: lost submit ACK, Queue absent/duplicate/redelivery, interrupted attempt, cancel versus completion,
stale worker finishing after replacement, partial output and provider uncertainty. PASS: one logical
operation, terminal/cancel receipt reconstructs after restart, no extra paid synthesis, and INCONCLUSIVE
never turns into ANSWERED_WITH_SUPPORTED_RESULT because transport completed.

### F4 — Independent wire client and optional ELIOT compatibility (after F2/F3)

ER-01/22 leaf adapter plus ER-27 proposed `tests/integration/federation-client.*` (register first).
Pin current independent peer contract/manifest/version; compare schemas rather than copying ERC's own
serializer into both ends of the test. Implement only optional leaf mappings named in §11.4: request,
observation/acquisition, export/reference manifest, evidence bundle, unsupported precision, completion
and StateFence. Keep synthesis candidate-only; no runtime dependency on ELIOT DB/DTO package.
Tests: all seven HTTPS operations from independent client, unknown version/key, mismatched exchange/fence,
reference/tool/verifier outside manifest, stale manifest, lost ACK, allowed ranged read, token rotation.
PASS: byte/schema identities map as specified, unsupported inputs fail closed and disposition never
strengthens. No reverse agent invocation, client canonical mutation, shared secrets or bidirectional sync.
Where peer artifact is unavailable, report the exact compatibility gate BLOCKED; generic F1–F3 remain testable.

### F5 — Full lifecycle, erasure linkage and probe (after F1–F4)

ER-27 actual local Worker/D1/R2 test: normalized source admission -> query/evidence -> federation submit
-> restart/status -> manifest/result/range -> changes -> cancel/terminal. Register exact source/bundle/
artifact dependency edges with #96 erasure. Remove transient Queue/DO state and prove durable replay.
Test purge/revoke during result read and after transport completion; repeat via independent client.
PASS: every output has exact source lineage, current authorization, truthful coverage/debt/disposition
and no deleted influence. Add suite to O1 shared runner, including wrong-target/generation, missing auth,
malformed receipt and timeout tests. Complete local acceptance needs real execution, not preseeded success.

## Commands and completion

Run shared commands plus `pnpm --filter @eliotr/cloudflare-federation test`, existing federation service
and contract fixtures, strict Worker typecheck and exact-head combined CI. Each F task begins with a
failing boundary test and closes with stored identity assertions. All F1–F5 local boxes must pass to
remove mandatory pending routes; service metadata or one successful status read is insufficient.
Pure federation/completion decisions target language-contract `eliotr-federation-core` and shared
versioned parity; no permanent TS/Rust dual authority.

## Cloudflare/peer test after #96 O7

Pin actual deployed build/bridge and independent peer; use approved mutually authenticated identities.
Exercise all seven operations and lost-ACK/token-rotation/cursor/range/purge failures, retaining request,
manifest, job/result and terminal digests plus redacted readbacks. Assert zero client-canonical writes,
zero out-of-manifest references and zero stronger-than-internal completion mappings (§19.11).
Follow cloudflare-handoff.md #93. No account mutation, live qualification or peer-agent launch is authorized
by this draft; missing ERC/peer code must be completed before a complete staging trial.
