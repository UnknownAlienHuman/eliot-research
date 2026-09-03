# ER-16: AI Search and model gateway adapters

**Slice:** 1
**Depends on:** ER-00, ER-03
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/cloudflare-ai/**`
- `packages/platform-cloudflare/src/ai-search.ts`
- `packages/platform-cloudflare/src/ai-search.test.ts`
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

## Active implementation slice — managed-search locator boundary

This slice replaces the unconditional AI Search result-mapping placeholder with a strict instance-level
Workers binding decoder while retaining TypeScript/Cloudflare production authority.

The decoder:

- accepts only the documented `search_query` plus `chunks` response shape and rejects unknown fields at
  the result, chunk, item, metadata and scoring-detail levels;
- enforces the provider ceiling of 50 results, the caller's retrieval limit, a 64 KiB UTF-8 preview
  ceiling, bounded identifiers, finite scores and positive ranks;
- requires every returned source revision to remain inside the frozen `ScopeSnapshot`;
- requires the stored `item.key`, metadata `item_key`, and promoted `projection_generation` to agree;
- retains the content digest, taint state and documented scoring details only as locator metadata;
- maps managed vector results to `SEM` and managed keyword results to `LEX`, never to literal proof;
- passes reconstructed rows through the existing ERC strict locator decoder and returns only
  `proof_state: UNRESOLVED_LOCATOR`.

The readable negative corpus lives under `infra/ai-search`; a minimal package-local Vitest bridge keeps
it in the normal repository test run without exceeding the existing `platform-cloudflare` 10,000-line
source ceiling. The corpus covers stale generation, out-of-scope source, item-key mismatch, duplicate
chunk identity, authority-shaped metadata, unknown fields, malformed scores/ranks/digests/taint, preview
byte overflow, cardinality overflow, duplicate lanes and attempted literal-proof escalation.

This slice does not implement namespace provisioning, item upload/readback, active-generation promotion,
model-gateway execution, live AI Search calls or the packet's immutable-model negative gate. Those remain
open. Cloudflare, Google and provider receipts remain `NOT EXECUTED`.

## Active implementation slice — reasoning-gateway call policy boundary

This slice replaces the model-gateway type-only scaffold with a strict, transport-neutral policy
compiler and response-observation decoder for the `eliotr-reasoning` gateway.

The boundary:

- accepts only the ten application-owned `dynamic/eliotr-*` routes and rejects direct provider/model
  selection or unknown input/deployment fields;
- binds each call to the deployed route version plus exact prompt, output-schema, parameter and pricing
  generations;
- requires bounded `EvidencePack` input containing unique LIVE resolved handles and verifies that the
  declared byte count does not understate exact UTF-8 excerpts;
- caps both reserved input and output at the repository's 256 KiB ordinary model-call envelope;
- emits only the Cloudflare `compat/chat/completions` route policy, five scalar custom-metadata entries,
  metadata-only logging, payload-log suppression and explicit cache bypass;
- records the actual provider and exact model selected by a Dynamic Route from the documented
  `cf-aig-provider` and `cf-aig-model` response headers;
- strictly decodes compact model receipts and requires route-fingerprint and reserved-output-object
  parity before usage/cost observations are admitted.

Cache remains bypassed until a separate revision-keyed cache contract is implemented. Gateway cost is an
observed estimate and does not replace the provider/billing authority. The slice does not compile prompts,
invoke the live gateway, persist model output, create the immutable route fingerprint record, provision
Dynamic Route versions, or prove spend-limit/DLP/fallback behavior. Those remain open, so ER-16 is not
complete. Cloudflare, Google and provider receipts remain `NOT EXECUTED`.

## Active implementation slice — AI Search generation lifecycle

The saturated `platform-cloudflare` package is not extended past its 10,000-line ceiling. Generation
governance instead lives in the dedicated `@eliotr/cloudflare-ai` package boundary.

This non-live state machine provides:

- immutable instance-profile admission, including embedding-model and metadata-field equality;
- bounded declarations and monotonic shadow indexing/readback accounting;
- `SHADOW_COMPLETE` only after every expected item is indexed and read back, no failure or
  differential mismatch remains, and a retained golden-set result is present;
- fail-closed `BLOCKED` state for any failed item or mismatch;
- active-head compare-and-swap promotion that atomically retires the previous generation;
- explicit rejection of candidate sets that mix scores from different index generations.

No Cloudflare instance is created or mutated by this slice. Registry persistence, provisioning API
calls, live golden-set receipts, production promotion, and workload qualification remain open and
`NOT EXECUTED`.
