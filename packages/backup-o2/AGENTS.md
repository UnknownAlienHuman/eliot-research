# @eliotr/backup-o2 — ER-34 O2 portable backup epoch + encrypted offsite copy

O2 only. O3 restore/isolation and O4 source-erasure/purge replay stay
`NOT_IMPLEMENTED` and fail closed.

- Startup is fail-closed on migration `0018_backup_o2_replay_authority.sql`
  (`migration-gate.ts`): ledger row plus exact live schema shape required, no
  runtime CREATE TABLE substitute, no `migration-ledger:ABSENT` tolerance.
  (Renamed from 0017; W1 FIX5 reserves the 0017 slot, 0014–0016 never landed.)
- Restart-safe replay authority lives in D1 (`replay-authority.ts` + `0018`
  migration) with the canonical full intent digest (`intent-digest.ts`):
  principal, payload, policy decision, timestamps, revisions, vector/manifest
  and epoch/copy identity. Exact replay returns persisted bytes verbatim; any
  same-key divergence conflicts with zero new side effects. No `Map`-based
  durable claims.
- Coherent cut (`coherent-cut.ts`): controller-owned freeze token persisted in
  `backup_export_cut` binding D1 tables/schema/migration/purge plus the R2
  inventory generation to one cut; phase-2 seal rejects observable drift,
  including R2 re-put rollback (fresh etag/version). Every real Core column is
  exported and PRAGMA-verified; manifests carry `eliotr.backup-manifest.v1`.
- Offsite destinations require controller-owned D1 authority
  (`destination-authority.ts`) bound to initiating principal + approved policy
  decision; adapter self-report is evidence only, caller refs never
  self-authorize. Admissibility uses the controller-disciplined clock.
- AES-256-GCM with canonical AAD, key validation and durably unique nonces
  (`offsite.ts`, `offsite-durability.ts`): deterministic per (key generation,
  copy, part, content, policy) or controller-allocated, checkpointed in D1
  with resume, never an in-memory Set.
- O2 expiry lifecycle only: D1-authoritative expires_at/draft/holds, absence
  re-proof on terminal replay, resurrection prevention (`expiry.ts`).
- `IMPLEMENTED_NOT_LIVE`: deterministic local D1/R2/WebCrypto tests exist
  (actual migrations + R2-conformance harness through production paths; direct
  miniflare import is not permitted by repo infra); live Cloudflare/provider
  receipts are `NOT EXECUTED`.
