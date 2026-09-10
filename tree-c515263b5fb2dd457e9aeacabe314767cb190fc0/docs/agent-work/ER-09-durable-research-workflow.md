# ER-09: Durable research workflow

**Slice:** 4
**Depends on:** ER-08, ER-15, ER-16
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/workflow.ts`
- `apps/eliotr-core/src/research-workflow.ts`
- `infra/workflows/**`
- `packages/cloudflare-research/**`
- `apps/eliotr-core/test/research-workflow.test.ts`
- `apps/eliotr-core/test/research-workflow-fixture.ts`
- `docs/implementation/workflow-checkpoints.md`

The durable model-route D1 registry belongs to this package alongside model-attempt persistence.
Its provider contracts and codecs are imported from ER-16's `@eliotr/cloudflare-ai` public API.
The `0035_model_route_registry.sql` migration remains an ER-13 integration handoff; the actual D1
fixture `apps/eliotr-core/test/model-deployment-registry.test.ts` remains an ER-27 handoff.

The next internal gateway persistence adapters also belong to this package: observed model
fingerprints and the logical-output-to-residency mapping. Their allocated ER-13 migration handoffs are
`0036_research_model_fingerprints.sql` and `0037_research_model_outputs.sql`; ER-27 owns the corresponding
`research-model-fingerprint-store.test.ts` and `research-model-output-store.test.ts` Worker fixtures.
These allocations do not qualify a provider, promote a route, or create spending authority.

The gateway runtime adapter and durable pre-invocation output binding remain ER-09 internal
composition in `cloudflare-research`. ER-16 supplies the existing gateway ports and codecs;
ER-27 owns the actual Worker gateway-runtime fixture and the existing model-handler/output fixtures.
Gateway credentials are explicit server-owned inputs, separate from control-plane API credentials.
Timeout/cancellation and output preparation must not permit a repeated uncertain model invocation.

The next W3 pricing prerequisite is immutable snapshot storage in `research-model-pricing-store.ts`.
ER-13 allocates `0038_research_model_pricing.sql`; ER-27 owns its actual D1 pricing-store fixture.
Admission binds exact route/provider/model, canonical snapshot bytes and trusted provenance; it does
not discover tariffs, grant spending approval, promote a route or infer a provider invoice. Historical
readback for known-result reconciliation remains distinct from fresh-call expiry/currentness checks.

The D1 model-attempt revalidator is an ER-09 IO adapter over existing W2, current-authority and
reservation rows. It requires a trusted spend-authorization reader with exact route/pricing binding;
access grants and opaque digest strings must not be promoted to financial permission. ER-27 owns
`research-model-attempt-revalidator.test.ts`. This handoff adds no tariff arithmetic, public DTO,
budget value or new SQL migration, and must not block settlement of an already known provider result.

## Read only

- `packages/research/src/ports.ts`
- `docs/implementation/runtime-contract.md`
- `docs/implementation/workflow-checkpoints.md`

## Architecture extracts

- §7.7–7.8

## Required implementation

### P1 storage handoff

`packages/cloudflare-research` also hosts the Cloudflare effects adapter for the
artifact compiler. ER-11 owns compilation semantics, ER-13 owns the additive D1
schema and atomic mutation primitives, and ER-14 supplies the existing immutable
R2/residency implementation. The integrator serializes the package dependency and
export changes; this adapter reuses those primitives rather than adding storage
code to the nearly full platform package. ER-27 owns its actual-binding fixture.

The first storage path records immutable `DRAFT` revisions and advances a
dedicated draft head. It cannot advance the published `artifact_head`, turn a
receipt reference into a publication decision, or map historical SQL `PUBLISHED`
rows to canonical `ACCEPTED`. P1, P3 publication and the complete owner user loop
remain separate acceptance requirements; no existing implementation state is
promoted by this ownership handoff.

### Workflow execution

- Implement idempotent stage machine from protocol/scope freeze through materialization.
- Each stage checks cancellation and budget, performs at most one expensive call, writes large output immediately, and returns handles.
- Default independent fan-out two, normal max four, nested fan-out zero.

## Acceptance

- Retrying a stage reuses its checkpoint/receipt.
- Cancellation persists terminal state and does not strengthen disposition.
- Workflow result stays under 64 KiB.

## Mandatory negative boundary

Inject a lost acknowledgement after model output persistence and prove retry does not execute/pay for the call twice.

## Handoff contract

Produce:
- Workflow stage executor
- checkpoint receipts
- cancellation/budget checks

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
