# ER-14: R2 staging residency and ingest

**Slice:** 1
**Depends on:** ER-01, ER-03, ER-13
**Live gate:** none

## Objective

Implement the R2 storage boundary without acquiring source-admission, policy, erasure-decision, or
projection authority. The adapter owns staging mechanics and immutable byte publication only.

## Owned paths

- `packages/platform-cloudflare/src/r2.ts`
- `packages/platform-cloudflare/src/r2.test.ts`
- `packages/platform-cloudflare/src/ingest.ts`
- `packages/platform-cloudflare/src/ingest-types.ts`
- `packages/platform-cloudflare/src/ingest-validation.ts`
- `packages/platform-cloudflare/src/ingest-state.ts`
- `packages/platform-cloudflare/src/ingest-storage.ts`
- `packages/platform-cloudflare/src/ingest-multipart.ts`
- `packages/platform-cloudflare/src/ingest-verification.ts`
- `packages/platform-cloudflare/src/ingest-promotion.ts`
- `packages/platform-cloudflare/src/ingest-test-fixture.ts`
- `packages/platform-cloudflare/src/ingest.test.ts`
- `packages/platform-cloudflare/src/ingest-resilience.test.ts`
- `packages/cloudflare-raw-ingest/package.json`
- `packages/cloudflare-raw-ingest/tsconfig.json`
- `packages/cloudflare-raw-ingest/src/index.ts`
- `packages/cloudflare-raw-ingest/src/raw-ingest-types.ts`
- `packages/cloudflare-raw-ingest/src/raw-ingest.ts`
- `packages/cloudflare-raw-ingest/src/raw-capture-owner-service.ts`
- `packages/cloudflare-raw-ingest/src/raw-ingest.test.ts`
- `packages/cloudflare-raw-ingest/src/raw-capture-http.ts`
- `infra/r2/**`

## Read only

- `packages/contracts/src/residency.ts`
- `packages/contracts/src/normalized-bundle.ts`
- `packages/domain/src/residency.ts`

## Architecture extracts

- §3 R2 layout
- §4
- §4.10
- §15.1
- §15.3

## Implemented contour

```text
prepare exact bundle envelope
→ deterministic idempotency-bound staging session
→ multipart upload with exact byte-count transform
→ complete each file and reopen it
→ SHA-256 + size + ETag + metadata + media-type verification
→ verify manifest.json and hashes.sha256 semantics
→ accept an optional coordinate-map JSON only when its manifest path and digest are paired and hashed
→ require admission-authority promotion authorization
→ write immutable residency/source/revision-scoped Evidence objects
→ exact readback of every promoted object
→ immutable promotion receipt
```

The R2 adapter uses conditional immutable writes. A `null` conditional result or an ambiguous provider
error is reconciled by reopening the exact key and verifying bytes, size, metadata, media type, and
SHA-256. It never treats a timeout as proof of failure and never overwrites an incompatible object.

Each promoted file receives its own complete `ObjectResidencyKey`: the source-level policy domains are
preserved while `content_digest` is bound to that exact file. The physical normalized-object key also
binds the origin owner, source namespace, owner generation, logical source, and source revision through
stable hashed identity components.

Staging sessions, file-completion receipts, promotion receipts, and abort tombstones are immutable JSON
objects with their own readback digest. Unknown load-bearing fields fail closed. Abortion publishes the
tombstone before deleting staging bytes; cleanup verifies absence after deletion.

## Authority limits

ER-14 does **not**:

- admit a `SourceRevision`;
- decide residency, disclosure, retention, license, or erasure policy;
- create a D1 source head or outbox intent;
- enqueue projection work;
- turn a staging key into an evidence handle;
- authorize promotion from a string reference alone.

`promote()` therefore requires a caller-supplied admission-authority verifier that binds the session
fingerprint, complete residency digest, owner generation, source revision, and exact admission receipt.
The remaining end-to-end authority path belongs to ER-13/ER-15/ER-24/ER-29.

## L2 raw capture continuation

The raw-file checkpoint adds a durable, owner-bound capture intent without creating a second
admission authority. `@eliotr/cloudflare-raw-ingest`'s `createRawCapturePort` writes an `INTENT` row before the R2 effect, publishes
the bounded byte stream to a source/revision/residency-bound immutable key, and only then records and
reads back a `CAPTURED` receipt. The owner-only Worker route derives source and residency identities
from the verified active namespace policy; clients provide only a bounded filename, digest, length,
content type, and idempotency key. The connected owner HTTP profile uses the existing 16 MiB
application upload envelope; larger objects require the later multipart bridge. Replays use the same capture identity and reject a changed request
tuple; owner/policy currentness is checked before the intent, after R2, and after the receipt readback.
The adapter deliberately does not create a `SourceRevision`, normalized manifest, conversion receipt,
projection row, grant, or evidence handle. ER-21/ER-24/ER-37 own the authenticated route, composition,
and `raw_file_capture` migration. Managed conversion and normalized admission remain a later L3 step.

## Acceptance

- Same canonical key with different bytes or authority metadata is an integrity failure.
- Identical bytes under a different erasure or encryption-key domain receive a different physical key.
- Declared multipart length must equal the bytes actually streamed.
- Non-final multipart parts are uniform and at least 5 MiB; at most 10,000 parts are accepted.
- Lost upload/completion/promotion acknowledgements reconcile to one immutable winner.
- Modified completion/session/promotion JSON is rejected by digest and strict-field validation.
- A semantically false `hashes.sha256` file blocks promotion even when every uploaded byte hash matches
  its prepared envelope.
- A declared coordinate-map path without its matching digest, or with a mismatched file hash, fails
  before promotion; map presence does not change the manifest's capability or qualification ceiling.
- Staging objects cannot resolve as evidence.

## Mandatory negative boundary

Upload identical bytes under a different erasure or encryption-key domain and prove physical/key reuse
is impossible. Also replay an ambiguous write acknowledgement and prove that readback returns one
canonical object rather than creating another mutation.

## Verification

```text
pnpm --filter @eliotr/platform-cloudflare typecheck
pnpm --filter @eliotr/platform-cloudflare test
pnpm check:contracts
pnpm check:boundaries
pnpm check:budgets
pnpm check:work-packets
```

The implementation has deterministic unit/recorded-fixture coverage. A real Cloudflare R2 round trip is
still part of the containing Slice 1/T4 gate and must not be inferred from local fixtures.

## Handoff contract

Produce:

- R2 immutable object adapter;
- resumable multipart session protocol;
- byte/digest/readback verification;
- residency-safe normalized layout;
- promotion and tombstone receipts;
- deterministic negative and lost-ack fixtures.

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
results, live receipts (or `NOT EXECUTED`), and follow-up owner packets. Do not mark the entire ingest
slice complete while D1 admission, outbox, Queue, projection, or live R2 gates remain open.


## Launch 01 continuation integration

The existing `ingest-test-fixture.ts` owns one shared staging-port constructor used by both staging test
suites. It removes repeated setup, not cases or assertions; denial, altered clocks and expiry remain
explicit caller overrides. This keeps the same tests and package budget without exempting test files,
increasing limits or introducing a second storage implementation. ER-37 retains current admission-policy
checks; browser checkpoints do not replace this R2 adapter's byte/metadata verification.
