# Model capability and portable chat-state audit

**Reviewed:** 2026-10-23.  
**Documentation baseline:** [`6e1377a`](https://github.com/UnknownAlienHuman/eliot-research/tree/6e1377a5f52a398533e7fa4f75bdd50f4bebd903).  
**Legacy code baseline:** [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).

This continuation checks whether the selected model/chat runtime can actually preserve the documented bounded-work and
migration guarantees. Findings are design gaps in the inspected documentation, not reproduced production incidents.
Corrections live in [Architecture](../../../docs/ARCHITECTURE.md),
[Implementation](../../../docs/IMPLEMENTATION.md) and [Map](../../../docs/MAP.md). No new service, qualification system,
message database or migration framework is selected.

## Findings and corrections

| # | Gap at the baseline | Correction |
|---|---|---|
| 27 | **A selectable model ID had no complete capability contract.** Context/output limits, streaming, tool support, structured output and input modalities differ by model and route. A custom or dynamic endpoint could be selected for a tool call or oversized prompt and fail after retrieval/model spend had already begun. | Add a small versioned `model_profile` per selectable model/route. Resolve the profile with the turn/job, budget the rendered request before dispatch and reject incompatible operations early. Keep only chat/research defaults; unknown custom/dynamic routes start with conservative owner-configured text-only limits. This is configuration, not recurring qualification. |
| 28 | **The documented hard-capped chat tool loop conflicted with the SDK default.** `autoContinueAfterToolResult` defaults to `true`, so a client tool result or approval can automatically buy another model call outside Eliot's explicit admission path. | Set `autoContinueAfterToolResult: false`. After selected tools settle, host code performs one awaited scope/budget/cancel check and admits at most one continuation under the same request/attempt. Duplicate results observe that recorded continuation; unknown mutations do not auto-retry. |
| 29 | **“Export chat Durable Objects” did not define a portable operation.** Scraping SDK-private SQLite would bind migration to undocumented tables; relying on namespace/dashboard enumeration could miss idle chats; `saveMessages` would generate a response during import. | D1 chat rows are the authoritative inventory. Each known ChatAgent exposes a bounded internal product snapshot built from supported messages/state plus immutable R2 body references. Import into an empty same-ID ChatAgent uses supported state and `persistMessages`, then reads back IDs/order/references. Never use private SQL or `saveMessages`. |
| 30 | **Automatic message compaction could make large retained output migration ambiguous.** The DO transcript was authoritative, but unusually large final tool/assistant bodies could approach SDK row limits and a lossy compacted representation could become the only retained copy. | Keep ordinary messages in the ChatAgent. Store only unusually large finalized bodies create-once in R2; the message carries a bounded preview/reference/digest and typed citations. Export validates every referenced body. This is not a second transcript store. |
| 31 | **The runtime configuration still loosely grouped D1 migrations and Durable Object lifecycle.** Current Cloudflare guidance uses declarative `exports` for new Durable Object classes; DO `exports` and legacy DO `migrations` are mutually exclusive, and class rename/transfer/delete is not portable content backup. | Use declarative SQLite `exports` and bindings for new Chat/Tool Connection Agent classes. Keep D1 SQL files in `migrations/`. Treat DO class lifecycle/PITR as same-resource operations; portable content migration remains the versioned chat snapshot contract. |

## Primary evidence checked

- [Agents models](https://developers.cloudflare.com/agents/models/) and the
  [AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/) show that Workers AI IDs, Gateway catalog
  IDs, dynamic routes and vendor objects share one caller but not one capability envelope. Model-specific documentation
  remains the authority for supported bounds/features.
- [AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) documents persisted
  SQLite messages, storage/context separation, compaction and `autoContinueAfterToolResult: true` as the default. It also
  distinguishes `persistMessages` from `saveMessages`, which triggers a response.
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
  documents the declarative lifecycle, SQLite storage and mutual exclusion from legacy DO migrations. A class deletion
  permanently removes its namespace/data; it is not export.
- [Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
  documents SQLite/PITR as object storage recovery. It does not provide a portable application-level chat manifest.
- The existing Eliot model settings UI at the pinned legacy baseline already contains useful provider/model/default and
  write-only credential behavior. The replacement preserves that product behavior without its qualification stack.

## Verification boundary

The canonical files were read from the named baseline before publication. The published Git comparison from `6e1377a`
changes only Architecture, Implementation, Map, this audit and the audit index; the current files were read back from the
branch and their blob identities matched the write results. The local relative references among the canonical documents
and audit resolve to existing branch paths. This is ordinary Markdown: no workflow, encoded payload, runtime dependency,
SQL migration or deployment configuration was added.

No installed-package integration, application build/test, live model call, chat snapshot, production Durable Object
query, deployment, migration or performance measurement was performed. Actual model metadata completeness, custom-route
capability accuracy, SDK message/state snapshot shape, large-body threshold and import readback remain implementation
checks in their owning vertical slices. GitHub CI runs independently and is not runtime/product evidence.
