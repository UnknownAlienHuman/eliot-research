# ER-07: Exact evidence resolver and exhaustive scan

**Slice:** 1
**Depends on:** ER-02, ER-05, ER-06, ER-14
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/retrieval/src/evidence-resolver.ts`
- `packages/retrieval/src/exhaustive.ts`

## Read only

- `packages/contracts/src/evidence.ts`
- `packages/retrieval/src/ports.ts`

## Architecture extracts

- §5.3.1
- §6.7
- §6.10

## Required implementation

- Resolve owner generation, scope membership, authorization, purge state, exact revision digest, coordinate map, byte length and excerpt digest on every handle read.
- Partition frozen scopes into bounded ExactScanShards and persist partial manifests.
- Issue complete-scope absence only after all eligible shards reconcile.

## Acceptance

- Pinned handle reproduction is exact.
- Missing map narrows precision rather than fabricating coordinates.
- No Worker loads whole source or corpus.

## Mandatory negative boundary

Change the current source bytes while resolving an old handle; resolver must reject/substantiate the pinned revision, never substitute current bytes.

## Handoff contract

Produce:
- exact resolver
- sharded scan planner/merger
- coverage denominator receipt

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
