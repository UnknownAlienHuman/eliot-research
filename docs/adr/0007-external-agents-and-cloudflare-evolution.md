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

New delegated explicit-protocol runs use `research-handlers.exploratory.v8`; the same grant revision must authorize `run`, `recover` and `evidence`. Stage 8
`ANALYZE_BRANCHES` publishes a provider-neutral task consumable by Spark, Muse, Dot or another computer
agent. The bounded payload contains the frozen question graph and admitted evidence handles. Larger exact excerpts are reopened through current evidence authority with bounded ranges. Callback identity and
selected handles are checked against the exact W2 attempt and re-resolved under current evidence
authority. The server derives the canonical branch checkpoint; the external agent cannot mint a branch
reference, observation reference, unknown/limitation prose, failed-probe reference or authoritative disposition.
Agent prose remains quarantined in delivery metadata. A strict failed callback becomes explicit
blocked branches with delivery diagnostics left quarantined; it is not permission for a hidden replacement call. The frozen inquiry protocol still declares
`external_acquisition="none"`: browser/app/local-computer discoveries are retained only as
`NOT_ADMITTED` task candidates and cannot enter evidence until a separate ingest/admission flow accepts
them. Owner explicit-protocol runs use deterministic v7; historical generations retain their bytes.

A callback is delivery evidence until the stage-specific consumer validates it. The first handler call
publishes and leaves the W2 attempt STARTED; after `eliotr_task_result`, the originating agent calls the
existing recovery operation. Recovery reads the exact recorded callback and commits through existing
W2/W1 authority. Task deadlines may outlive the original ten-minute W2 reservation, but do not outlive
the exact project grant or current workflow authority. A payload staged before a lost task-publication ACK
can bind the exact task at any later instant before that immutable deadline; replay never extends it. There is
no second completion authority.

Discovery and system status share the wired tool set: run/control/ingest are not falsely marked absent,
and disabled Google tools are not advertised. Installed capability, current readiness and a caller's
permission are distinct; Connections should display them separately rather than stop all work.

## 3. Short future notes from the platform review

- **Dot:** the source-implemented [narrow web inbox](0008-computer-agent-web-inbox.md) exposes the same
  task backend when Pro custom MCP is read/fetch-only or an agent can operate only a UI. It preserves
  Access identity, project grants, leases and W2/W1 settlement; live Access policy, deployment and Dot
  browser qualification remain pending. Use Dot's cloud computer, optional local computer, connected
  apps, scheduled/proactive work and messaging where the owner enables them. [Dot][dot] /
  [workspace controls][dot-admin] / [MCP availability][openai-mcp]
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
provider-native inference transports, safe connection removal, automatic cross-agent failover and live
Spark/Muse/Dot qualification remain pending. Exact owner-selected dispatch is implemented in source, and
the web inbox is implemented under ADR-0008, but Access policy, deployment and real-agent qualification
remain pending.

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

## 4. Computer-agent connection registry

Migration 0087 and the owner-only `/api/v1/system/computer-agents` contour now register each logical
computer agent as append-only revisions bound to one exact Cloudflare Access service-token issuer and
subject. `GEMINI_SPARK`, `META_MUSE`, `OPENAI_DOT` and `OTHER` remain owner-maintained metadata;
a caller is authorized by its verified Access actor, current project grant and declared transport/task
capabilities. Task MCP requires `MCP_WRITE`; the browser inbox requires `WEB_INBOX`. Disabled or missing
connections fail before task lease authority is reached.

The registry and project route are now consumed by an explicit owner-selected dispatch intent. The target
actor still starts its own delegated v8 run under the exact originating grant and qualification; no owner
impersonation or task/lease transfer is introduced. Automatic preferred-agent selection, capability-based
failover and parallel independent task publication remain pending.

## 5. Project route policy and immutable run binding

Migration 0088 adds one owner-controlled append-only route per project/task kind. The current strategy,
`ORIGINATING_MATCH`, stores an ordered list of exact enabled connection revisions. A delegated explicit-
protocol run is admitted only when the verified initiating actor's current connection appears in that
route. Admission records the exact route revision, priority, connection revision and project-grant revision
under the run operation ID. Stage 8 must read the immutable binding before task publication or callback
consumption.

Ordering is now authoritative owner state but does not yet authorize silent delegation. The system does
not start another actor, race two agents for one task, or transfer a lease. Updating or disabling a route
affects new runs; an existing run keeps its recorded route identity, while current connection and project-
grant checks can still block new task access. Automatic preferred-agent dispatch and failover require a
separate owner-delegation protocol.

## 6. Connection qualification and readiness

Migration 0089 binds the existing one-shot MCP diagnostic challenge to one exact connection revision and
`MCP_WRITE` or `WEB_INBOX`. Challenge token generation, SHA-256-only persistence, five-minute issuance,
verified actor/deployment readback and immutable confirmation continue to use the existing diagnostic
protocol. A bound challenge is rejected before consume when the verified Access actor, selected transport,
connection revision or deployment differs.

A confirmed qualification is READY only for the exact credential generation that performed it, while the
connection remains current and enabled, and until the earlier of verified credential expiry or the bounded
freshness window. Task pull/progress/result/status now require READY qualification for the transport actually
used. Qualification does not grant a project, select a route, create a run or transfer a lease. Route priority
can therefore become readiness-aware later without treating configured capability as observed availability.

## 7. Readiness-aware route preview

The owner-only route-readiness endpoint now combines the active ordered route, exact connection revisions,
declared task/transport capabilities, latest exact qualification and current deployment into one read-only
report. Each entry reports connection, capability and qualification state; the first eligible entry becomes
`preferred_ready_connection`. Missing qualification is `UNQUALIFIED`, not inferred READY. Qualification
for another deployment is `STALE`.

This preview is not dispatch. It does not create a run, call an agent, alter a route, confirm a challenge,
move a task or transfer a lease. It makes future preferred-agent selection auditable before any mutation
protocol is introduced.

## 8. Owner-authorized dispatch intent and target acceptance

Migration 0090 adds a separate two-phase delegation receipt instead of letting an owner impersonate a
computer agent. The owner creates one immutable, bounded dispatch for an exact project route revision,
connection revision, transport, project-grant revision, READY qualification observation and explicit v2
Research request. Dispatch expiry is capped at one hour and cannot outlive either the grant or the exact
credential qualification.

The selected agent then pulls and accepts the intent under its own verified Cloudflare Access actor and
credential generation. Acceptance invokes the existing `research.run` service with a deterministic key
derived from the dispatch ID. Existing project sponsorship, scope freezing, v8 handler selection, route
binding and Workflow creation therefore remain the only run authority. The acceptance receipt must join
the resulting workflow and immutable route binding before it can settle.

A route, grant, connection, deployment or qualification change makes an unaccepted dispatch stale. An
accepted run is not moved when policy changes; its existing task publication, callback and recovery rules
still apply and current authority may block later access. Pull does not claim a lease, acceptance does not
reuse another actor's lease, and this checkpoint does not implement silent fallback or cross-agent retry.

## Explicit abandonment and reassignment

A pending exact dispatch may be closed only by an immutable owner abandonment receipt. The owner then
re-reads route readiness and creates a distinct dispatch for the selected READY Spark, Muse, Dot or other
connection. The system does not choose the replacement, reuse the old dispatch identity, transfer a task
or lease, or let an abandoned dispatch be accepted. An accepted dispatch cannot be abandoned; its
existing Research run is controlled through the ordinary status/cancel/recover authority.
