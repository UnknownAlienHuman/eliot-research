# Durable research stage checkpoints — W2a + W2

`@eliotr/cloudflare-research` implements the D1/R2 checkpoint boundary, not the research product.
W2a proved single-stage D1/R2 checkpoints; W2 adds the monotone bounded stage executor and the
executable `ResearchWorkflow` binding over the same boundary. No new Worker route, model, endpoint
or deployment is enabled. Governed model/evidence handlers (W3/W4) and live qualification remain open.

## Execution

`createWorkflowCheckpointExecutor(CORE_DB, WORK_BUCKET, ports)` exposes `execute(request, principal,
handler)` and `cancel(operationId, principal)`. The request is strictly versioned as
`eliotr.workflow-stage.v1`; it pins the operation, Investigation revision, idempotency key, handler
generation and immutable input manifest with all six residency domains. The principal comes from
verified server authentication, never from the request body.

The first input must equal the W1 portfolio handle and input digest. Later inputs must equal the exact
preceding checkpoint output. All 18 canonical stages execute monotonically; a skipped stage, changed
input, stale revision, foreign credential or changed handler generation fails closed. The current grant must explicitly permit
`research`; purpose withdrawal is also checked inside the checkpoint transaction.

```text
current W1/scope/grant/policy/deployment/purge + residency + bounded budget check
→ durable unique attempt → one handler invocation → durable output intent
→ immutable conditional R2 PUT → checksum/length/residency/byte readback
→ one D1 batch: W1 CHECKPOINT command + stage receipt + notification outbox
→ exact persisted receipt and output readback → compact handle-only step result
```

The handler receives a detached request, the trusted principal snapshot, bounded input bytes, attempt
identity and pinned budget receipt.
The executor invokes it at most once per stage. W3 must supply a governed handler with at most one
expensive provider boundary; the executor does not inspect arbitrary handler internals or qualify billing.
Execution here is sequential. The existing 2/4/0 branch fan-out policy is unchanged; the branch scheduler
and exhaustive-job composition remain follow-up work beyond W2.

## W2 monotone bounded executor

`createMonotoneStageExecutor(CORE_DB, WORK_BUCKET, ports)` reuses `createWorkflowCheckpointExecutor`
for all 18 canonical stages in strict order, with no parallel stack. It builds each `StageRequest`
from the previous receipt (`investigation_ref` + `output_manifest`), calls the single-stage boundary,
and asserts every step receipt is handle-only JSON ≤64 KiB with no `completion_disposition` and no
source/model text. Restart with the same `operation_id`/`idempotency_key`/`handler_generation`
replays committed receipts without another handler invocation; concurrent replay elects one durable
effect; stale CAS, purge/revoke/expiry and cancel fail closed with byte-identical W1 state.

`ResearchWorkflow` (`apps/eliotr-core/src/research-workflow.ts`) is the executable Worker binding:
one Workflow instance owns one operation, each stage runs in `step.do("w2-stage-NN-NAME")` returning
only the checkpoint receipt (≤64 KiB), with D1-backed idempotent budget ports and principal-bound
residency checks. The deterministic stage handler writes only a small JSON handle payload; W3/W4 must
replace it with governed model/evidence handlers. `ENGINE_COMPLETED` remains engine state, never a
research disposition. Pure monotone order/bound helpers live in `packages/research/src/workflow.ts`.

## Failure and recovery

A lost reservation ACK is reconciled against the exact attempt nonce before invoking the handler.
A lost R2/output-intent/checkpoint ACK is reconciled from persisted identity and exact bytes. `STARTED`
without a known durable output remains `WORKFLOW_EFFECT_UNCERTAIN`; it never invokes the handler again.

The optional trusted `recoverStartedAttempt` port may read an already persisted model result and return
its bounded bytes. It receives the exact stage request and digest, attempt, principal and generations,
output identity and pinned budget. The executor rechecks current authority, cancellation and budget,
then records the output intent and performs the normal immutable R2 write/readback before checkpointing.
This also covers an `OUTPUT_RECORDED` attempt whose R2 object is missing before its checkpoint: recovered
bytes must match the existing output intent's digest, length and residency. A corrupt existing object is
refused. Recovery cannot invoke a model or create a new spending reservation.

After a stage receipt has committed, replay remains read-only: a missing or corrupted final output is
not reconstructed through this port. A null or failed recovery remains uncertain. Deleting an uncertain
attempt to permit a retry is forbidden. This extension is the W3 recovery prerequisite; a trusted callback
and controlled fixture alone do not qualify model settlement or complete the governed model handler.

Cancellation is durable and monotone. Transaction-time cancellation or authority withdrawal rolls back
the W1 advance, stage receipt and outbox together. Late/stale output cannot become an accepted checkpoint.
Replay rechecks access and residency but does not acquire a fresh spending reservation for completed work.

`authorizeResidency` and `checkBudget` are required trusted ports. Budget checks must be idempotent and
return the same reservation binding, with a maximum ten-minute grant. Expiry or changed authorization
stops continuation; renewal/uncertain-provider settlement requires W3, not silent replacement of a grant.
The caller must not expose these ports as user-supplied callbacks.

## W3 model-attempt prerequisite

`createModelAttemptStore` persists a server-provided cost quote and reservation before starting a
model attempt. Migration `0033_research_model_attempts.sql` binds the operation, request digest,
principal, authority generations and exact W2 stage attempt. A persisted `STARTED` attempt reads as
`UNKNOWN`; reconciliation reads existing state and cannot authorize another provider invocation.
Terminal receipt and output bindings are immutable, and repeated settlement must match them exactly.

`createGovernedModelAttemptHandler` derives a separate model identity for each stage and authenticated
principal/generation combination. Its trusted preparation and revalidation ports supply current policy,
scope and pricing authority. It rechecks cancellation and expiry before the paid boundary. Known
provider results are settled durably even if later authorization prevents Workflow publication. Model
objects use `model-output/...`; the executor separately owns `workflow/...` checkpoint objects.

The W2 execution-grant receipt and W3 model cost reservation have separate identities. The internal
`workflow_budget_receipt_ref` binds model preparation, reservation and readback to the exact persisted
W2 stage attempt, request digest, principal and authority generations. The store checks that binding
before inserting the model intent or reservation. It does not treat the W2 receipt as a price quote,
spending consent or replacement for the model reservation.

`loadHeldResearchScope` loads the exact scope pinned by `research_workflow_current` and rechecks its
owner and currentness. `retrieveWithHeldScope` shares the public query's resolver, lanes and durable
trace/result stores. It validates the existing scope and grant before writing an immutable server-selected
retrieval-profile binding, enforces the profile bounds, and never creates a replacement scope or grant.
The public query retains its replay-before-freeze ordering. These internal preparation paths do not yet
connect the production research stages to model execution.

The D1 dynamic-route registry in `cloudflare-research` stores immutable canonical candidates and promotes an active route
through an expected-version compare-and-swap. The call-time deployment resolver reads that same
active state. Production promotion and resolution require unexpired LIVE qualification; controlled
fixtures must select the explicit server-owned TEST mode. Migration
`0035_model_route_registry.sql` adds the candidate and active-generation tables while preserving the
existing `model_generation` contract. This adapter does not itself issue provider qualification or
connect the model gateway to the research stages.

These adapters do not supply production prices or grant spending authority. The existing
`ResearchWorkflow` composition still uses the deterministic handle-producing stage handler. Full W3
requires production wiring of the actual run's resolved EvidencePack, reference-manifest service and
prompt compiler, current route/pricing resolution, pre-call quote and budget/consent policy, and their production
composition. No live billing, model result, research completion or publication is qualified by this
prerequisite.

The reference-manifest service resolves each held evidence handle through the authoritative D1/R2
resolver, compares the exact evidence and current scope/grant, and compiles an AllowedReferenceManifest
with the existing policy context compiler. It deduplicates source references while retaining distinct
handles from that source. Migration `0034_research_reference_manifests.sql` stores immutable scope,
owner, credential, pack, trace and stage bindings. WORK R2 stores bounded canonical manifest bytes;
readback independently checks residency, the canonical key, ETag, size, platform metadata, both content
and manifest digests, and scope/client/expiry coherence. Reads recheck current authority around R2 I/O.
Stage, pack, trace and route selection remain trusted production-composition inputs.

The model prompt adapter binds the call to the supplied deployment generations and persisted manifest,
serializes compiler-admitted evidence as quoted user data, and produces a bounded canonical request
body and digest. Trusted parameters are supplied by the server; the existing HTTP request adapter
enforces their digest against the selected deployment. This does not configure credentials, pricing,
consent or a live provider.

`createD1ModelGatewayFingerprintStore` records canonical observed route fingerprints in the immutable
`0036_research_model_fingerprints.sql` table. The reference contains the full canonical SHA-256;
independent readback verifies its route, bytes and digest. Latest observations are ordered by a
database-assigned sequence, so a reversed clock or replay of an older fingerprint cannot reorder
them. An insert whose acknowledgement is lost is accepted only after exact durable readback.
This history does not promote a route, change `model_generation`, qualify a provider or authorize spend.

`createResearchModelOutputStore` binds the logical model-output reference to the actual persisted
STARTED attempt, request, owner, W2 stage grant and scope before receiving provider bytes. Migration
`0037_research_model_outputs.sql` stores this preparation separately from the committed physical R2
receipt. Non-scope residency domains must be resolved by the trusted server policy/composition;
the bridge does not derive them from caller claims. The content digest and complete physical residency
key are computed from the bounded output after the call. Known output persistence has no new
cancellation or expiry gate; the governed handler separately controls publication after settlement.
Immutable R2 and D1 readback reconcile lost acknowledgements. A committed mapping with missing or
corrupt R2 bytes is refused without repair. Production composition must still place preparation after
durable STARTED and before invoking the provider.

## Bounds and proof ceiling

R2 input/output objects are capped at 8 MiB; larger artifacts must be represented by bounded manifests.
Reads check size before allocation and verify conditional object identity and the actual SHA-256 bytes.
Step receipts are strict JSON, capped at 64 KiB, and contain handles rather than source/model text.

`ENGINE_COMPLETED` means only that all engine stages checkpointed. It does not close the Investigation,
accept an obligation, create evidence assurance or return a research CompletionDisposition. W4 owns those
independent decisions. The checkpoint notification is only a locator, not publication evidence.

## Integration and migration

Migration `0020_research_workflow_checkpoints.sql` adds three metadata tables, a current-authority view and
transaction guards. Existing W1 commands/migrations and the public readiness generation are unchanged. No backfill or launch-hold
removal occurs. Do not roll back by deleting attempts; keep the public composition disabled during rollback.

Before live composition, implement W3 budget/provider settlement, W4 governed stage handlers,
`research.workflow.checkpoint.v1` outbox locator resolution/session delivery, and explicit retention/erasure
and backup/restore closure for the new metadata and Work objects. These are not qualified by this slice.
Queued checkpoint notifications must not be routed to an unrelated existing consumer.

Language owner: TypeScript Cloudflare I/O, SQL storage authority; deterministic migration target:
`eliotr-research-core` (transitional reference, not promoted Rust authority). Versioned fixtures live in
`infra/workflows/checkpoint-vectors.v1.json` and execute in the real local workerd D1/R2 suite
`apps/eliotr-core/test/research-workflow.test.ts`. Controlled handlers test effect counts, not live model
quality or provider settlement. W2 adds five monotone suites: 18-stage restart resume, duplicate/stale/
concurrent single-effect, revoke/cancel rollback, lost R2/checkpoint ACK reconciliation and executable
`step.do` binding readback. Live Cloudflare/provider qualification: `NOT_EXECUTED`.

`apps/eliotr-core/test/research-workflow-recovery.test.ts` adds four focused real local D1/R2 cases:
known durable result after a handler loses its acknowledgement, missing R2 output after the output
intent is recorded, unknown outcome without a second handler invocation, and refusal to overwrite a
corrupt existing object. The model result is controlled test data; these cases do not call or qualify a
live provider.

The held-scope suite passed four actual local Worker/D1/R2 cases on 2026-09-10. Its positive path
imports and projects a source, holds the W1 scope, then resolves FAST_SEARCH to exact stored excerpt
bytes and a matching evidence receipt. Replay creates no replacement scope or grant. Foreign and
revoked unbound scopes are rejected before retrieval-profile writes.

The reference-manifest suite passed two focused actual local Worker/D1/R2 cases on 2026-09-10:
two distinct same-source excerpts, exact manifest write/read/replay, no committed receipt after an R2
failure, and currentness rejection before a read and after an in-flight grant revocation. The prompt
adapter's two pure unit cases passed with a controlled manifest-service stub; those cases verify request
preparation, not storage or live model quality. Both suites retain explicit controlled stage/route inputs.

The fingerprint store passed four focused actual local Worker/D1 cases on 2026-09-10: canonical
receipt and immutable replay, sequence ordering with a reversed clock and route isolation, invalid
input and corrupt persisted bytes, and a committed insert whose acknowledgement is lost. The active
route registry remains unchanged. Production gateway composition and live qualification remain open.

The output store's actual local Worker/D1/R2 suite passed three cases on 2026-09-10, covering the
logical-to-physical binding, replay without another PUT, known-result settlement, lost D1 commit
acknowledgement, and refusal of missing or corrupt finalized objects without changing the receipt.
A subsequent focused run passed the strengthened cancellation/expiry case: cancellation or expiry is
injected after preparation and before the first R2 PUT, and the known bytes are still persisted and
replayed once. The two unchanged cases were not rerun. These controlled model results do not qualify
provider quality, authoritative prices, owner consent or live deployment.

The focused local D1/R2 model-attempt suites passed fourteen cases on 2026-09-10: eight storage
cases and six handler cases. The composed recovery case uses the production model handler and
Workflow executor, loses the acknowledgement after model settlement but before the Workflow output
record, then resumes from the stored result. The controlled model route is invoked exactly once;
the resumed checkpoint contains the exact saved bytes. This qualifies local recovery behavior,
not live provider execution or the complete W3 production composition.
