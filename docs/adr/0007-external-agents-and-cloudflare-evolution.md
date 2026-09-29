# ADR-0007: Replaceable external models, agents and Cloudflare adapters

**Accepted, revised 2026-09-29.** Source/code review: `aebb8ccaf0b2b95358073d62fc278335a8a29188`.
This revision replaces the earlier staging-only/operator restrictions. It amends ADR-0006's mandatory
client selection and LANGUAGE_RUNTIME_CONTRACT §§0/3/11: providers and clients are replaceable;
TypeScript is the current platform implementation, not a permanent requirement; external Python/tools
may serve research, connectors and operations. Pure-kernel determinism and ERC evidence/state ownership remain.

## 1. Independent connections, not a preferred-vendor architecture

**Muse may completely replace Spark as the external agent.** Spark, Antigravity and Google integrations
are optional. No fallback to Google is mandatory. Adding a compatible provider/client is configuration
or adapter work, not a new architectural approval process.

| Connection | Required design |
|---|---|
| Model inference | Provider/model ID, endpoint/protocol, credential reference, capabilities and role bindings; Gateway/BYOK, direct provider API or reachable self-hosted service. |
| External agent | Muse or another harness via supported HTTP/MCP/CLI/browser; independent identity, available tools and task/result interface. A subscription agent need not expose a model API. |
| External tools | Google, browser, storage and other connectors selected independently of agent and inference provider; unused integrations add no product-readiness requirement. |

The owner chooses read/write/research/publication/administration permissions, data scope and automation
level, including production operation. There is no blanket read-only, QA-only, staging-only or vendor-based
ban. Existing authentication, secret handling, evidence verification and task budgets apply equally.
Reuse approved task/session permissions rather than adding confirmation before every routine operation.
Capability gaps affect the relevant operation, not all work by that client. Model capabilities and
harness capabilities are recorded separately; neither implies the other.

## 2. Existing code and concrete follow-through

| Area | Reuse/change |
|---|---|
| Inference | Reuse `packages/research/src/ports.ts::ModelRoutePort` and `packages/platform-cloudflare/src/model-gateway.ts`. The ten `dynamic/eliotr-*` names are application roles, not ten permitted vendors. Provider/model fingerprints are already strings. |
| Additional transports | Extend `packages/cloudflare-ai/src/model-gateway-http-request.ts` and the adapter behind `ModelRoutePort` for direct/provider-native APIs; preserve request/result schemas, actual model provenance and existing attempt/output receipts. Present Gateway-only execution is not universal transport support. |
| External clients | `mcp-service-clients.ts` parses `MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS`; `gemini-mcp.ts` and Core env/index accept independent verified clients. New actors bind issuer/audience/Client ID; the optional legacy singleton preserves `gemini-spark`. Existing project grants still use the actual signed Client ID. |
| Google optionality | `scripts/check-launch-code.mjs::launchCodeBlockers` must accept explicit `disabled`; selected Google profiles still require their own implementation. Keep deployment config and `implementation-status.json.release_profile` consistent. Current selected config is not changed by this ADR. |

Connections should allow enabling/disabling clients, testing each connection, selecting models per role
and configuring fallbacks without code edits for each vendor. A provider/model change creates a new
configuration revision for new attempts; existing runs keep their recorded identity. Embedding changes
use a new index generation. Reuse existing budget/attempt accounting: distinguish measured API cost,
subscription usage and unknown usage; do not force agent results into fabricated token/cost fields.

For subscription agents without a callable inference API, support client-initiated work and later a
pull-task/result callback adapter over existing Research jobs. Carry job/attempt IDs through reconnect,
progress, cancellation and result readback. This adapter is planned, not implemented by this document.

Single-client descriptions in ER-36 and `gemini-spark-mcp.md` now describe only the legacy configuration.
Discovery and system status share the wired tool set: run/control/ingest are not falsely marked absent,
and disabled Google tools are not advertised. Installed capability, current readiness and a caller's
permission are distinct; Connections should display them separately rather than stop all work.

## 3. Short future notes from the platform review

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
For external operation and NotebookLM comparisons use the [short runbook](../implementation/muse-operator-runbook.md).
**Code boundary:** optional-Google launch guard, multi-client service-token MCP and truthful capability
reporting are implemented, not live-qualified. Automated multi-client Access provisioning, managed-OAuth
Research delegation, additional inference transports, external task adapter and live Muse remain pending.

[custom]: https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/
[rest]: https://developers.cloudflare.com/ai-gateway/usage/rest-api/
[compat]: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
[muse]: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse
[rust]: https://blog.cloudflare.com/rust-workers-emscripten-target/
[cf]: https://blog.cloudflare.com/cloudflare-cf-cli-launch/
[forge]: https://blog.cloudflare.com/forge-open-source-generation-pipeline/
[adlc]: https://blog.cloudflare.com/agent-development-lifecycle/
