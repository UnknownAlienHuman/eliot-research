# ADR-0007: Replaceable external models, computer agents and Cloudflare adapters

**Accepted, revised 2026-09-30.** Source/code review: `bf20c4623559a0affb2463246cf975ac69803418` plus this checkpoint.
This revision replaces the earlier staging-only/operator restrictions. It amends ADR-0006's mandatory
client selection and LANGUAGE_RUNTIME_CONTRACT §§0/3/11: providers and clients are replaceable;
TypeScript is the current platform implementation, not a permanent requirement; external Python/tools
may serve research, connectors and operations. Pure-kernel determinism and ERC evidence/state ownership remain.

## 1. Independent connections, not a preferred-vendor architecture

Gemini Spark, Meta Muse and OpenAI Dot are three independent **computer-agent contours**. Any one may be
absent or may replace another for a task. Google is optional. A compatible fourth agent is configuration
or adapter work, not a new architectural approval. An agent's vendor name is diagnostic metadata, never
authority.

| Connection | Required design |
|---|---|
| Model inference | Provider/model ID, endpoint/protocol, credential reference, capabilities and role bindings; Gateway/BYOK, direct provider API or reachable self-hosted service. |
| Computer agent | Separate Access actor, current project-grant revision, available cloud/local computer, browser/app/CLI/MCP capabilities, and task/result interface. A subscription agent need not expose a model API. |
| External tools | Google, browser, storage and other connectors selected independently of agent and inference provider; unused integrations add no product-readiness requirement. |
| Human-style UI transport | The same backend task contract exposed through MCP/API when available and through a narrow authenticated web inbox when an agent can only operate interfaces. UI automation does not weaken task identity, scope, evidence or idempotency rules. |

OpenAI Dot is an always-on agent with its own cloud computer; optional local-computer access can expose
local files, commands, skills, browser fallback and Codex/Work tasks. Workspace controls separately gate
cloud browser, cloud network, cloud desktop, password manager, local computer and messaging integrations.
Connected apps can be reviewed proactively and contribute memories. These capabilities make Dot a third
computer-agent contour, not a substitute for an inference API. Full custom MCP write/modify support is
currently plan-dependent: Pro custom MCP remains read/fetch-only, while full MCP is available to Business
and Enterprise/Edu. Therefore ERC must not depend on write-capable MCP as the only task transport.

The owner chooses read/write/research/publication/administration permissions, data scope and automation
level, including production operation. There is no blanket read-only, QA-only, staging-only or vendor-based
ban. Existing authentication, secret handling, evidence verification and task budgets apply equally.
Reuse approved task/session permissions rather than adding confirmation before every routine operation.
Capability gaps affect the relevant operation, not all work by that client. Model capabilities, computer
capabilities and connector capabilities are recorded separately; none implies the others.

## 2. Existing code and concrete follow-through

| Area | Reuse/change |
|---|---|
| Inference | Reuse `packages/research/src/ports.ts::ModelRoutePort` and `packages/platform-cloudflare/src/model-gateway.ts`. The ten `dynamic/eliotr-*` names are application roles, not ten permitted vendors. Provider/model fingerprints are already strings. |
| External providers | `manageExternalModelSecret()` plus `scripts/manage-external-model-secret.mjs` create or rotate one exact `ai_gateway`-scoped Secrets Store key from bounded stdin. `connectExternalModelProvider()` then composes Custom Provider registration and Provider Config attachment. `customProviderModelTarget()` emits `custom-<slug>/<model>` for Dynamic Routes. Raw provider keys and secret previews never enter JSON, argv, receipts or errors. |
| Additional transports | Dynamic Routes still use the compatibility Chat Completions endpoint. Extend `model-gateway-http-request.ts` and the adapter behind `ModelRoutePort` only for provider-native APIs whose request/response schema cannot use that route; preserve provenance and attempt/output receipts. |
| External clients | Worker verification accepts independent Client IDs through `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS`. Access provisioning accepts independently read-back `{token_id, client_id}` bindings, installs one bounded non-identity policy, and binds receipts/generated Worker vars to the complete order-independent client set. The optional legacy pair preserves `gemini-spark`; omit it when Spark is unused. |
| Google optionality | `GOOGLE_EXTERNAL_TRANSPORT=disabled` is valid. Explicit MCP service bindings or managed OAuth enable the MCP Access contour independently of Google. Selected Google profiles still require their own implementation and qualification. |
| Computer-agent tasks | Migration 0085 owns task/lease/progress/result delivery. Migration 0086 adds immutable bounded task payloads and a task deadline independent of the short W2 execution reservation. The originating agent must still use the existing recovery action to settle the exact started attempt. |

External-model setup is intentionally monotone: pipe the provider key to
`manage-external-model-secret.mjs`, copy its `secret_reference` into the connect input, run
`connect-external-model-provider.mjs`, then use the existing route planner and model-authority installer.
Each mutation uses one write attempt followed by exact readback or operation-marker reconciliation;
no rollback deletes shared provider state.

Connections should allow enabling clients, testing each connection, selecting models per role and
configuring fallbacks without code edits for each vendor. Revocation/removal is a separate reconciled
operation; absence or `enabled=0` must not silently orphan a live Access policy. A provider/model change
creates a new configuration revision for new attempts; existing runs keep their recorded identity.
Embedding changes use a new index generation. Reuse existing budget/attempt accounting: distinguish
measured API cost, subscription usage and unknown usage; do not fabricate token/cost fields.

For subscription agents without a callable inference API, delivery reuses the existing Research W2
attempt instead of introducing another scheduler. An internal publisher binds one immutable task to the
exact operation/stage, attempt reference, request digest, project and historical service-token grant
revision. The client recovers a bounded lease with `eliotr_task_pull`, appends strict next-cursor progress,
submits an idempotent result callback, and reads cancellation/result status. A stable caller-chosen worker
slot provides lost-ack recovery; independent slots may process distinct tasks. Each lease pins the
credential generation; rotation cannot inherit an unexpired lease. Early replacement, stale authority,
revocation and cancellation fail closed.

New delegated explicit-protocol runs use `research-handlers.exploratory.v8`; the same grant revision must authorize both `run` and `recover`. Stage 8
`ANALYZE_BRANCHES` publishes a provider-neutral task consumable by Spark, Muse, Dot or another computer
agent. The payload contains the frozen question graph and admitted evidence. Callback identity and
selected handles are checked against the exact W2 attempt and re-resolved under current evidence
authority. The server derives the canonical branch checkpoint; the external agent cannot mint a branch
reference, observation reference or authoritative disposition. A strict failed callback becomes explicit
blocked branches with delivery diagnostics left quarantined; it is not permission for a hidden replacement call. The frozen inquiry protocol still declares
`external_acquisition="none"`: browser/app/local-computer discoveries are retained only as
`NOT_ADMITTED` task candidates and cannot enter evidence until a separate ingest/admission flow accepts
them. Owner explicit-protocol runs use deterministic v7; historical generations retain their bytes.

A callback is delivery evidence until the stage-specific consumer validates it. The first handler call
publishes and leaves the W2 attempt STARTED; after `eliotr_task_result`, the originating agent calls the
existing recovery operation. Recovery reads the exact recorded callback and commits through existing
W2/W1 authority. Task deadlines may outlive the original ten-minute W2 reservation, but do not outlive
the exact project grant or current workflow authority. There is no second completion authority.

Discovery and system status share the wired tool set: run/control/ingest are not falsely marked absent,
and disabled Google tools are not advertised. Installed capability, current readiness and a caller's
permission are distinct; Connections should display them separately rather than stop all work.

## 3. Short future notes from the platform review

- **Dot:** expose the same task backend through a small authenticated web inbox because Pro custom MCP is
  read/fetch-only and agent mode does not consume custom apps. Use Dot's cloud computer, optional local
  computer, connected apps, scheduled/proactive work and messaging where the owner enables them; keep
  computer/app permissions separate from ERC project grants. [Dot][dot] / [workspace controls][dot-admin]
  / [MCP availability][openai-mcp]
- **Multi-agent routing:** add an owner-controlled route registry for Spark/Muse/Dot, capability matching,
  explicit failover and parallel independent slots. Do not race agents against the same exclusive lease or
  infer identity from a self-reported contour label.
- **Custom providers:** Cloudflare supports custom HTTPS upstreams and BYOK; add provider-native adapters
  where schemas differ instead of equating all APIs with Chat Completions. Owner-configured endpoints
  are distinct from URLs supplied by retrieved content. [Custom Providers][custom]
- **REST versus routing:** `/ai/run`, Chat Completions, Responses and Messages offer additional transport
  choices. Unified Billing is a separate opt-in, not a way to consume an existing vendor subscription.
  Dynamic routes still use `/compat/chat/completions`; do not blindly replace ERC's working route.
  [REST API, updated September 17][rest] / [dynamic-route exception][compat]
- **Background work:** `/ai/run` supports background callbacks, but webhook delivery is best-effort
  without retries. Reconcile stored job results; a missing callback is not permission for another paid call. [REST API][rest]
- **Muse:** VM, custom API/CLI connectors, browser and scoped/persistent permissions can support regular
  operations, research and debugging. Built-in browser internals and a VM-installed browser harness are
  different capabilities, not a reason to prohibit using Muse. [Meta, September 8][muse]
- **Rust:** a Rust-authored backend remains an option. Preserve pure kernels, isolate platform I/O and
  compare bindings, replay behavior and resources at each migration. Emscripten/Tokio is experimental,
  not prohibited; record compiler/patchset versions and replace TS incrementally. [September 28][rust]
- **Tooling:** use `cf` for discovery/management where useful (beta; Rust builds still use Wrangler),
  Forge for clients/CLI/docs derived from existing contracts, and ADLC tracing to correlate agent,
  model and Research attempts. These are options, not prerequisites to finish the product.
  [cf][cf] / [Forge][forge] / [ADLC][adlc]

Execution stays in [the delivery plan](../implementation/backend-delivery-plan.md): S37 continues;
client/profile work belongs to S10–S13/S29/S98–S99, model adapters to ER-16, Rust to S78–S89.
For external operation and NotebookLM comparisons use the [computer-agent runbook](../implementation/muse-operator-runbook.md).
**Code boundary:** optional-Google launch guard, multi-client Worker verification and Access provisioning,
truthful capability reporting, stdin-only Secrets Store key create/rotation, composed Custom Provider plus
Provider Config attachment, task payload/lease/progress/result/status, and delegated v8 branch-analysis
publication/callback/W2 recovery are implemented, not live-qualified. Managed-OAuth Research delegation,
provider-native inference transports, safe connection removal, owner-selected cross-agent routing, web task
inbox and live Spark/Muse/Dot qualification remain pending.

[dot]: https://help.openai.com/en/articles/20001530-getting-started-with-your-dot
[dot-admin]: https://help.openai.com/en/articles/20001554-manage-dots-in-chatgpt-workspaces
[openai-mcp]: https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
[custom]: https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
[rest]: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
[compat]: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
[muse]: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
[rust]: https://blog.cloudflare.com/rust-workers-emscripten-target/
[cf]: https://blog.cloudflare.com/cloudflare-cf-cli-launch/
[forge]: https://blog.cloudflare.com/forge-open-source-generation-pipeline/
[adlc]: https://blog.cloudflare.com/agent-development-lifecycle/
