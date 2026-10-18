# Ordinary answer: direct cutover

Checked 2026-10-18 against Eliot source at `8e245843`. This is the implementation contract for
**Answer from sources**. It does not define a new wire version or another research engine.
[The product manifesto](../architecture/ELIOT_RESEARCH.md) owns purpose;
[the implementation plan](backend-entrypoints.md) owns sequencing;
[source lifecycle](source-lifecycle.md) owns revisions and citations.

## Product result

For `method: "lookup"`:

```text
admit exact request and source revisions
  → prepare context once
  → one streamed model call
  → retain completed public Markdown once
  → save report and compact citations
  → reopen the same result
```

The run continues when the browser disconnects. Reconnect never starts another provider call.
Ordinary lookup does not construct the deep-research graph and does not require an inquiry protocol,
planning manifest, obligation ledger, evidence freeze, qualification renewal or claim-audit pass.

`method: "evidence_review"` selects explicit deep research and uses
[the bounded deep loop](deep-research.md). Evidence grade is a requested quality/depth characteristic;
it must not be reused as hidden dispatch logic.

## What the current code actually does

| Current source | Observed behavior | Required replacement |
|---|---|---|
| `apps/eliotr-web/src/app/ResearchPanel.tsx` | UI already distinguishes **Answer from sources** (`lookup`) and **Research** (`evidence_review`). | Preserve this explicit product choice. Do not add another mode selector. |
| `packages/owner-api-client/src/research/runs/authority.ts` | V5 carries `method`, but status still requires `next_stage_index` and hard-codes completion at stage 18. | Keep the V5 request shape; replace stage-based status with behavior-based phase/result fields. |
| `apps/eliotr-core/src/research-run-service.ts` | V5 `lookup` is converted to the installed lookup inquiry protocol. Admission then creates planning sources, a planning manifest, ledger obligations and a branch handler generation. The method is not retained as a direct execution kind. | Persist one small `run_kind` (`ordinary` or `deep`) with the existing run/request. `lookup` bypasses protocol compilation and branch-generation selection. |
| `apps/eliotr-core/src/research-workflow.ts` | Every run enters `executeResearchWorkflowApplication`. | Read `run_kind` before old handler assembly. Call one ordinary application function or the explicit deep loop. Legacy execution is only for already-admitted old runs while they settle. |
| `packages/cloudflare-research-runtime/src/research-workflow-application.ts` | Replays investigation, scope, qualification and generation-dependent handler/checkpoint machinery. | Do not call it for new ordinary runs. Remove its ordinary callers after cutover rather than adding disabled stages. |
| `packages/cloudflare-model-control/src/research-model-prompt.ts` | Builds canonical nested JSON, sends route/manifest/selection metadata to the model and sets `stream: false`. | Factor a small prompt/request builder from the selected model transport. The model sees stable instructions, admitted excerpts and short labels—not control receipts. |
| `packages/cloudflare-model-transport/src/model-gateway-execution.ts` | Buffers a complete provider JSON response, stores those raw response bytes, and downstream code decodes them again. | Add one selected streaming execution path that yields normalized public deltas, final usage/identity and one retained public-output locator. |
| `packages/cloudflare-research/src/research-artifact-draft.ts` | Materialization is coupled to EvidenceFreeze, AllowedReferenceManifest, EvidenceHandle packs, deep claim schemas and verification receipts. | Ordinary materialization consumes retained Markdown plus compact citations from the source lifecycle. Reuse the artifact body/head writer, not these preconditions. |
| `apps/eliotr-core/src/research-session.ts` | The send guard allows only snapshot RPC responses; arbitrary stream frames are rejected. | Add one bounded typed presentation channel for phase and public text. ResearchSession remains neither executor nor result store. |
| `packages/cloudflare-research-runtime/src/research-session-status-application.ts` | Exposes a result only for enumerated semantic handler generations. | Read the existing run's stored result reference directly; do not use handler-generation membership as result authority. |

## Admission and dispatch

Keep the existing `/api/v1/research/run` endpoint, idempotency key, operation ID, model pin, budget,
cancellation and report identity. Do not introduce V6 merely to distinguish implementations.

At ingress:

1. Parse the current V5 body and preserve its `method`.
2. Map `lookup → ordinary`, `evidence_review → deep`.
3. Resolve and store the exact admitted source revision set, question, output language, selected model/transport,
   context choice and original paid-attempt identity.
4. Persist that request once using the existing run/input owner and create the existing Workflow instance.
5. Do not compile `INSTALLED_INQUIRY_PROTOCOL_REFS.lookup`, `ResearchPlanningManifest`,
   inquiry obligations or a server-owned branch handler for an ordinary run.

Store `run_kind` in the existing canonical run/request state or Workflow parameters. Add at most one field to
the existing owner; do not create a method registry or a new table. `handler_generation` is legacy execution
metadata, not the product's permanent mode selector.

In `research-workflow.ts`, dispatch before `executeResearchWorkflowApplication`:

- `ordinary` → one cohesive ordinary-answer application function in
  `packages/cloudflare-research-runtime/`;
- `deep` → the selected bounded deep loop;
- old admitted generations → the old reader/executor only until their real in-flight attempts settle.

A completed old report is read directly and does not retain the old executor.

## Four durable responsibilities

The ordinary Workflow needs four responsibilities, not eighteen stages:

1. **Prepare** — read exact admitted revisions; use whole material when it fits, otherwise one scoped native
   retrieval; build the selected prompt once.
2. **Generate** — perform one provider attempt, stream public Markdown, require a valid terminal provider event,
   and retain the completed public text once.
3. **Save** — resolve supplied labels to compact citations and write the report/body/head through existing
   artifact storage.
4. **Finish** — store the result reference and terminal run state.

These may be implemented as four durable steps or fewer where one atomic owner already combines them.
Do not create a generic step graph. The provider effect is tied to its original attempt; a Workflow retry after
an uncertain dispatch must reconcile that attempt rather than call another model.

## Context: server-owned and prepared once

The browser sends the question, selected source/derived-output references and optional follow-up reference.
It never assembles the corpus and sends it back.

The server:

- distinguishes omitted selection from an explicitly empty set;
- resolves exact authorized revisions once;
- keeps source identity/range beside every text block;
- reserves answer capacity before filling context;
- reads selected sources directly when they fit;
- otherwise performs one scoped native search and exact bounded reads;
- records explicit omissions; `FULL` never silently drops a selected source.

Follow-up context is a bounded relevant prior result/question relation, not a token transcript service.
Native query rewriting may be used once when a follow-up retrieval query genuinely needs disambiguation.
Do not run native rewriting and another local rewrite/planner for the same turn.

Narrow `packages/policy/src/context-compiler.ts` to useful packing over typed admitted blocks.
Remove expiring manifests, repeated evidence parsing/hashing, selection receipts and repeated serialization of
the growing request. Pre-encode stable blocks once, maintain running byte/token budgets, and validate the final
request. A conservative configured estimate is acceptable when the selected tokenizer is unavailable; label it
as an estimate. Token window, serialized request bytes, response bytes and Worker memory remain distinct limits.

## One normalized model stream

The ordinary model output is public Markdown with server-issued passage labels. It is not JSON containing escaped
Markdown and not the deep `material_claims` schema.

Extend the selected transport under `packages/cloudflare-model-transport/` with one normalized event surface:

- public text delta;
- final usage and observed provider/model identity;
- terminal reason;
- safe transport failure.

Use the actual selected API (`chat completions`, `responses`, `messages`, or an already-supported custom API).
Implement only the decoders required by selected models. Do not force every model through a compatibility endpoint
if that loses a required capability, and do not build a provider framework for hypothetical models.

Preserve the current metadata-only Gateway logging, cache bypass and `cf-aig-max-attempts: 1`.
Cloudflare Gateway can retry upstream failures, but a paid stream with an uncertain outcome must remain one
application attempt. Raw provider frames, prompts and reasoning never reach the browser or report.

The decoder must:

- bound frame and aggregate output bytes;
- decode UTF-8 incrementally;
- ignore/private-handle reasoning events;
- require the selected provider/model identity;
- require a valid terminal event before marking output complete;
- retain final usage;
- distinguish client delivery failure from provider failure.

A socket EOF or HTTP 200 alone is not successful completion. A provider without streaming capability reports that
capability honestly; do not fake streaming by replaying a buffered response or silently choose another paid model.

The existing buffered decoder/executor may remain for probes or selected non-stream callers while they exist.
Move ordinary callers to the streaming path, then delete raw-response persistence and duplicate ordinary decoders
that no longer have a caller.

## Retain public output before materialization

During generation, aggregate only public Markdown within the configured bound. After a valid terminal event,
store that text immutably once and return its locator plus usage/model metadata. Do not store every provider event
or repeat the body in Workflow checkpoints.

Report materialization reads this locator, resolves model-visible labels through the server-owned passage map and
writes:

- report Markdown;
- compact citation refs from [source lifecycle](source-lifecycle.md);
- a small summary/status;
- the existing report/head reference.

Unknown or ambiguous labels remain unresolved. Code spans containing `[1]` are not automatically citations.
A source-wide label is not an exact quotation. No second model call converts JSON to prose and no claim ledger is
fabricated for ordinary output.

If report saving fails, retry saving from the retained public-output object. Never repeat generation because a later
D1/R2 write failed. If generation ended without a recoverable completed output, the attempt remains failed/unknown;
automatic redispatch is forbidden. A terminal partial output may be retained once for honest cancellation/error
display, but it is not published as a completed report.

## Presentation and reconnect

Use [the ResearchSession delivery note](research-session-projection-protocol.md).
The run owns execution; ResearchSession relays bounded public phase/text batches.

- Browser disconnect does not cancel the Workflow or provider attempt.
- Slow/disconnected subscribers cannot block output retention or report saving.
- No per-token D1/R2 journal and no permanent chat transcript.
- A monotonic byte offset/sequence detects a presentation gap; it is not an authority receipt.
- Reconnect reads canonical run status and saved report. While the run is active, the UI may resume new deltas with
  an explicit gap instead of replaying every provisional token.
- Once saved, provisional text is replaced by the canonical report.

SurfSense's current local chat is useful here: the run outlives its HTTP follower, finalization is shielded from
disconnect, partial text is settled, and adjacent deltas are batched. Do not copy its in-memory list of every frame,
local chat database, full transcript model or local vector stack.

## Replace stage-based status

Change together:

- `packages/interfaces/src/semantic-api.ts`;
- `packages/cloudflare-research-runtime/src/research-session-status-application.ts`;
- `packages/owner-api-client/src/research/runs/authority.ts`;
- React query/presentation callers;
- then delete the duplicate decoder in `packages/pwa-research-workspace`.

The current `next_stage_index`/stage-18 contract exposes the retired implementation. Replace it with current
behavior:

- `run_kind: ordinary | deep`;
- `phase: queued | preparing | generating | saving | completed | cancelled | failed`;
- terminal result availability and report reference;
- safe failure/cancellation information.

Do not add a permanent v3/v4 status compatibility family. Server and current React client change together under
the existing deployment-generation fence. If a temporary old-run adapter is required during drain, name its actual
consumer and remove it after old runs settle.

Status reads the stored run/result owner directly. It does not require `isSemanticResearchHandlerGeneration`,
scope replay or historical executor reconstruction merely to expose a saved report.

## Deletion after cutover

After the current React caller and real run readers use the new path:

- remove ordinary use of `INSTALLED_INQUIRY_PROTOCOL_REFS.lookup`;
- remove ordinary planning-manifest/obligation/branch-handler construction;
- delete unused ordinary paths in `research-synthesis-prompt.ts` and `research-answer-text.ts`;
- remove stage-18 status assumptions and the legacy PWA decoder with the old PWA;
- remove ordinary EvidenceFreeze/AllowedReferenceManifest/claim-audit materialization requirements;
- remove raw provider-response storage/decoders used only by ordinary synthesis;
- delete fixtures that exist only to preserve those retired paths.

Do not remove shared model probes, deep-research tools, source readers, report writers or actual in-flight old-run
settlement code until their remaining callers are moved.

## Completion

The replacement is complete when a real owner journey demonstrates:

1. V5 `lookup` does not compile an inquiry protocol, planning manifest or branch handler.
2. One provider attempt emits progressive public text and retains one completed Markdown object.
3. Disconnect/reconnect does not duplicate the provider call.
4. Save failure retries from retained output.
5. Status contains no stage-18 or handler-generation requirement.
6. Report reopening and compact citations work from canonical storage.
7. The superseded ordinary executor, decoders, proof inputs and fixtures are removed.

During implementation run scoped TypeScript compile/lint. Product tests and acceptance follow assembly.
Cloudflare references checked 2026-10-18:
[AI Gateway request retries](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/),
[AI Gateway REST endpoints](https://developers.cloudflare.com/ai-gateway/usage/rest-api/),
[AI Search streaming response](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) and
[Workers streams](https://developers.cloudflare.com/workers/runtime-apis/streams/).
No donor code or dependency is selected by this document.
