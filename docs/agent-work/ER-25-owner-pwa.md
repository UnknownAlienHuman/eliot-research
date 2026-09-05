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
- Decode versioned API envelopes from `unknown`; never cast transport JSON directly to domain/view types.
- Reject unknown load-bearing response fields and envelope/payload generation drift.
- Preserve typed API problem status, code, trace identity and retryability for degraded-state UI.
- Always show health, readiness/freshness, coverage/unknowns, policy denial, budget stop, jobs and connector/provider degradation.

## Current implemented contour

The system-health client accepts only:

```text
{ data, trace_id, deployment_generation }
```

and validates the exact nested `SystemHealth` shape. The legacy raw-health response, malformed JSON,
unknown fields, duplicate blocker codes, non-canonical timestamps, and generation mismatch all fail
closed. This is client validation only; it does not grant authority or qualify a live deployment.

## Acceptance

- Initial JS bundle remains ≤600 KiB gzip.
- Evidence viewer shows exact revision/anchor/hash/provenance and neighboring text.
- No direct Cloudflare/Google/provider credential or binding.
- A valid typed API problem is retained as a structured client error; malformed problems are not trusted.

## Mandatory negative boundary

Simulate Drive/model outage and prove core library/retrieval UI remains usable with explicit degraded status.
For the health transport, additionally feed the legacy raw payload and a mismatched generation and prove
that neither is rendered as valid system state.

## Handoff contract

Produce:
- PWA shell/design system
- typed API client
- health/evidence views

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.

## Launch 01 integration checkpoint

The connected normalized-bundle import panel and transport live in `apps/eliotr-pwa/src/bundle-*`.
For this checkpoint ER-25 integrates the narrow ER-21 prepare-digest/opaque-ETag contract additions,
ER-14 known-length R2 upload fix, ER-37 original-head replay fix and ER-29 prepare output. Existing
file ownership stays unchanged; the exact scope, failure tests and unfinished Library work are in
`docs/implementation/launch-prs/01-library.md`. No source-admission or canonicalization authority moves
to the browser. A validated folder or uploaded file is not an admitted, indexed or readable source.
