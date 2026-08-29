# ER-17: Access observability and runtime limits

**Slice:** 0
**Depends on:** ER-00, ER-13
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/access.ts`
- `packages/platform-cloudflare/src/observability.ts`
- `packages/platform-cloudflare/src/runtime-limits.ts`

## Read only

- `docs/implementation/security-checklist.md`
- `docs/implementation/release-checklist.md`

## Architecture extracts

- §1.4
- §15.6–15.8

## Required implementation

- Verify Access JWT/service principal and produce bounded authenticated context.
- Emit required high-cardinality metrics without content; persist actionable health snapshots/incidents.
- Enforce request/response/R2/DO/Workflow/bundle/startup budgets.

## Acceptance

- Security, erasure and DEEP/AUDIT/REPORT failures are sampled 100%.
- No source/prompt/evidence content enters telemetry.
- Health exposes connector/provider degradation independently.

## Mandatory negative boundary

Attempt to log an evidence excerpt or credential-shaped field and prove redaction/drop occurs.

## Handoff contract

Produce:
- Access verifier
- metrics sink
- health/SLO evaluator
- runtime budget assertions

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
