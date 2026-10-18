# Ordinary answer: direct execution and compact report

Checked 2026-10-18 against Eliot source at `3dd3a028`. This is the implementation contract for
**Answer from sources**. It defines no new wire version, generic engine or compatibility family.
[The manifesto](../architecture/ELIOT_RESEARCH.md) owns purpose;
[the plan](backend-entrypoints.md) owns sequencing;
[source lifecycle](source-lifecycle.md) owns source revisions and citations;
[runtime notes](runtime-contract.md) own storage/effect boundaries.

## Product result

For V5 `method: "lookup"`:

```text
admit exact request and source revisions
→ prepare context once
→ one streamed model attempt
→ retain completed public Markdown once
→ save one compact report revision
→ reopen the same report and exact citations
```

The run continues when the browser disconnects. Reconnect never starts another provider call. Ordinary lookup does
not construct the deep-research graph and does not require an inquiry protocol, planning manifest, obligation
ledger, evidence freeze, qualification renewal, coverage ceremony or claim-audit pass.

`method: "evidence_review"` selects [explicit deep research](deep-research.md). Deep and ordinary work share source
reads, model transport, compact citations and the final report writer—not the old stage graph.

## What the current code actually does

| Current source | Observed behavior | Selected replacement |
|---|---|---|
| `apps/eliotr-web/src/app/ResearchPanel.tsx` | UI already distinguishes `lookup` and `evidence_review`. | Preserve that product choice; no new mode selector. |
| owner client `research/runs/authority.ts` | V5 carries `method`, while status requires `next_stage_index=18`. | Keep V5; use run kind, product phase and report ref. |
| Core `research-run-service.ts` | `lookup` becomes an installed inquiry protocol, planning sources/manifest, obligations and branch-handler generation. | Persist `ordinary` directly and skip that construction. |
| Core `research-workflow.ts` | Every run calls `executeResearchWorkflowApplication`. | Dispatch ordinary/deep before old handler/checkpoint assembly. |
| `research-workflow-application.ts` and `WorkflowCheckpointStore` | Investigation/scope/qualification replay and 18 stage attempts/checkpoints. | No new ordinary caller. Drain old admitted runs, then delete ordinary use. |
| `research-model-prompt.ts` | Nested control/evidence JSON and `stream: false`. | Small prompt/request builder over admitted blocks and short labels. |
| `model-gateway-execution.ts` and response decoders | Buffer and persist complete provider JSON, then decode it again downstream. | Normalize one provider stream and retain public Markdown once. |
| `publication.ts`, `research-artifact-draft.ts`, `artifact-draft*.ts` | Reports require ArtifactSpec, EvidenceFreeze, dependency/allowed-reference manifests, section ledgers and verification receipts. | Replace report use with one report revision and one R2 object. |
| migration `0041_research_report_admission.sql` | Report save is a policy-decision/outbox surface fenced to active stage 17. | Direct report commit after completed output; no dummy stage/admission. |
| `artifact-draft-read-service.ts` and client `evidence/report/manifest.ts` | Reconstruct historical scope/authorization and decode three reauthorization protocols. | Direct report authorization/read; freshness and citation opening separate. |
| `research-session.ts` | Only successful snapshot RPC replies can be sent. | Add one bounded typed phase/text channel; no transcript store. |

## Admission and dispatch

Keep `/api/v1/research/run`, the V5 body, idempotency key, operation ID, model pin, budget and cancellation identity.
Do not add V6 to distinguish implementations.

At ingress:

1. parse V5 and preserve `method`;
2. map `lookup → ordinary`, `evidence_review → deep`;
3. capture the exact source revision set, question, output language, context mode and selected model/transport;
4. derive one run/provider-attempt identity and persist the bounded request once;
5. create the existing Workflow instance;
6. for ordinary work, do not compile `INSTALLED_INQUIRY_PROTOCOL_REFS.lookup`, planning sources/manifest,
   inquiry obligations, qualification renewal or branch handler generation.

Store one `run_kind` in the existing canonical run/request state or Workflow params. `handler_generation` remains
temporary legacy execution metadata, not the permanent product mode selector.

In `apps/eliotr-core/src/research-workflow.ts`, dispatch before `executeResearchWorkflowApplication`:

- `ordinary` → one cohesive ordinary function in `packages/cloudflare-research-runtime/`;
- `deep` → the bounded deep loop;
- old admitted generations → old settlement code only while real attempts remain.

A completed old report is read directly; reopening it never loads the old executor.

## Four durable responsibilities

The ordinary Workflow needs four responsibilities, not eighteen stages:

1. **Prepare** — resolve exact admitted revisions; read whole material when it fits, otherwise one scoped native
   retrieval and exact bounded reads; build context once.
2. **Generate** — execute one provider attempt, stream public Markdown, require a valid terminal event and retain the
   completed public output once.
3. **Save** — resolve supplied labels, write one report object and commit one report revision/head/result.
4. **Finish** — expose the report ref and terminal run state.

They may be four durable steps or fewer when one atomic owner already combines work. Do not create a configurable
step graph. Generate and save are separate retry units: a save failure must not repeat a paid model attempt.

## Prepare context once

The browser sends question, selected source/derived-output references and an optional follow-up reference. It never
assembles source bodies and sends them back to the server.

The server:

- distinguishes omitted selection from an explicitly empty selection;
- resolves authorized exact revisions once;
- keeps source identity/range beside each admitted block;
- reserves answer capacity before filling input;
- reads selected sources directly when they fit;
- otherwise performs one scoped native search and exact bounded reads;
- records omissions; `FULL` never silently drops a selected source.

Follow-up context is a bounded relation to previous question/result, not a token transcript service. Native query
rewriting may run once when retrieval genuinely needs disambiguation. Do not combine it with another local rewrite
or planner.

Narrow `packages/policy/src/context-compiler.ts` to packing typed admitted blocks. Remove expiring manifests,
EvidenceHandle parsing/hashing, selection receipts and repeated serialization of the growing request. Pre-encode
stable blocks, maintain separate byte/token bounds and validate the final request. A documented conservative token
estimate is acceptable when the selected tokenizer is unavailable; it is not an exact count.

## One normalized model stream

Ordinary output is Markdown with server-issued passage labels. It is not escaped Markdown inside JSON and not the
deep `material_claims` schema.

Add one normalized streaming surface under `packages/cloudflare-model-transport/`:

- public text delta;
- final usage and observed provider/model identity;
- terminal reason;
- safe transport failure.

Implement the selected APIs actually used (`chat completions`, `responses`, `messages` or a selected custom API).
Do not build adapters for hypothetical providers or force all models through a compatibility endpoint that loses a
required capability.

Preserve metadata-only Gateway logging, cache bypass and `cf-aig-max-attempts: 1`. A paid stream with uncertain
outcome remains one application attempt. Raw provider frames, prompts and reasoning never reach the browser/report.

The decoder must bound frame/aggregate bytes, decode UTF-8 incrementally, keep private reasoning private, verify
selected provider/model identity, retain final usage and require a valid terminal event. HTTP 200 or EOF alone is not
completion. A provider without streaming capability reports that honestly; do not replay a buffered response as a
fake stream or silently choose another paid model.

The existing buffered path may remain for a real probe/non-stream caller. Move ordinary callers, then delete raw
provider-response persistence and decoders that have no remaining caller.

## Retain completed public output

Aggregate only public Markdown within the configured bound. After a valid terminal event, create one immutable
public-output object and keep its locator, hash, size, usage and model identity. Do not persist every token/provider
event or repeat the body in Workflow state.

A generation failure before recoverable completed output is failed/unknown and is not automatically redispatched.
A bounded terminal partial output may be retained for honest cancellation/error display, but it is not a completed
report.

## Replace the artifact proof bundle with one report revision

The current report stack is not a generic writer worth preserving:

- `ArtifactRevisionSchema` requires `spec_ref`, `evidence_freeze_ref`, dependency manifest and section array;
- each section requires an evidence ledger and verification receipt;
- `artifact_draft_reservation/head/binding/object` plan and receipt every object;
- `research_report_admission` duplicates policy/scope/source facts and requires stage 17;
- readback replays historical scope/grant lineage and exposes authorization receipts to the client.

Do not fabricate these inputs for ordinary or deep reports.

Add a direct report store inside the existing artifacts package, for example
`packages/cloudflare-artifacts/src/report-store.ts`, with a current contract in
`packages/contracts/src/report.ts`. Use the next D1 migration to create only:

```text
report
  report_id, owner_principal_ref, head_revision, deleted_at, created_at, updated_at

report_revision
  report_id, revision, run_id, title, summary, language,
  object_key, object_sha256, object_size,
  source_revision_refs_json, created_at
```

The immutable R2 report object contains:

- Markdown;
- compact citation refs (`source_revision_ref`, representation, byte range, optional display anchor);
- bounded generation metadata needed for inspection (provider/model/usage/finished time).

Use one object, not manifest + per-section body + dependency manifest + verification + export objects. Markdown
headings provide sections in the view. Export renders the same Markdown. Project attribution is the admitted run's
positive project relation, not a new report graph.

### Save algorithm

1. read retained completed public output and the server label map;
2. resolve only issued unambiguous labels; leave unknown labels unresolved;
3. encode the one bounded report object and its hash;
4. conditionally create the deterministic R2 key;
5. in one D1 transaction insert immutable `report_revision`, conditionally advance `report.head_revision` and
   attach the exact report ref to the originating run;
6. read back revision/head/run result before marking the run completed.

D1 cannot transact with R2. If D1 fails after the object write, the object is unreferenced and may be reused by the
same deterministic retry or cleaned later. Do not add two-phase commit, operation receipts, residency records or an
outbox around an internal same-Worker save.

A save retry starts from the retained public-output locator. It never calls the model. A head conflict is explicit;
a zero-row expected-head update is not success.

## Direct report read

Change Core report routes, `ReportPanel.tsx` and the owner client together.

Owner read:

1. authenticate current owner;
2. select exact non-deleted report revision owned by them;
3. read exact R2 object and verify stored hash/size;
4. return report ref, title, summary, language, Markdown and compact citations;
5. calculate source freshness separately and optionally.

A connected client must prove a current explicit report/operation/project grant. Neither owner nor client read
reconstructs the producing Workflow, stage 17, original credential/deployment generation or policy lease.
A newer source head makes the report historical, not unauthorized. Actual report deletion/purge still denies it.

Remove `artifact-draft-reauthorization.v1/v2/v3`, authorization receipt/policy fields and duplicated artifact schemas
from the browser contract. Citation opening remains a separate source-revision/range operation.

## Presentation and reconnect

Use [the ResearchSession delivery note](research-session-projection-protocol.md). Workflow owns execution;
ResearchSession relays bounded public phase/text batches.

- disconnect does not cancel provider/Workflow;
- slow clients cannot block output retention or save;
- no per-token D1/R2 journal or permanent transcript;
- a monotonic offset detects a presentation gap but is not an authority receipt;
- reconnect reads canonical status/report and may receive only new deltas with an explicit gap;
- once saved, provisional text is replaced by the canonical report.

SurfSense's current local chat is useful only for execution/presentation separation, disconnect-safe finalization and
batching. Do not copy its transcript database, local model/index stack or in-memory replay list of every frame.

## Status and history

Change together:

- `packages/interfaces/src/semantic-api.ts`;
- `research-session-status-application.ts`;
- owner-client run decoder;
- React query/presentation callers;
- then delete the duplicate PWA decoder.

Current status exposes the retired graph. Replace it with:

- `run_kind: ordinary | deep`;
- `phase: queued | preparing | generating | saving | completed | cancelled | failed`;
- safe failure/cancellation;
- report availability/reference.

Status reads the canonical run/result owner directly. It does not require stage 18, handler-generation membership or
historical executor reconstruction. History reads bounded D1 summary fields and never opens report R2 or calculates
freshness.

## Data conversion and deletion

Inventory deployed retained reports. Convert each real saved report once:

- preserve stable report ID/revision when practical;
- read the existing verified Markdown;
- convert EvidenceHandles to compact citation ranges;
- preserve run, title, language and creation time;
- write the one report object and new report/revision rows;
- verify hashes, counts and run/report associations.

Switch writer, status, history, report read, export and React callers. Then remove report use of:

- `ArtifactSpec`, `ArtifactRevision`, section contracts and `publication.ts` report schemas;
- EvidenceFreeze, AllowedReferenceManifest, EvidencePack, coverage/verification/residency objects;
- `artifact_draft_reservation/head/binding/object`;
- `research_report_admission` and stage-17 report fences;
- `research-artifact-draft.ts`, old materialize-result lineage and read-reauthorization modules;
- v1/v2/v3 client protocols, old PWA decoder and fixtures.

Do not keep a fallback reader after conversion. Shared source readers, actual erasure operations and still-used Wiki
behavior remain until their own callers move.

## Donor/platform decisions

- **WeKnora:** expected-version update and body-free revision history; reject blind auto-link/meta writes.
- **ThinkEx:** readable fallback is useful, but provider extraction and publication share one retryable Workflow step.
  Eliot separates paid generation and save.
- **SurfSense:** run outlives follower, finalization survives disconnect, adjacent deltas batch; reject transcript and
  replay machinery.
- **Cloudflare:** conditional R2 write + short D1 transaction + granular Workflow steps are sufficient. They do not
  provide exactly-once arbitrary provider effects or a cross-store transaction.

No donor code or dependency is imported.

## Completion

Complete when a real owner journey proves:

1. V5 `lookup` bypasses inquiry protocol/planning/branch handlers and the 18-stage executor.
2. One provider attempt emits progressive public text and retains one completed Markdown object.
3. Disconnect/reconnect does not duplicate the provider call.
4. Save failure retries from retained output.
5. One report object/revision opens directly with compact citations.
6. Status/history contain no stage-18, handler-generation or report-admission dependency.
7. Retained reports are converted and the superseded ordinary/report proof cohort is removed.

During implementation run scoped TypeScript compile/lint. Product tests and acceptance follow assembly.
Cloudflare references checked 2026-10-18:
[Workflow retry rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[R2 conditional writes](https://developers.cloudflare.com/r2/reference/consistency/),
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) and
[Workers streams](https://developers.cloudflare.com/workers/runtime-apis/streams/).
