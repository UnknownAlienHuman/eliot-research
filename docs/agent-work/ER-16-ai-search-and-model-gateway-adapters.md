# ER-16: AI Search and model gateway adapters

**Slice:** 1
**Depends on:** ER-00, ER-03
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/ai-search.ts`
- `packages/platform-cloudflare/src/model-gateway.ts`
- `infra/ai-search/**`
- `infra/cloudflare/ai-gateways.json`

## Read only

- `packages/contracts/src/model.ts`
- `packages/retrieval/src/ports.ts`

## Architecture extracts

- §6.2–6.4.2
- §8

## Required implementation

- Implement namespace/instance typed adapters and generation-aware search/item upload/readback.
- Keep retrieval and reasoning gateways separate; application code references routes, not providers.
- Record route fingerprint, model/prompt/schema generations, usage/cost and immutable embedding generation.

## Acceptance

- No in-place embedding model change.
- Partial shadow generation is never advertised complete.
- Scores from different vector generations are not mixed.

## Mandatory negative boundary

Point desired config at an existing instance with a different embedding model and prove provisioning fails instead of mutating it.

## Handoff contract

Produce:
- AI Search adapter
- gateway fetch adapter
- generation registry
- capability fixtures

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
