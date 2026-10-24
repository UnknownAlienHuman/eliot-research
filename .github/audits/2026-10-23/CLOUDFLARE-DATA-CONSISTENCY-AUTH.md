# Cloudflare data consistency and Access credential sweep

**Reviewed:** 2026-10-23. **Branch baseline:**
[`b5908a70`](https://github.com/UnknownAlienHuman/eliot-research/tree/b5908a70ce888d1279b970c9ace4d370b59f0919).

This continuation checks D1 retry/replica semantics, R2 create/delete/upload/access guarantees and Access service-token
rotation against Eliot's one-owner data and agent model. It narrows what the application can safely treat as transparent.
It is source review, not a live database, object-store or Access exercise.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 105 | D1 automatically retries eligible read-only `SELECT`/`EXPLAIN`/`WITH` queries up to two additional times for retryable errors and reports `meta.total_attempts`. Write queries are not automatically retried; retrying them is safe only when Eliot's business operation is idempotent. | A hidden D1 read retry is one product read, not a new operation/attempt, activity event or user-visible retry. Record `total_attempts` only as bounded diagnostics. Write retry remains application-owned: reuse the same operation ID, guarded SQL/CAS/idempotency key and exponential backoff only for named transient errors. Never repeat a write merely because a generic `D1_ERROR` occurred. |
| 106 | D1 read replication is public beta and is used only through Sessions API. Ordinary binding queries continue to the primary. Sessions are sequentially consistent through bookmarks; `first-unconstrained` may begin on a replica, `first-primary` begins on the latest primary state, and a bookmark carries a lower-bound database version across sessions. | Keep read replication disabled for the initial one-owner product. It does not justify another browser/session/bookmark subsystem without a measured read-latency or throughput bottleneck. If later enabled, keep bookmarks server-owned consistency hints, never actor authority; use `first-primary` after authority/configuration writes and benchmark actual `served_by_region`/`served_by_primary` improvement before retaining the feature. |
| 107 | R2 offers strong global consistency for reads, writes, deletes and listing. Conditional writes are atomic: concurrent `If-None-Match: *` creates on one absent key cannot both succeed. A failed Workers API conditional `put()` returns `null`; after an acknowledged delete, subsequent reads/listing reflect the deletion. | Publish originals and immutable bodies with deterministic unique keys plus atomic create-once conditional writes; no custom storage reconciliation loop or overwrite path is needed. Treat a condition failure as an existing-object/conflict path and verify its recorded digest/metadata. After deletion, exact `head/get` absence is authoritative for R2 storage; D1 tombstones, index cleanup, backups and retained citations remain separate obligations. |
| 108 | R2 presigned URLs are bearer capabilities valid for a specific operation until expiry (one second to seven days) and work only on the S3 API hostname. Anyone holding the URL can use it. R2 temporary credentials are also bearer credentials; revoking their parent token stops them immediately. | Eliot does not use presigned `GET`/`DELETE` URLs for private source reading or cleanup; stream authorized ranges through the Worker so current Access/project/tombstone/retention checks run. Initial uploads also use the bounded Worker intake path. A future direct large-upload capability must be exact-key, short-lived, upload-only, bound to a pending D1 admission, reconciled by digest/size after upload and never treated as proof that the intended client uploaded it. URLs/credentials never enter chat, logs or export. |
| 109 | Access service-token rotation keeps the same Client ID and can keep old/new secrets valid together for one hour to 30 days (or a custom RFC 3339 deadline). Disabling a token immediately stops both the active secret and any previous secret in a grace period. New secrets are displayed once; newer secrets use a scannable `cfast_...` format. | Use one distinct service token per headless agent/integration. Rotate with the shortest practical grace period: install the new secret, verify an authenticated request and actor mapping, then revoke the old secret early rather than merely waiting. Suspected exposure uses immediate disable/rotation. Track expiry/last successful check and alert before expiry; never refresh duration as a substitute for rotation. Secret values stay outside D1, logs and exports. |
| 110 | R2 multipart uploads are resumable handles, not durable truth. `resumeMultipartUpload()` does not check that the upload exists; another invocation may already complete or abort it. Incomplete uploads are aborted after seven days by default. Multipart ETags are derived from part MD5 values plus part count and are not a canonical digest of the completed object. Completion makes the object immediately readable, but failed/unknown completion still requires state reconciliation. | Store a D1 upload row with source/actor, object key, upload ID, expected size/type, part policy and operation state. Stream an independent SHA-256 over canonical uploaded bytes; never use multipart ETag as source digest. Validate part number/size and the exact server-recorded ETags supplied to `complete`; treat missing/already-settled upload as reconciliation, not blind restart. Abort on rejection/cancellation where possible, rely on bounded lifecycle only as a final cleanup, and after completion verify R2 size/key plus the Eliot digest before publishing a source revision. |

## Selected baseline

```text
D1:
  read replication = disabled
  automatic read retries = accepted as one read; total_attempts diagnostics only
  write retries = explicit named transient errors + same operation/CAS/idempotency identity

R2:
  immutable create = deterministic key + If-None-Match: * / onlyIf
  private read/range = authenticated Worker route
  private delete = owner product function + retention/tombstone/index/backup reconciliation
  presigned URLs = disabled initially
  multipart state = D1 operation row + independent SHA-256; ETag is transport metadata only

Access service tokens:
  one token per integration
  strict Service Auth
  short rotation grace + tested new secret + early old-secret revoke
  immediate disable for suspected exposure
```

## Verification boundary

The current D1 retry/read-replication docs, R2 consistency/conditional-write/multipart/presigned-access docs and Access
service-token rotation/status docs were inspected. No D1 retry or replica region was observed, no R2 race/delete/
multipart/presigned operation was run and no Access secret was rotated or disabled. Those checks remain owned by the
D1/R2/Access vertical slices.
