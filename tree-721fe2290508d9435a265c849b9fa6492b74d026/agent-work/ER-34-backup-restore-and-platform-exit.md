# ER-34: Backup restore and platform exit

**Slice:** 6
**Depends on:** ER-13, ER-14, ER-17
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/backup.ts`
- `infra/backup/**`

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
