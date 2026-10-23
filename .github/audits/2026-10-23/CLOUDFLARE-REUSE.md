# Cloudflare native reuse: remove plumbing, retain research semantics

**Checked:** 2026-10-23. **PR baseline:** `da1422538925fda83eb48cfcfb4e14c125b02dfd`.
**SDK source:** `cloudflare/agents`, tag `agents@0.30.0`; **legacy Eliot:** `7c034569b908d3b03a8b821b7c537477a24b10f7`.
This pass compares the October 19–22 releases, current primary documentation and selected source paths with the
replacement design. Decisions are folded into [Implementation](../../../docs/IMPLEMENTATION.md) and
[Donors](../../../docs/DONORS.md); this audit is evidence, not another implementation contract.

## 1. createAI is already selected, but the deletion boundary was too vague

The [October 21 announcement](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/) deprecates and freezes
`workers-ai-provider` and `ai-gateway-provider`. It is not a reason to install all three providers or add a new wrapper.
The native provider already carries Workers AI, catalog/dynamic routes and vendor model objects.

The inspected legacy [response decoder](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/cloudflare-model-transport/src/model-gateway-provider-native-response.ts)
contains provider-specific field whitelists; `exactObject` rejects unknown additive fields. The inspected beginning of
[model execution](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/cloudflare-model-transport/src/model-gateway-execution.ts)
also owns request digests, fingerprint/receipt shapes and transport selection. These are concrete paths not to port,
not evidence that every legacy model failure has been reproduced.

**Decision:** SDKs own wire formats, streaming and provider response parsing. Eliot owns settings, capability/context
bounds, admission and canonical output storage. Keep vendor packages only for actually needed native functionality.
Missing diagnostic metadata is not a new readiness gate. Legacy runtime files remain untouched until their callers move.
Inspected [AI SDK transport](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/models/ai-sdk/transport.ts)
delegates to the SDK's [core transport](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/models/core/transport.ts),
rather than requiring Eliot to implement the protocol again.

## 2. Resume is not a fresh model retry

The [pinned replay implementation](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/models/core/resume.ts)
counts delivered complete SSE events and resumes the existing Gateway run after a read failure. It stops on abort,
expired replay or exhausted reconnects. It does not invent a new generation, and a clean EOF is not a replay trigger.
The [provider guide](https://developers.cloudflare.com/agents/models/ai-sdk/) limits this to catalog/dynamic streams
through the binding; Workers AI and vendor model-object streams do not have this facility.

**Decision:** retain native same-run replay and ChatAgent browser reconnect. Keep new-generation retries/continuations
under host admission, preserve partial output when recovery ends, and do not build another event buffer or resume server.
Configured SDK fallback is separate from Gateway provider routing; reserve the configured chain's allowance up front,
without claiming exactly one upstream attempt. A lost application process is not automatically recovered by stream replay.

## 3. Credential and privacy options are route-specific, with one unresolved conflict

The current createAI guide says it sends `byokAlias` for catalog calls. The
[Unified Billing guide](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), updated September 30,
still says only `default` is consulted on Unified Billing endpoints and named aliases work on provider passthrough.
These statements do not establish that the service now honors the header on both paths.

**Decision:** document the discrepancy, use the documented native route for a required non-default alias, and keep
BYOK-only fallback prevention. Confirm the actual configured route once during integration/setup; do not create recurring
qualification or disable ordinary unrelated work. Per-call ZDR on vendor objects is not a guarantee on catalog/dynamic
routes. Metadata-only logging, disabled logging, transient replay storage and provider retention are not interchangeable.
No key values, account credentials or live billing were accessed during this review.

## 4. Reuse web discovery; do not turn continuation into another download

The [Web Search guide](https://developers.cloudflare.com/agents/tools/web-search/) and pinned
[search exports](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/web/search/index.ts)
provide `createAIWebSearch`, rendering and tool adapters. A user-entered Find sources query needs no LLM planner.
The native tool has a compact model projection; passing the same approved tools into `convertToModelMessages` preserves
that projection on later turns instead of sending the full JSON response again.

The [Web Fetch guide](https://developers.cloudflare.com/agents/tools/web-fetch/),
[public entry](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/web/fetch/index.ts) and
[direct source](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/web/fetch/source.ts)
provide bounded GET/redirect/conversion handling. The default output is a converted page; the default tool fetches the URL
again for continuation. Character-window offsets are not Eliot citation byte offsets, and host filtering is not DNS pinning.

**Decision:** use native search/functions/output projection; use native fetch only where its result meets the requested
preview/capture semantics. Retained import still preserves original and readable bytes from one acquisition. Read later
windows from the saved revision. Do not add preview before every capture, rebuild a search formatter, refetch to recover
an original, or introduce a browser harness for a plain GET. Actual capture integration remains unbuilt.

## 5. Native search is selected; automatic RAG answers are not a drop-in replacement

The [search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) exposes retrieval independently
of `chatCompletions`. Eliot needs to resolve scope and hydrate exact retained evidence before synthesis, so it uses native
search followed by one model call. The [adapter guide](https://developers.cloudflare.com/ai-search/agent-sdks/ai-sdk/)
currently specifies AI SDK v6. This does not prove v7 compatibility, nor require an adapter over an existing binding.

The [Items API](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) supplies status/logs/chunks for
reconciliation, but download returns the original upload, not a retained OCR transcript. Search item keys alone are not
canonical ranges. The [model list](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/)
still supports our Qwen3 baseline. New tokenizer/multimodal options alone do not establish improved Russian recall.

**Decision:** no second index, adapter-driven second synthesis or removal of retained evidence/structural context on the
strength of a release note. Those small product-specific parts remain; retrieval quality still needs the existing corpus
measurement rather than an invented claim that Cloudflare or Eliot is universally better.

## 6. Other releases do not justify more architecture

[Clairic, October 19](https://developers.cloudflare.com/changelog/post/2026-10-19-clairic-workers-ai/), is a preview typed-field
extractor. It is a candidate to replace optional generative metadata/field extraction, not a required extra pass.
The [extraction guide](https://developers.cloudflare.com/workers-ai/concepts/extraction-models/) distinguishes extracted,
computed and predicted values; null/empty/confidence/type validity are not proof of correctness or absence. Verify text
spans against retained input before mapping citation bytes. Russian/English quality and total-cost benefit are unmeasured.

[October 22 MCP retirement](https://developers.cloudflare.com/changelog/post/2026-10-22-cloudflare-mcp-servers-retire-sse/)
requires `/mcp` for Cloudflare's own product endpoints and may require reauthorization. This is a configured-URL update,
not a reason to create a proxy or prohibit SDK compatibility for every Eliot client.
[Pi 1.4](https://developers.cloudflare.com/changelog/post/2026-10-22-pi-harness-pi-1-4/) has useful recovery changes, but its
new-turn retry behavior and one-way schema migration are not the same as createAI same-run replay. No Pi/Think/Code Mode
runtime is added beside the already selected ChatAgent/Workflows merely to obtain model and web SDK functions.

## 7. Continuation from `5aafdbab`: native observation, readiness and parsing

**Rechecked 2026-10-23.** This continuation also revisits earlier platform releases; it does not label them newly
released today. Architecture requirements and MAP delivery ownership are unchanged.

| Reviewed capability | Replacement decision | Boundary retained |
|---|---|---|
| [Workflow instance subscriptions, September 15](https://developers.cloudflare.com/changelog/post/2026-09-15-instance-event-subscriptions/) and [API](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/) | A small authenticated event projection for the visible job instead of periodic status polling and a progress DO/broker/replay journal. | Native replay is observation; saved results remain in D1/R2. Close/dispose the subscription with its stream, preserve job identity/cursor and never forward raw outputs/errors. |
| [Step context](https://developers.cloudflare.com/workflows/build/step-context/) and [retry delays](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) | Use native step/attempt diagnostics, sleep and bounded safe retry configuration instead of a parallel retry/checkpoint engine. | Counts are not external idempotency keys; unknown mutations or model generations are not retried automatically. |
| [AI Search modes](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) | Optional keyword mode on the same scoped search operation/index; ordinary document questions stay hybrid. | Porter stemming and top-k require canonical literal verification; no claim of exhaustive absence or Russian-quality improvement. |
| [Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) | Native status/log/chunk APIs and bounded `uploadAndPoll` where appropriate. | Bulk ingestion still records upload IDs and resumes waiting; timeout/skipped/error cannot become ready or a second upload. |
| [Current chat API](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) | Native per-chat queue and React reconnect/history; `cancelOnClientAbort: false` distinguishes navigation from Stop. | Product settings, cancellation and server-side paid admission remain explicit; the queue is not proof of durable intent. |
| [remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse), [GFM](https://github.com/remarkjs/remark-gfm), [math](https://github.com/remarkjs/remark-math/tree/main/packages/remark-math) | A fixed maintained parser replaces a homemade Markdown grammar; Eliot keeps grouping/context and exact source mapping. | [unist offsets](https://github.com/syntax-tree/unist#point) count UTF-16 units, not UTF-8 bytes. Do not cite decoded values, generated nodes or a reserialized document. |

The inspected legacy [projector](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/retrieval/src/structural-projector.ts)
starts with its own line/byte splitting and 32/64 KiB defaults; only its useful exact-range lessons are retained. Native
recursive chunking is not documented as a complete table/heading parser, so removing all structural context on that basis
would be unjustified. The selected parse library is a local dependency, not another deployed platform.

The same register now calls out subscription replay/disposal, native queue/Stop, keyword-mode scope, timeout readiness
and UTF-16→UTF-8 conversion as unimplemented checks. No new audit registry, live calls or speculative quality claim.

## 8. Neighboring applications and conditional platform reuse

**Survey baseline:** `fb88b4c57fe3343eb7dcd299b86d16af8eec78c6`, checked 2026-10-23.
The [Donors survey](../../../docs/DONORS.md#cloudflare-native-neighboring-applications) records exact pins, source paths,
useful mechanisms and exclusions. This pass did not run those applications or convert their READMEs into acceptance.

Three source-reviewed examples cover complementary parts of Eliot: `SoraKumo001/cloud-notebook` (`b684523f`, July 5)
provides the notebook/RAG/MCP shape; `G4brym/workers-research` (`c7ae7399`, March 15) provides one Workflow with web/library
strategies and saved-report follow-up; `YSahloul/deep-research-app` (`0ac0cc73`, April 18) exposes intermediate workspace
files beside chat. `cloudflare/cloudflare-os` (`03cf8766`, October 23) is an official broader collaboration reference;
only its README was reviewed here. Its internal-adoption statement is a company self-report, not an independent benchmark.

Static source inspection also found reasons not to fork blindly. Cloud Notebook's empty search can trigger corpus
re-embedding in the answer path; low score selects a general prompt; its MCP getter stops at 50 chunks without a cursor.
The intake stream reader throws a server error inside a catch that discards parse failures. Preserve per-file progress
and batch hydration ideas, not these paths, its custom credentials stack or browser-only intake. Workers Research's
historical quota issue is user evidence, not proof the current pinned implementation reproduces it. None was copied;
license verification remains required before code reuse.

The [capability matrix](../../../docs/DONORS.md#additional-cloudflare-capabilities-when-they-remove-work) separates small
reuse opportunities from new deployments. Native `/crawl` can replace a custom site spider for a bounded explicit import;
an existing MCP portal can replace application-side aggregation. Neither is added to ordinary Ask. Browser crawl events
are account-wide Queue notifications, unlike the Workflow instance subscriptions selected for the UI. Results still pass
through retained source revisions and existing scope/coverage rules.

Computer is a candidate for actual scratch-file tools, not another store for notes already saved by jobs. Artifacts is a
candidate for Git exchange, not the canonical PDF library. A CPU Docling converter on Containers is a feasibility option
only after native extraction has a demonstrated gap: image/resources/startup and scientific/Russian fidelity remain
unmeasured. The old blanket donor-platform exclusion is clarified so it cannot forbid a bounded necessary converter,
while the ban on a second RAG platform remains. No application, schema, dependency or deployment is added by this survey.

Official AI Search recipes already cover source-linked chat and approved knowledge updates, but their dependency examples
are not uniformly current: the October 12 approval recipe still uses the deprecated provider and AI SDK 6. Read a recipe
for the mechanism; integrate with the selected current SDK and existing page writer, not a second execution runtime.

## 9. Retained bytes, streaming intake and honest large-scope limits

**Rechecked:** 2026-10-23, baseline `f284a579f39416b6a7b5361145fc30cd060bfd80`.
This pass changes the owning Implementation sections and the existing register, not the product scope or runtime.

### Negotiated Markdown removes a conversion, not the obligation to retain the source

The [October 9 streaming-conversion release](https://developers.cloudflare.com/changelog/post/2026-10-09-markdown-for-agents-in-process-conversion/)
removed generated token-count headers and `Content-Length`; the current
[Markdown for Agents guide](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/)
also documents representation-aware `Vary: Accept` and removal of original-body validators. The guide's 6 MiB limit is
on decompressed HTML input at the serving zone, not Eliot's captured output size or available parse memory.

**Decision:** a successful negotiated Markdown response takes Eliot's existing local UTF-8 path and is retained as the
actual captured representation. Do not call `toMarkdown` again, insist on removed headers, copy third-party response
headers onto a private reader, or fetch HTML afterward and pretend it is the original of an earlier snapshot. A request
for original/rendered HTML stays explicit. Status/challenge/error content cannot become ordinary source evidence simply
because it is Markdown. This is one acquisition and one canonical representation, not a new converter abstraction.

### JSON-envelope storage did not match direct byte-range reading

The baseline Implementation stored `page/<revision>.json` but defined page offsets over decoded Markdown and called for
R2 range hydration. R2 ranges address stored object bytes; escaping, JSON structure and decoded text are different byte
sequences. A reader could decode the whole envelope correctly, but would lose the intended bounded-read advantage.
This is a specification mismatch, not a reproduced runtime corruption.

**Decision:** store `page/<revision>/body.md` plus optional `data.json` for resolved citations and structured Map/Audit
payloads. The existing revision writer publishes the needed references together; the sidecar never duplicates body text.
Source and page readers share the native [R2 range operation](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads).
Merge useful adjacent ranges, bound concurrent reads, consume/cancel bodies and verify returned length. No invented R2
batch-get method, whole-document reload per hit, extra search store or per-read cryptographic verification is introduced.
Old envelopes are decoded once by import; their offsets are not blindly applied to their JSON serialization.

### Streaming storage does not make full parsing memory-free

Current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) document 128 MB per isolate and six
simultaneous outbound connections per request; an isolate can handle multiple requests. A native conversion example that
uses `arrayBuffer()` is not evidence that arbitrary-size uploads plus decoded text and AST fit. A parse library still
materializes structure. The prior donor review's optional CPU converter remains an escape hatch, not a compulsory service.

**Decision:** distinguish stored-file, converter and parse ceilings. Stream/count actual intake bytes; use native
[DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#constructors) for the existing one-time
intake hash without an unread tee branch accumulating the payload. Keep original retention independent of conversion;
never call a retained/truncated prefix a complete document. Use bounded document/section processing rather than loading
a whole comparison corpus. Storage and metadata must finish before a durable-upload acknowledgement.

The inspected [workerd R2 writer](https://github.com/cloudflare/workerd/blob/e9930cbd5804153499ba161c877f61b35a7affe4/src/workerd/api/r2-rpc.c++#L243-L260)
requires a known identity length for stream input. The inspected bucket call supplies no alternative length. An arbitrary
transform or headerless converted response therefore cannot be assumed directly acceptable merely because its TypeScript
type is `ReadableStream`. This is source evidence, not a deployed upload reproduction.

**Correction:** preserve an exact known length (or `FixedLengthStream`), use bounded bytes for small unknown-length input,
and choose native [multipart](https://developers.cloudflare.com/r2/objects/upload-objects/) only for an actual larger-input
requirement. Parts must have known sizes; use a fresh attempt key and publish its reference after complete/readback rather
than assuming multipart completion supports the same create-only precondition as `put`. Retain cleanup of incomplete
uploads. No separate upload service, request-body buffering without a ceiling or invented native stream support.

Current [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/) and
[step result rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#keep-non-stream-step-return-values-under-1-mib)
allow byte-stream results in JavaScript as well as non-stream results under 1 MiB. Streams still consume finite instance
storage and are not long-term export. Retained results continue to use R2 plus references; native stream checkpoints are
only a candidate for transient output that would otherwise need extra plumbing. No second copy by default.

### Scope capacity is still an integration/design risk, not merely a benchmark

The [AI Search limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/),
[filter guide](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) and
[search API](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) establish five custom fields,
64 filterable UTF-8 bytes per string, ten instances per namespace query and at most fifty returned chunks. They do not
say only fifty sources may be selected. Stored arrays cannot implement arbitrary many-to-many membership with `$in`.

The inspected Cloudflare OpenAPI search operation leaves `filters` as an object without a size maximum. By contrast,
the [Items-list schema](https://developers.cloudflare.com/api/typescript/resources/ai_search/subresources/namespaces/subresources/instances/subresources/items/methods/list/)
limits `metadata_filter` to 2048 characters and [Vectorize](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
limits compact JSON filters to less than 2048 bytes. These related limits are a warning, not proof of an identical limit
on every AI Search retrieval mode. No live AI Search call was made to settle that question.
A local compact-JSON size calculation using 36-character UUIDs plus `record_kind: {"$in":["prose","table","code"]}`
produced 2,022 bytes for 50 revision IDs and 19,572 bytes for 500. This demonstrates sensitivity to encoding and clauses,
not an observed AI Search rejection or a recommended fixed source-count cap.

**Decision:** measure the complete filter and validate the actual required 50/500-source path during integration, not on
every turn. Do not discard a selection, trust arrays as indexed membership, confuse result count with selected-source
capacity or call partition-local ranks a single global ranking. A scope-preserving native projection or bounded direct
read may fit; automatic narrowing and silently launching full research do not. The register explicitly leaves the fast
large-selection path unresolved; its advertised latency target is not proof of a deployable solution.

Implementation's duplicated final acceptance list is replaced with links to MAP and a short list of integration-specific
checks. Existing feature/cancellation/import requirements remain in their owning sections; no new approval checklist.

## Scope and verification boundary

Reviewed the current Architecture and Implementation, Donors, coverage register, relevant legacy transport paths and the
named upstream source/docs. Architecture's product requirements and MAP's delivery ownership remain unchanged. This is
not a complete reread of every repository or a claim of measured quality parity.

The latest continuation uses one bounded documentation checkout reconstructed at `f284a579` and checked against the
remote Git blob IDs, not a full application clone. It changes Implementation, this existing audit and the single register;
Architecture requirements and MAP delivery order remain unchanged. No new audit file or runtime subsystem is added.
The related OpenAPI schemas and selected workerd R2 write path were inspected; no live limit/upload behavior was inferred
from a successful production call. Earlier donor/code checks remain dated evidence, not a claim of a fresh exhaustive review.

Only Markdown changed. No dependency upgrade/install, TypeScript application build, product test, model/search/conversion
call, deployment, live-data inventory, migration or deletion was performed. Native APIs still need integration evidence.
The [single register](../REVIEW-REGISTER.md) retains those checks, particularly the unresolved large-selection retrieval
path; no new runtime gate or parallel tracking system is introduced.
