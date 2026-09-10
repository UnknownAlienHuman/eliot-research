# Durable research stage checkpoints — W2a + W2

`@eliotr/cloudflare-research` implements the D1/R2 checkpoint boundary, not the research product.
W2a proved single-stage D1/R2 checkpoints; W2 adds the monotone bounded stage executor and the
executable `ResearchWorkflow` binding over the same boundary. Owner HTTP composition can start runs
and read their durable status. Governed model/evidence handlers (W3/W4) and live qualification remain open.

The owner's current priority is composing the existing protocol, retrieval, evidence and answer
stages into the usable document-to-answer flow. New financial budgeting/accounting work is deferred
(2026-09-10); existing provider authorization, cancellation and duplicate-call guards are preserved.

## Configured exploratory evidence freeze

The explicit `research-handlers.exploratory.v3` factory now composes stage 10 (`RECONCILE`) and
stage 11 (`FREEZE_EVIDENCE`) over the actual committed stage-0 protocol and stage-5 retrieval
readers. The package composition checks the current W1 head and full run authority, and the app
adapter binds the retrieval readback to its exact committed attempt. Stage 10 persists the allowed
reference manifest through the existing D1/R2 store. Stage 11 resolves its exact evidence handles
again under current access and returns immutable freeze bytes to the W2 executor. Missing explicit
freeze configuration is refused; historical v1/v2 execution and replay remain unchanged.

The model-profile producer separates the stable server definition from its current scope/policy/
deployment binding. The definition contains the approved route, provenance, expiry and explicit
context bound; the binding is checked before and after awaited authority reads. Frozen material
includes the full protocol definition, exploratory lane and model definition with derived identities.
This composition currently accepts only the clean exploratory W1 state; unresolved lane obligations,
hypotheses and debt require their real resolution paths rather than an empty fabricated result.

Local evidence on 2026-09-10, Node 22.23.2: the actual Q1 import/projection → W2 stage 0 → stage 5 →
stage 10/11 case and exact replay passed at source `f351c33`. Its accompanying revoke case reached
the expected refusal but initially asserted the wrong error code. After that correction, its SQL
witness used the wrong column name; source `ad59069` corrected it and the changed revoke case
passed alone, proving no new manifest or stage-11 checkpoint after grant revocation. The unchanged
positive case was not rerun. The missing-v3-composition factory case passed alone at `d49f9d4`.
The profile-binding suite passed six cases at `f07a7be`, including scope-dependent bindings and
expiry during an awaited route read. Intermediate stages and route authority are controlled fixture
inputs. This evidence qualified configured local freeze composition. Public v3 selection and live
provider qualification remain open; the subsequent synthesis-to-draft proof is recorded below.

## Configured synthesis and persisted draft

The configured v3 factory now also selects real `SYNTHESIZE` and `MATERIALIZE` handlers. Synthesis
reads the committed stage-0/5/10/11 lineage under current authority, compiles the prompt from its
frozen evidence and reference manifest, and persists the gateway response through the existing
model-output store. Materialization rereads that committed response and the current stage-16
predecessor; it never treats a captured stage-12 context as current stage-17 authority.

The materializer resolves each cited handle again, verifies its exact source/excerpt/scope identity
and current grant, and derives section bytes, hashes, verification record and artifact manifest.
Display annotations such as neighboring-text references are not evidence identity. Its verification
record reports `AUTHORITATIVE_RESOLVED` source readback and `NOT_EXECUTED` semantic verification;
statement labels remain `UNRESOLVED` and the artifact remains `DRAFT`.

Only successful draft persistence emits the canonical `eliotr.research.materialize-result.v1` W2
output. The result reader checks the committed stage-17 receipt, its stage-12 output binding and the
exact owner-authorized draft manifest before exposing a draft reference. Low-level artifact storage
now lives in `packages/cloudflare-artifacts`; the research package keeps compatibility exports and
the governed materializer. D1/R2 ownership, schemas and publication heads are unchanged.

At integrated source `68af889` on Node 22.23.2, the new actual local Worker/D1/R2 case passed (one
selected, twelve unchanged cases skipped): imported Q1 source, committed freeze and synthesis,
factory-selected stage 17, draft/section readback, owner HTTP metadata and bytes, duplicate-free
replay with one provider invocation, and section-read denial after grant revocation. The gateway
response and intermediate stages 13–16 are controlled. This does not prove semantic verification,
public v3 production configuration, live model quality or NotebookLM comparison readiness.

The missing-dependency factory case also passed at `68af889`. At `f42e206`, the synthesis-only case
passed after correcting its assertion to decode the gateway request and nested prompt JSON: the
actual provider request contains the exact stage-5 handle and excerpt, and replay invokes the
provider only once. This assertion correction changed no production handler.

The model profile source now decodes an explicitly installed
`ELIOTR_MODEL_PROFILE_DEFINITION_JSON` value and delegates definition, deployment and provenance
validation to the existing binding producer. Missing configuration remains unavailable; no default
model or route is selected. Its eight focused binding cases passed at `c7e90d5`. App-owned Env and
production composition remain to be wired.

Private REPORT materialization has a separate admission contract. The server must supply an
installed versioned `owner_pwa` REPORT policy whose allowed use is exactly `research`, whose
disclosure ceiling does not exceed the current scope grant, and whose configured principal,
policy authority and expiry match the current run. Admission re-reads the current run, W1 head,
scope grant, policy/deployment generations and every frozen source revision before writing an
an immutable REPORT decision. This is a read-only preflight: it emits no decision, intent, or outbox
row. The artifact draft store supplies the final manifest digest and asks the server-only admission
port for a prepared statement; its existing final D1 batch owns the sole atomic write of the REPORT
decision together with the intent/outbox and draft rows. Replays reuse the persisted intent timestamp
and exact decision/input bytes. A grant or workflow receipt is lineage only and cannot serve as
`policy_decision_ref`; absent or stale REPORT policy fails closed.

`createResearchArtifactMetadataProducer` derives deterministic artifact/spec/section identities and
referenced-object bytes from the committed materialization context. It snapshots the server-owned
report policy and explicit REPORT intent, binds the canonical exploratory output contract and
retains UNRESOLVED labels. It does not issue a REPORT policy decision or manufacture an intent.

At `a2a542a`, the actual local Worker/D1/R2 stage-17 case passed with the shared strict verification
codec, metadata producer, exact section citations and owner HTTP citation readback. A mismatched
protocol family leaves the artifact row count unchanged, and revoked scope access denies both direct
and HTTP citation reads. The HTTP assertion was corrected to include its versioned protocol field;
production output was unchanged. Public v3 activation, provider configuration, REPORT admission and
semantic verification remain open.

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

## Server-owned exploratory protocol checkpoint

`createFreezeProtocolAndScopeStageHandler` in `packages/cloudflare-research/src/research-protocol-freeze.ts`
is the first-stage producer for the explicitly server-owned `eliotr.research.profile.corpus-exploratory-lookup:1`
definition. It is eligible only for an OPEN W1 ledger whose persisted lane is `exploratory`; a current
`confirmatory` or mixed ledger is refused rather than reinterpreted. The handler reads the existing W2
payload and W1 ledger through their trusted readers, checks the principal, scope, portfolio digest and
requested grade, and rechecks both navigation currentness and the W1 head before returning bytes.

The emitted `eliotr.research.protocol-scope.v1` checkpoint contains the strict
`InquiryProtocolProfile`, a canonical `CoverageDenominator`, and SHA-256 digests of both. The family
definition ref is fixed, while each compiled profile ref is derived from its canonical profile identity
(question, requested grade and trusted W1 model profile); the denominator ref is likewise derived from
its canonical scope membership identity. This keeps distinct requests from sharing an immutable ref. The profile is
lookup-only, `corpus_only`, exploratory, and carries the requested grade as a request attribute; it does
not claim that grade was achieved or make a confirmatory finding. Its server definitions state that source
fragments do not become independent sources, chronology uses frozen source revisions and capture times,
normalized text coordinates are the fidelity ceiling, one bounded corpus retrieval is the stop rule, and
the output is a draft answer with exact handles. `acquisition_method_generations` is empty because this
profile performs no external acquisition; participant generations are never relabeled as provider or
acquisition generations.

The denominator is a new canonical record in this stage output, revision `1`, whose eligible revisions,
scope reference and expiry are copied from the exact current `ScopeSnapshot`. It has no required source
classes or question branches and uses the server-defined exploratory membership observation as its
completeness-test reference. This is an exploratory scope observation, not an exhaustive-coverage claim.
`decodeProtocolScopeCheckpoint` checks the server-owned profile and canonical checkpoint shape.
Authoritative consumers use `readFreezeProtocolAndScopeCheckpoint`, which also verifies the persisted
attempt, receipt, immutable R2 bytes and current W1/scope authority. The bytes remain ordinary immutable
W2 `WORK_BUCKET` output with the existing 64 KiB checkpoint bound and D1 receipt; no new table or public
DTO is introduced.

The shared `research-stage-handlers.ts` factory selects this real stage for server-owned exploratory
runs in the HTTP service, Workflow binding and Durable Object. Existing
`research-handlers.exploratory.v1` runs retain their original stage-0-only behavior; new
`research-handlers.exploratory.v2` runs also execute real retrieval at stage 5. Legacy confirmatory
runs retain their existing deterministic path, and unsupported persisted generations are refused.
Migration `0040_research_policy_authority_scope.sql` permits independent scope policy authorities,
with one ACTIVE generation per authority. Retired rows remain retired and historical bindings remain
unchanged. The local session fixture passed 10 cases, including independent second-source execution,
retirement/revocation refusal, actual DO execution from unfinished W1 and duplicate-free replay.
The other 16 stages of v2 still use deterministic metadata handlers; this does not produce a research answer.

## Retrieval over the held protocol scope

`apps/eliotr-core/src/research-retrieve-branches.ts` implements `RETRIEVE_BRANCHES` at canonical stage
index 5. It reads the historical stage-0 checkpoint independently of the current `PLAN` output; W2 still
checks the current predecessor manifest and monotone stage order. Workflow objects come from
`WORK_BUCKET`, while exact admitted source bytes come from `EVIDENCE_BUCKET`.

The handler loads the original persisted scope with `loadHeldResearchScope` and calls
`retrieveWithHeldScope` using the server-selected retrieval profile. It creates no replacement scope or
read grant. Its immutable output contains the EvidencePack, trace, coverage claim and protocol/denominator
digests for subsequent stages; it does not produce an answer or an AllowedReferenceManifest.

The local D1/Search/R2 fixture walks stages 0 through 5, resolves an actual indexed Q1 excerpt, checks
stable scope/grant identities and duplicate-free replay, and refuses a revoked grant. The shared
HTTP/Workflow/DO factory now composes this handler for v2 using the same persisted retrieval profile.
The actual HTTP source-to-retrieval case passed with a requested limit of one, exact R2 excerpt,
stored stage-5 output, duplicate-free replay and HTTP 409 ORIENTATION_IDEMPOTENCY_CONFLICT when the
same request key changes its limit. Evidence freeze, synthesis and live deployment remain open.

`readRetrieveBranchesCheckpoint` reads the committed stage-5 receipt and immutable output, verifies
strict canonical bytes, and binds the result to stage 0, the held scope, current authority and persisted
retrieval result/trace rows. Three local Worker cases passed, including exact readback/replay and
refusal of a substituted operation or corrupted R2 output. Subsequent stages must still resolve exact
evidence before treating it as answer support; the reader does not mint a new evidence authority.

The shared retrieval codec and existing `createD1RetrievalResultStore.load` now own strict result
decoding, result/trace digests and scope/handle-reference linkage. The stage reader reuses that store
and `createD1ScopeProfilePort.requireBinding`; it no longer duplicates their SQL. The changed
persistence fixture passed seven cases and the actual Worker stage-reader fixture passed three.

`WorkflowCheckpointStore.readCommittedStageRequest` now supplies the shared strict request readback
for stages 0 and 5. The stage-0 authoritative reader binds its checkpoint to the receipt's actual
attempt; the app no longer reads and decodes the same R2 object twice. The changed expected-attempt
refusal and HTTP v2 replay cases passed together at `aaa13fa` (two selected cases, thirteen skipped).
Earlier unchanged reader cases remain retained evidence, not a claim that the whole suite was rerun.

## Owner run-status readback

`GET /api/v1/research/run/:workflow_id` reads the existing owner-bound W2 run without advancing it.
The versioned response separates `ACTIVE`, `CANCELLED` and `ENGINE_COMPLETED` from
`answer.availability`. Historical v1/v2 runs return `unavailable`; a configured v3 run can return
`draft` only after committed MATERIALIZE and artifact readback. The response includes the investigation
revision and next stage index, with a cancellation receipt only for a cancelled run. Engine completion
alone never supplies an artifact reference or a research completion disposition.

The reader checks the persisted run/current view, held scope and current owner authority before and
after readback. Engine completion also requires the exact committed final request and checkpoint
receipt. Missing and foreign runs share the same 404 response; services are refused, stale authority
returns 409 and storage read failures return 503. Unknown query parameters are refused.
The focused local Worker run at `5f2645b` passed both run-status and held-scope fixtures (7 cases),
including read-only repeat access, final receipt validation, cancellation and revoked access.
The existing Astro Research card now offers explicit launch, manual refresh and recovery using a
known Run ID. Its strict decoder binds the returned handle and deployment, refuses inconsistent
execution state and requires persisted artifact identity for a draft. Private run state clears on authority/session loss,
workspace generation change and offline events; it is not saved in browser storage. The built-PWA
Chromium fixture at `6279b58` passed POST, ACTIVE/completed GET, known-ID recovery and explicit
offline clearing against a controlled HTTP backend. It does not prove live Access or a deployed Worker.
The draft consumer now reads owner-authorized metadata and opens stored section text manually. It
checks exact identity, length and SHA-256 of the received bytes, renders with `textContent`, and
suppresses late responses after scope/session changes. Four focused API cases and the PWA build
passed at source `682d615`; live source-to-answer browser acceptance remains open because public
run creation still selects v2.

The built-PWA Chromium fixture passed at `78aa52b` on Node 22.23.2. It retains the legacy selected-
source/unavailable path and checks draft metadata, manually opened exact section text, inert literal
markup, generation/session/offline clearing and suppression of a delayed private response. Its HTTP
backend is controlled; it is separate from the actual Worker/D1/R2 proof above.

`GET /api/v1/research/artifact/:ref/sections/:section_ref/citations` exposes only the selected section's
persisted handle references and excerpt hashes, with exact artifact/section/scope identity and
`semantic_verification: NOT_EXECUTED`. The reader reuses owner authorization and D1/R2 readback,
checks the stored verification record against section bytes and the allowed-reference manifest,
then rechecks current authority. These references are locators: opening their sources still requires
the normal current `research.verify` and `research.open` path.

At `6c2627a`, the Astro build and existing Chromium fixture passed with an explicit per-section
source action. The client binds the citations to the displayed section and verification receipt,
then opens the selected handle through the existing evidence rail and checks its excerpt hash.
Readable numbered sections replace opaque IDs in headings; identifiers remain in expandable
details. Draft claims are explicitly unchecked. The controlled-backend browser proof retains the
legacy unavailable flow, literal section rendering, private-state clearing and late-response checks;
it is not a live-provider or Cloudflare deployment receipt.

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
residency checks. The shared factory writes the real protocol checkpoint for its exploratory generation;
remaining deterministic stages write small JSON metadata payloads and still need governed model/evidence
handlers. `ENGINE_COMPLETED` remains engine state, never a
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
The store binds residency to the held scope and principal. Before persistence and after readback,
manifest permissions must be a subset of the current grant, disclosure must match, and expiry must
remain within both scope and grant validity. The two actual D1/R2 cases passed at source `715598b`
on Node 22.23.2, including refusal of a foreign residency and a grant restriction before persistence,
with no manifest row written for the refused operation.
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
corrupt R2 bytes is refused without repair. The governed model handler now requires this preparation
after durable STARTED and before invoking the provider. It rechecks cancellation, expiry and currentness
around preparation; definite preparation failures receive a durable FAILED disposition. Existing
attempts are reconciled before fresh request preparation, so UNKNOWN and terminal replay cannot mint
a new quote or repeat provider work.

`createResearchModelGatewayRuntime` provides explicit server-held gateway credentials and an
endpoint-bound POST transport. Its single invocation deadline covers pending headers and bounded
response-body consumption; parent cancellation and late responses are reconciled without retry.
Successful response bytes are retained after the request completes even if the parent later cancels.
It does not discover credentials from ambient provider settings or authorize spending. The app-level
ResearchWorkflow still needs trusted preparation, current pricing and consent authority before using
this runtime in its model stages.

`createResearchModelStageHandler` composes the D1 attempt, deployment and fingerprint stores, the R2
output store and mandatory preparation hook, the prompt compiler and the gateway adapter. Gateway
credentials and transport are initialized only when a new model call executes, with that invocation's
cancellation signal. Exact successful recovery and UNKNOWN replay need no fresh gateway credentials,
prompt preparation or pricing call. Deployment resolution defaults to PRODUCTION and rejects
fixture-only qualifications. The factory now composes the actual D1 currentness revalidator with a
required trusted spend-authorization reader. Each invocation retains the immutable approved deployment;
the gateway uses that configuration without another registry read after the final D1 guard. Trusted
request preparation, spending authorization and pricing remain required inputs; this factory does not
produce owner consent or replace the deterministic app Workflow stages.

`createD1ResearchModelPricingSnapshotStore` stores immutable canonical pricing observations in
`0038_research_model_pricing.sql`, bound to an exact snapshot reference, route/version, provider and
model. It admits only explicitly declared token rates, retained as decimal text with effective/expiry
dates and trusted provenance references. Independent readback checks columns, bytes and SHA-256;
lost insert acknowledgements reconcile only against the same contents. Historical reads remain
available after expiry. This adapter performs no price arithmetic or current-call expiry decision;
an approval-reference string alone is not verified spending consent or a provider invoice.

`createD1ResearchModelAttemptRevalidator` checks the actual STARTED W2/W3 records, current
scope/grant/policy/deployment, exact persisted request and reservation, and unexpired authorization.
The same canonical request encoder is used for reservation and readback. Its required trusted spend
reader binds the operation, scope, quote, reservation and exact expected model deployment. External
spend and route reads precede a final D1 readback; the final clock is sampled after those reads, with
no later external reader await. Known provider result settlement remains separate from fresh-call
authorization. Its approved deployment now reaches the composed gateway adapter. The production spend
reader and app Workflow wiring remain open. This is a local configuration pin, not proof of a remote
route version: the current transport selects a dynamic-route alias and observes provider/model headers.
See Cloudflare's [dynamic-route usage](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/)
(updated 2026-08-07; checked 2026-09-10). Live route qualification remains a separate requirement.

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

The mandatory output-preparation update passed thirteen focused actual local Worker/D1/R2 handler and
output-store cases on 2026-09-10, including preparation ordering, definite failure, cancellation,
expiry, cancellation during revalidation, UNKNOWN replay and exact saved output. Six separate local
Worker transport cases passed with controlled fetch/Response streams: explicit credentials and
destination, cancellation before fetch, pending-header and body cancellation, bounded response size,
and completed-byte retention. These cases do not constitute a provider call or live qualification.

The composed stage-handler suite passed four actual local Worker/D1/R2 cases on 2026-09-10: durable
success and exact replay; recovery with unusable current credentials; UNKNOWN replay after one
controlled provider attempt; and refusal of the registered FIXTURE route under the production default
with zero provider calls. It uses the real prompt compiler with a controlled manifest-service result,
controlled preparation/pricing, and injected fetch. Manifest persistence has its separate storage
acceptance above; production quote/consent and live provider behavior are not proved by this suite.

The pricing store passed six actual local Worker/D1 cases on 2026-09-10: canonical write/read/replay,
changed-content refusal, unsupported basis/malformed decimal/extra identity fields, corrupt stored
bytes, committed insert with lost acknowledgement and one-row reconciliation, and historical read
after expiry. Tariffs in this fixture are controlled test values. Budget pools, owner consent, fresh-call
pricing checks and accounting remain separate production requirements.

The model-attempt revalidator passed eleven actual local Worker/D1 cases on 2026-09-10 over
persisted STARTED W2/W3 attempts: current authority, revoked grant, retired policy/deployment, route
rotation, expired budget, missing or mismatched spend authorization, changed prepared request, and
revocation/expiry during awaited readers. The positive case was then strengthened and passed alone
with an exact one-route-read assertion, excluding the former late second read. Spend/route readers
and the opaque currentness digest are controlled fixture inputs; provider invocation, production
spending authority and app-stage composition are not qualified by these tests.

The stage-handler suite subsequently passed eight actual local Worker/D1/R2 cases on 2026-09-10
using real STARTED W2 records and the directly composed D1 revalidator. It covers immutable output
and fingerprint readback, exact terminal replay with unusable current credentials, UNKNOWN replay
without another provider attempt, fixture-only production denial, approved deployment propagation,
registry rotation and missing/malformed spend approval. Pre-provider denials persist the existing
CANCELLED attempt/operation receipt and SETTLED reservation lifecycle with zero transport calls.
The LIVE qualification rows, spend reader, pricing, manifest-service result and fetch response are
controlled test inputs; no live provider or remote route-version evidence is claimed.

The earlier focused local D1/R2 model-attempt suites passed fourteen cases on 2026-09-10: eight storage
cases and six handler cases. The composed recovery case uses the production model handler and
Workflow executor, loses the acknowledgement after model settlement but before the Workflow output
record, then resumes from the stored result. The controlled model route is invoked exactly once;
the resumed checkpoint contains the exact saved bytes. This qualifies local recovery behavior,
not live provider execution or the complete W3 production composition.

The native Worker AI Gateway transport uses the installed `AI.gateway("eliotr-reasoning")` binding
for the existing dynamic route. It checks the binding's gateway URL against the configured account,
retains timeout/cancellation, bounded output and single-attempt headers, and requires no fabricated
gateway token. The explicit HTTP-token transport remains available with the same execution contract.
The model-profile producer can now re-read the persisted current workflow/ledger and navigation
authority before and after profile selection. Missing installed model definitions still refuse calls.

At `ca673de`, eight local transport cases and the actual source/freeze/synthesis/stage-17 draft case
passed together; the existing fourteen gateway execution cases also passed. The integrated case uses
the native binding interface with controlled response bytes and proves draft/citation readback,
single-call replay and revoked-read refusal. Stages 13–16 are still controlled in that result, and
the ordinary public run remains exploratory.v2. This is local composition evidence, not a live
provider call, remote gateway provision, semantic verification or deployment qualification.
