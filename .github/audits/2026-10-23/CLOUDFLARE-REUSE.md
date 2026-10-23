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

## Scope and verification boundary

Reviewed the current Architecture and Implementation, Donors, coverage register, relevant legacy transport paths and the
named upstream source/docs. Architecture's product requirements and MAP's delivery ownership remain unchanged. This is
not a complete reread of every repository or a claim of measured quality parity.

The patch changes ordinary Markdown only. No dependency upgrade/install, TypeScript application build, product test,
model/search/conversion call, deployment, live-data inventory, migration or deletion was performed. Native APIs still need
integration evidence. The [single register](../REVIEW-REGISTER.md) retains those open checks; no new runtime gate or
parallel tracking system is introduced.
