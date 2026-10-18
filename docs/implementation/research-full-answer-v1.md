# Ordinary answer: implement the whole path

Selected target, not a deployed API. Source inspected at `ba344566` on 2026-10-18; source-selection and
follow-up requirements were refined against `project-search.ts` at `aefca049` and the [NotebookLM review](notebooklm-donor.md).
[The plan](backend-entrypoints.md) owns work ordering; this note specifies the ordinary-answer replacement.
The filename is historical, not a new wire version. `research-run-request.v5` is already in use.

## The actual obstacles

Paths below are relative to the repository root. Reuse useful functions, not their entire control chain.

| Existing source | What must change for ordinary answers |
|---|---|
| `packages/cloudflare-research-runtime/src/research-workflow-application.ts` | `executeResearchWorkflowApplication` assembles generation-dependent handlers and the checkpoint executor. Ordinary work must branch before that assembly, not execute the same graph with most stages disabled. |
| `packages/cloudflare-research-runtime/src/research-synthesis-prompt.ts` | `createResearchSynthesisPromptDependencies` reads a STARTED stage, frozen Stage 5/10 context and manifest, then revalidates the binding. Do not fabricate those records merely to reuse its prompt formatting. |
| `packages/policy/src/context-compiler.ts` | `createEvidenceContextCompiler` combines useful packing with expiring manifests, repeated evidence parsing/hashing and selection receipts. Its exact-body trial path builds a receipt and serializes the growing request for each optional candidate. Separate the packing operation from that protocol. |
| `packages/cloudflare-model-control/src/research-model-prompt.ts` | `modelRequestBody` sets `stream: false`; `userPayload` sends route/generation/selection metadata as model context. Build the actual selected streaming request, not another wrapper over this non-streaming contract. |
| `packages/cloudflare-model-transport/src/model-gateway-response.ts` and `model-gateway-provider-native-response.ts` | Both inspected response paths require `application/json` and buffer the body. Update request validation, provider adaptation and response consumption together; changing one boolean does not provide streaming. |
| `packages/cloudflare-research-runtime/src/research-answer-text.ts` | The incremental inner-JSON reader expects `answer_markdown`. Default-branch symbol search found its definition and tests only; it is not evidence of a wired stream. The plain-text target below needs no such reader. |
| `apps/eliotr-core/src/research-session.ts` | The current send guard accepts only snapshot RPC replies and discards other messages. A provider delta cannot reach the browser through this contract unchanged. See [session delivery](research-session-projection-protocol.md). |

## One captured request, one ordinary execution

Change Core `research-run-service.ts`, `research-workflow.ts` and the owner-client run methods together.
Capture selected source revisions, question, output language, context choice, model/transport and the original
attempt once. Keep existing run/status/cancel/report identities. No second admission API, settings service,
operation registry or generic engine is required. The ordinary orchestration is direct application code in
the existing research runtime; both modes share the operations below, not a mandatory stage-factory interface.

Selection is typed request intent, not substring matching on UI labels. Distinguish omitted selection (the
explicitly defined default) from an empty selected set (no sources). Do not reinterpret empty as the whole Library.
For source-backed work without usable selected material, report the missing/empty condition. A failed source
read is not a successful empty search. When AUTO proceeds with partial material, retain the omission reason;
FULL cannot silently omit a selected source. Existing access and deletion errors retain their actual meaning.

The browser submits source/derived-note references and a relevant existing follow-up reference, not an assembled
corpus to be sent back to the server. Resolve authorized revisions and prepare context on the server once.
A token preview may return counts/selection information; it need not roundtrip all source bodies. Old assistant
answers and selected Wiki/report notes remain derived context, with their references, not new primary evidence.

Use the existing native Workflow for execution lifetime, including after a tab closes. Its checkpoints hold
small results or stored locators. Keep the record needed to identify a dispatched paid attempt and recover its
output; do not mirror each native step in a new application scheduler. Remove ordinary qualification renewal,
branch planning, evidence-freeze, claim-audit and historical-generation dispatch obligations. Deep research
remains explicit; its actually used code is not falsely counted as deleted when only ordinary dispatch changes.

## Follow-up questions without a second planner

A follow-up such as “what changed in its later version?” needs relevant conversation context; sending that sentence
alone cannot establish its subject. Read the existing run/result relationship and pass a bounded relevant history
through admission, retrieval and synthesis. Implement any missing relation with these callers, not a new thread
service or a log of every token. Previous assistant text resolves conversation intent; source claims still use
current permitted source references. Excluded or inaccessible material must not return through an old prompt body.

`packages/cloudflare-ai/src/project-search.ts` currently sends one user message and `query_rewrite.enabled: false`.
Cloudflare's [native rewrite](https://developers.cloudflare.com/ai-search/configuration/retrieval/query-rewriting/)
requires the `messages` format, leaves the first message unchanged and uses history for subsequent turns
(documentation checked 2026-10-18). Merely enabling it on that one-message caller does not supply missing history.
Use native rewriting only when the selected follow-up needs retrieval disambiguation; no second local rewrite
model or mandatory query planner. Whole-source reading does not need a search rewrite. Count history in the
request budget and a native rewrite as real additional model work. Preserve the exact selected-source filter.

## Prepare context once

Resolve selected material through the existing source/evidence readers. Keep source revision and passage
coordinates with each admitted text block. For whole sources, use their existing representation/ranges and
include all selected content; do not require semantic indexing or create a new chunking service to label it.
FULL refuses overflow, AUTO may choose retrieval with stated omissions, FRAGMENTS uses existing retrieval.
When there is no relevant material, say so; never manufacture citation labels to fill a required array.

Narrow the current compiler to typed admitted blocks, deterministic selection and request construction.
Retain source grouping, useful diversity and explicit omissions; keep mutable access checks at the actual
read/disclosure boundary. Do not rebuild manifests, policy generations, evidence digests or hashed selection
receipts inside a pure packing loop. Selected references and omission facts belong in the existing run/result,
not a new proof table. No fake legacy manifest should be needed to call the surviving packer.

Reserve answer capacity before selecting input. Model tokens and serialized request bytes are separate
bounds. Use the selected model's tokenizer/counting API when already available; otherwise use a documented
conservative estimate and configured margin, clearly not an exact token count. No paid probe or calibration
programme for each question. A donor's four-characters-per-token constant is not a multilingual guarantee.
Unknown model capacity needs an explicit configured cap, not an assumption of zero or infinite capacity.
Do not disable FULL merely because no tokenizer is installed when the configured estimate/cap supports it;
refuse overflow without silently changing the selected mode.
Pre-encode independent prompt blocks once, include wrapper/escaping overhead, maintain the running size and
validate the final emitted body. Do not rebuild and hash the entire growing envelope per candidate. If exact
tokenization is non-additive, perform the final selected-request check and bounded adjustment without restoring
a per-candidate proof pipeline. Do not introduce a generalized optimizer to replace a straightforward packer.

A single synthesis is the normal output path, not a prohibition on obtaining necessary evidence. Use an already
available outline, bounded neighboring passage or full selected source for a concrete gap. Additional retrieval
serves an identified unresolved question or the explicit deep task, not a fixed panel of agents. A source guide
or saved answer can help navigate, but cannot substitute for reading the material used to support a new claim.

## Stream plain answer text

The ordinary model output is Markdown with labels for supplied passages, not JSON containing another escaped
Markdown string or the deep `material_claims` schema. The application's saved report DTO is separate from the
model's output format. Reuse the current Markdown parser/rendering path for label handling and safe display;
code examples containing citation-like text are not automatically citations.

Extend the selected provider adapter in `packages/cloudflare-model-transport/src/` to consume its actual
stream protocol incrementally and yield public text plus final usage/termination facts. Preserve bounded
frames, UTF-8 decoding, cancellation and selected provider/model identity. Do not forward raw provider events,
reasoning or prompts. An HTTP 200 or socket EOF alone does not establish a complete provider response.
A provider that cannot stream reports that capability honestly; do not emulate streaming by replaying a fully
buffered answer or silently choose another paid model. No additional LLM call translates JSON into prose.

Resolve model-visible labels through a server-owned map of the supplied source passages. Reuse the existing
evidence issuer/resolver; labels alone neither issue EvidenceHandles nor prove support for a conclusion.
Unknown labels stay unresolved. A source-wide label must not be presented as an exact quotation; quoted text
must match the indicated representation/range. Do not manufacture claim-ledger rows to satisfy the old finalizer.

## Save once; recover without paying again

The model step retains its completed public output through the existing output store and returns its locator,
not the body in every checkpoint. Report materialization then writes the saved text, resolved citation map and
summary through existing artifact storage. Reuse those writers after removing deep-only preconditions from
the ordinary call; do not invent a second result store. Metadata/publication changes remain atomic where needed.

A failed report save retries that save from the captured output, not synthesis. A failure after provider
dispatch with no recoverable output remains an uncertain attempt; do not re-send automatically. Cancellation
stops further paid work and preserves honest partial status. Optional verification follows an explicit request
and cannot delay or erase an already usable answer. See [failure handling](failure-model.md).

Deliver provisional text through the existing ResearchSession binding. Only successful report readback makes
it saved. Reconnect uses canonical HTTP run/report reads; no durable per-token journal or second transcript.
The session's delivery failure must not turn a completed model call into an automatically retried paid step.

## Completion and donors

One connected source → question → progressive answer → saved report → exact citation → reopen path, with no
dummy freeze/proof records. Then check interrupted delivery, oversized FULL input, missing citations, failed
save and reconnect on the assembled product. During implementation use scoped compile/lint, not a new test campaign.
For the selected-source/follow-up integration also exercise explicit-empty selection, unavailable selected material
and changed source scope between turns. Do not preserve a donor's silent fallback to make these cases look successful.
Delete the unused inner-JSON reader and obsolete ordinary-only wrappers/fixtures when their remaining callers
are accounted for. Do not keep an alternate ordinary executor merely to preserve its tests.

[SurfSense prompt mapping](https://github.com/MODSetter/SurfSense/blob/7fb479c361414e1ffd180860eb0b5eb5afb0c4e3/surfsense_local/backend/modules/chat/prompt.py)
is a model-visible-label pattern, not an Eliot evidence implementation.
Its [budget module](https://github.com/MODSetter/SurfSense/blob/7fb479c361414e1ffd180860eb0b5eb5afb0c4e3/surfsense_local/backend/modules/chat/budget.py)
reserves output first but uses fixed estimates and an unknown-window fallback: take the reserve principle,
not those constants or compatibility behavior. Pattern study only; no donor code/dependency is imported.
[NotebookLM's public mechanisms and Open Notebook's actual code](notebooklm-donor.md) inform source selection,
follow-up context and explicit reuse of saved knowledge; they do not establish Google's internal implementation.
[Cloudflare Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) and
[Workflow retry](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) were checked 2026-10-18.
They supply transport/durability primitives, not a guarantee against duplicate arbitrary provider effects.
