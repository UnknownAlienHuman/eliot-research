# @eliotr/backup-o2 — ER-34 O2 portable backup epoch + encrypted offsite copy

O2 only. O3 restore/isolation and O4 source-erasure/purge replay stay
`NOT_IMPLEMENTED` and fail closed.

- Restart-safe replay authority lives in D1 (`replay-authority.ts` + `0017`
  migration). No `Map`-based durable claims.
- Complete authority vector is persisted as a content-addressed manifest and
  its digest is bound into the epoch/offsite receipt (`epoch.ts`,
  `coverage.ts`, `r2-inventory.ts`).
- Offsite destinations require controller-approved policy + authorization
  receipt; adapter self-report is evidence only (`destination-policy.ts`).
- AES-256-GCM with canonical AAD, key validation and nonce uniqueness
  (`offsite.ts`).
- O2 expiry lifecycle only: durable delete intent/receipt, absence proof,
  resurrection prevention (`expiry.ts`).
- `IMPLEMENTED_NOT_LIVE`: deterministic local D1/R2/WebCrypto tests exist;
  live Cloudflare/provider receipts are `NOT EXECUTED`.
