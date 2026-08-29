# ER-25: Owner PWA

**Slice:** 1
**Depends on:** ER-21, ER-24
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `apps/eliotr-pwa/**`

## Read only

- `packages/contracts/**`
- `docs/architecture/ELIOT_RESEARCH.md`

## Architecture extracts

- §12.1

## Required implementation

- Implement three persistent panels: projects/sources, investigation/work product, exact evidence.
- Add screens incrementally by slice and call owner API only.
- Always show health, readiness/freshness, coverage/unknowns, policy denial, budget stop, jobs and connector/provider degradation.

## Acceptance

- Initial JS bundle remains ≤600 KiB gzip.
- Evidence viewer shows exact revision/anchor/hash/provenance and neighboring text.
- No direct Cloudflare/Google/provider credential or binding.

## Mandatory negative boundary

Simulate Drive/model outage and prove core library/retrieval UI remains usable with explicit degraded status.

## Handoff contract

Produce:
- PWA shell/design system
- typed API client
- health/evidence views

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
