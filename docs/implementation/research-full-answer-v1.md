# Ordinary answer: one prepared context, one streamed synthesis

Selected target, not a deployed API. Source inspected through `d1098123` on 2026-10-18. Work ordering is in the
[implementation plan](backend-entrypoints.md); the shared model boundary is in
[model-tool-loop.md](model-tool-loop.md). The filename is historical, not a wire version: `research-run-request.v5`
is already current.

## Current obstruction

| Existing source | Required change |
|---|---|
| `research-workflow-application.ts` | Branch ordinary work before generation-dependent stage-handler/checkpoint assembly. Do not run the old graph with disabled stages. |
| `research-synthesis-prompt.ts` | Extract prompt construction from STARTED-stage, frozen Stage 5/10 and manifest requirements. Do not fabricate those records. |
| `policy/src/context-compiler.ts` | Keep useful packing/grouping; remove expiring manifests, repeated evidence hashing and per-candidate selection receipts from the pure packing path. |
| `research-model-prompt.ts` | Stop compiling the old non-streaming JSON envelope. Produce AI SDK model messages from typed admitted passages. |
| raw provider request/response adapters | They force/buffer completed JSON and reject tools. Migrate the selected route to the AI SDK adapter rather than adding custom vendor/SSE parsers. |
| `research-answer-text.ts` | Its inner-JSON `answer_markdown` reader is not a wired stream. Delete it after callers move to plain Markdown output. |
| `research-session.ts` | Add an authorized bounded public-text/progress projection; snapshot RPC remains the canonical read entry, not a dispatch channel. |

## One captured request

Change Core run admission, Workflow entry and owner-client methods together. Capture once:

- question and output language;
- explicit selected source/derived-note references;
- context mode `FULL | AUTO | FRAGMENTS`;
- selected qualified AI SDK route/model;
- original run/paid-attempt identity and cancellation/budget state.

No second settings/admission API or operation registry. Distinguish omitted selection from an explicit empty set;
never reinterpret empty as the whole Library. FULL cannot silently omit a selected source. AUTO records every
omission reason. Access/deletion failure is not an empty successful answer.

The browser sends references, not a corpus roundtrip. Resolve permitted revisions and prepare context server-side.
A follow-up uses a bounded relevant prior run/result reference; old assistant text helps resolve intent but remains
derived context. Excluded/private material cannot return through an old prompt body.

Use the existing Workflow for lifetime after tab close, with compact values/locators only. Remove qualification
renewal, branch planning, evidence freeze, claim audit and historical handler-generation obligations from ordinary
execution.

## Prepare context once

Resolve selected material through existing source/evidence readers. Every admitted block keeps source revision,
representation and range. Whole-source FULL reads stored representations directly and does not wait for indexing.
AUTO chooses whole text when it fits, otherwise existing scoped retrieval with explicit omissions. FRAGMENTS uses
retrieval. No relevant material means an honest no-evidence response, not invented citation labels.

Refactor the compiler to a small deterministic packer over typed admitted blocks. Keep source grouping, diversity,
explicit omissions and final emitted-body validation. Access checks stay at real read/disclosure boundaries.
Do not rebuild policy generations, manifests, evidence digests or hashed selection receipts inside packing.

Reserve output capacity before input selection. Model-token and serialized-request limits are separate. Use a
qualified tokenizer/count from the selected route when available; otherwise a documented conservative estimate and
margin. Unknown capacity gets an explicit cap. Pre-encode independent blocks once and maintain running size; do not
serialize/hash the entire growing request for every candidate. A bounded final adjustment is sufficient.

One synthesis is normal, not a ban on necessary evidence. Read a selected full source, bounded adjacent passage or
existing outline for a concrete gap. Additional retrieval belongs to an identified unresolved need or explicit
deep mode, not a fixed stage panel.

## Stream through AI SDK

Use Cloudflare `agents/models/ai-sdk` `createAI({ binding: env.AI })`, the selected qualified vendor provider and
AI SDK `streamText`. The ordinary call has no tools and no SDK-owned loop.

The model returns Markdown with short server-owned passage labels, not escaped Markdown inside JSON or the old
`material_claims` schema. Consume AI SDK's typed full stream once:

1. append public text deltas to one retained output object;
2. emit bounded provisional batches through ResearchSession;
3. retain final finish reason, usage and useful Cloudflare provider metadata;
4. mark generation complete only after the SDK terminal finish.

Do not implement another provider SSE parser, another browser decoder, or fake streaming from a buffered response.
Do not forward raw events, prompts, reasoning or source bodies. A route that fails pinned `streamText`
qualification does not offer ordinary streaming and is not silently replaced mid-run.

Cloudflare response DLP buffers SSE. Use request-only DLP or a separately configured streaming gateway and disable
payload logging for private-source calls. See [model turns](model-tool-loop.md).

## Citations

Map model labels through the server-owned table of supplied passages and the existing evidence resolver. A label is
not an EvidenceHandle and does not prove claim support. Unknown labels remain unresolved. A source-wide label is not
an exact quote; quoted text must match its representation/range. Code examples containing citation-like text are
not automatically citations.

No second citation store or claim-ledger rows. The saved report DTO is separate from the model-output format.

## Save and recover without paying twice

Reserve the model turn before dispatch. The completed stream writes one retained output and its locator. Report
materialization writes that text, resolved citation map and summary through existing artifact storage.

A report-save failure retries from retained output, not synthesis. A provider call with no safely observed completed
result remains uncertain and is not automatically re-sent. Cancellation stops further work and preserves honest
partial state. Optional verification is explicit and cannot delay or erase a usable ordinary answer.

ResearchSession delivery is advisory/provisional. Only report readback makes the result saved. Reconnect reads the
same run/report; no per-token durable journal or second transcript.

## Follow-ups and native rewrite

A follow-up such as “what changed later?” needs bounded relevant history. Carry it through admission and synthesis
using existing run/result relationships. Native AI Search rewrite receives history only when retrieval
actually needs disambiguation; merely enabling rewrite on the current one-message caller supplies no context.
Do not run native rewrite and a local rewrite/planner for the same question. Whole-source reading needs neither.

## Completion

The assembled path is:

`selected source → question → progressive Markdown → retained output → saved report → exact citation → reopen`.

Exercise explicit-empty selection, oversized FULL, missing/unknown citations, interrupted delivery, uncertain model
outcome, failed save, reconnect and scope change between turns. During implementation use scoped compile/lint.
Delete old inner-JSON readers and ordinary-only proof/factory wrappers after callers move.

SurfSense/DocsGPT inform prepare-once grouping, output reserve and short labels; their constants/ordinal citations
are not Eliot evidence. NotebookLM/Open Notebook inform explicit selection/follow-up context, not Google's private
implementation. Cloudflare Streams, AI SDK and Workflow provide transport/durability primitives, not exactly-once
arbitrary provider effects.
