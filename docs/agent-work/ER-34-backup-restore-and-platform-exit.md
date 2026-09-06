# ER-34: Backup restore and platform exit

**Slice:** 6
**Depends on:** ER-13, ER-14, ER-17
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/backup-o2/**`
- `packages/platform-cloudflare/src/backup.ts`
- `infra/backup/**`

Integration dependencies (not owned): `infra/d1/core/migrations/0017_backup_o2_replay_authority.sql`
is ER-13-owned additive state required for D1 restart-safe replay authority; `scripts/check-boundaries.mjs`,
`tsconfig.json`, `packages/platform-cloudflare/package.json` and `packages/platform-cloudflare/tsconfig.json`
are workspace/barrel adjustments only. O2 is IMPLEMENTED_NOT_LIVE; O3 restore/isolation and O4
source-erasure/purge replay remain explicit fail-closed NOT_IMPLEMENTED with no live receipts.

## Read only

- `packages/contracts/src/backup.ts`
- `packages/contracts/src/erasure.ts`

## Architecture extracts

- §16

## Required implementation

- Create portable BackupEpoch with schema/migrations, Core export, R2 manifest, heads, generations, handles/tombstones and purge ledger plus encrypted offsite copy.
- Implement clean isolated restore that applies current purge ledger before payload exposure/projection rebuild.
- Produce portable Cloudflare exit manifest; search indexes/Queue/DO are rebuilt.

## Acceptance

- Offsite destination supports deletion journal/expiry.
- Restore verifies LIVE and REDACTED handles and exact/high-recall/erasure acceptance.
- Locked backup conflict reports PURGE_BLOCKED.

## Mandatory negative boundary

Restore an epoch containing later-purged bytes and prove they are removed/quarantined before any read traffic or index upload.

## Handoff contract

Produce:
- BackupEpoch creator
- offsite copy adapter
- restore verifier
- exit export

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
