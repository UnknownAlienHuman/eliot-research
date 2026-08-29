# ER-18: Drive exchange protocol and provisioner

**Slice:** 0
**Depends on:** ER-01, ER-03
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/google-drive-exchange/src/index.ts`
- `packages/google-drive-exchange/src/serializer.ts`
- `packages/google-drive-exchange/src/contribution.ts`
- `packages/google-drive-exchange/src/provisioner.ts`
- `packages/google-drive-exchange/src/drive.test.ts`
- `packages/google-drive-exchange/package.json`
- `packages/google-drive-exchange/tsconfig.json`
- `packages/google-drive-exchange/AGENTS.md`

## Read only

- `packages/contracts/src/drive-exchange.ts`
- `docs/implementation/security-checklist.md`

## Architecture extracts

- §12.3–12.6

## Required implementation

- Implement fixed numeric sheet schema/template and one atomic appendCells batch for request + all payload parts.
- Canonicalize after exact readback; actor claim remains untrusted.
- Provision shadow generation and require append/import/readback fixture before activation.

## Acceptance

- Serializer emits valid Google RowData and byte/part limits.
- No existing request row is updated/sorted.
- Schema changes create new generation, never in-place mutation.

## Mandatory negative boundary

Build a request above 128 KiB or with six parts and prove serializer rejects before Drive call.

## Handoff contract

Produce:
- Exchange template/provisioner
- append serializer
- canonical contribution parser

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
