# Cloudflare MCP authentication, transport and effect sweep

**Reviewed:** 2026-10-24. **Branch baseline:**
[`4ce8ee2d`](https://github.com/UnknownAlienHuman/eliot-research/tree/4ce8ee2dd3dd86f20b2b831bac8e1702d4f611f4).

This continuation checks MCP 2026-07-28 support, the exact selected `agents 0.30.1` server/client implementation,
Cloudflare Access Managed OAuth, Workers OAuth Provider v1, Cloudflare's managed MCP servers, portals, step-up,
elicitation and experimental events against Eliot's incoming and outgoing tool contract. It separates connection recovery
from authorization and external-effect recovery. It is source review, not an OAuth grant, MCP connection or tool call.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 145 | New MCP servers use MCP SDK v2 and `createMcpHandler(factory)`. Every request gets a fresh `McpServer`; `McpAgent` and the SDK v1 server overload are deprecated/feature-frozen. The stateless handler has no MCP session, protocol Durable Object or WebSocket. Durable state must live behind authenticated D1/DO/R2/KV/application calls. | Eliot serves one module-scoped handler whose factory registers only the current request's tools/resources/prompts. No MCP session store, SSE compatibility DO or `McpAgent` is added. Tools call the same product functions and D1/R2/effect writers as UI/API. The exact `@modelcontextprotocol/server 2.3.1` peer is pinned with `agents`; generated types and `nodejs_compat` are compiled in stage 0. |
| 146 | Cloudflare product MCP servers now serve only `/mcp`; `/sse` returns `410 Gone`. The v2 handler can accept 2026-07-28 Stateless clients and, in `legacy: "stateless"`, earlier 2025 Streamable HTTP clients on that same endpoint. Legacy compatibility still has no session ID, GET/DELETE lifecycle, replay/resume or pushed sampling/roots/elicitation. | Eliot exposes only authenticated `POST /mcp`; there is no `/sse` route or standalone SSE transport. Begin with explicitly configured stateless 2025 compatibility only for a named tested client matrix, never session semantics. Record protocol generation per request. Move to `legacy: "reject"` when supported clients are verified; do not retain compatibility indefinitely by assumption. |
| 147 | `createMcpHandler` validates present browser Origins, but non-browser requests may omit Origin. A custom-domain/wildcard deployment needs explicit `allowedHostnames` and `allowedOriginHostnames`; `allowedOriginHostnames:"*"` disables even malformed/opaque-origin rejection. The handler does not infer a safe custom-domain allowlist. | Configure the exact MCP hostname and browser origin list; reject other Host values before product routing. Never use wildcard Origin bypass. Origin is browser-request validation, not identity. Access/Managed OAuth authentication and server-created actor/project scope still run for every tool/resource/prompt operation, including origin-less clients. |
| 148 | Access Managed OAuth is an opt-in OAuth transport for non-browser clients to an Access application and enforces the same Access policies as browser login. The MCP handler can receive sanitized application auth context; standard MCP `AuthInfo` may contain bearer tokens and extra provider properties that must not be logged or returned. Workers OAuth Provider v1 is a separate option when an application must issue resource/audience/scoped tokens itself. | Keep Eliot's selected incoming hostname behind Access Managed OAuth and validate the Access token/assertion at ingress with `jose`. Build a minimal immutable actor context server-side and pass only opaque actor/grant IDs to product functions. Never place bearer tokens, Access assertions, `AuthInfo.token` or provider extras in logs, D1, chat, tool output or export. Do not add a second OAuth issuer unless a concrete missing audience/scope operation requires it. |
| 149 | Stateless MCP requests cannot hold a Worker while a user responds or a long operation runs. Stateful server-to-client requests, session deletion and replay are unavailable in the selected handler. JSON response shaping can also omit notifications emitted before the final result. Handler notifications are isolate-local and do not reach clients attached to another Worker isolate. | Incoming tools are bounded request/response operations. Long work returns an Eliot job ID after D1 admission and is observed through explicit status/result tools or normal UI, not MCP notifications/session replay. Do not use list-change notifications as product progress or invalidation authority. Tool registration is deterministic from deployed code/current authorization rather than runtime mutable session state. |
| 150 | Stateless elicitation returns `input_required`; the client collects input and retries through SDK-managed MRTR state, so the Worker is not retained. On the outgoing client, elicitation handlers and pending interactive calls are memory-only: hibernation/restart does not preserve the in-flight call and the caller must retry. Form mode is intended for non-sensitive structured data; URL mode is for out-of-band consent/auth/payment. | Initial Eliot incoming/outgoing MCP disables elicitation capabilities. Product approvals and missing parameters use existing retained UI/task/chat state. A future bounded integration may use URL mode only after explicit owner consent or form mode for non-secret data; it stores an Eliot operation ID before prompting. Restart/hibernation settles the tool attempt interrupted rather than silently recreating a consent flow. Never collect credentials or secret values through MCP form elicitation. |
| 151 | `MCPClientManager` persists registered servers, OAuth tokens/options and reconnect settings in its Durable Object and restores connections after wake. Connection state progresses through authenticating/connecting/connected/discovering/ready/failed. `waitForConnections()` only waits for in-flight connection/discovery work and may time out; a restored catalog can differ from the previously selected one. | Use one owner Tool Connection Agent for transport reuse, but keep canonical connection metadata, enabled status, owner decision, selected-tool digest and last verified catalog in D1. A turn can use only explicitly selected servers in `ready` state after a bounded wait. Timeout, failed auth or changed catalog fails before inference/tool execution; it never silently removes tools and answers a different task. |
| 152 | `addMcpServer()` is idempotent only when normalized name and URL both match. The same name with a different URL creates a second active connection and merges both catalogs. Removing a server closes/removes local persisted state, but provider-side authorization/revocation remains an external lifecycle concern. | Eliot assigns a stable opaque connection ID and canonical HTTPS endpoint in D1. Endpoint replacement is an owner operation: disable admission, remove old connection, verify local cleanup/provider revocation where supported, then add and verify the replacement. Never call `addMcpServer()` from untrusted request data or accept same-name endpoint drift. Disconnect/revocation outcomes remain visible and old selected-tool digests are invalidated. |
| 153 | The selected client blocks malformed URLs, literal private/link-local/ULA/unspecified addresses and known metadata endpoints, but deliberately allows loopback for development. This parser-level check is not a complete owner trust policy for arbitrary hostnames, redirects, DNS changes or credential destination. | Only the owner can register an MCP endpoint. Require HTTPS, an explicit reviewed hostname/endpoint, a non-production loopback profile for local fixtures only, and the existing stronger-egress/DNS-rebinding policy when arbitrary public endpoints are ever needed. Headers/credentials are scoped to the exact connection and never forwarded by a generic proxy. SDK URL checks are defense in depth, not admission proof. |
| 154 | OAuth callback URLs normally include Agent class/instance identity. When `sendIdentityOnConnect:false` hides sensitive instance names, the SDK requires a custom callback path; callback matching now uses the OAuth state and exact origin/path rather than a loose `/callback` substring. OAuth tokens persist across restarts. | Set `sendIdentityOnConnect:false` for the Tool Connection Agent and route one fixed callback path through current authenticated owner state to the exact connection agent. Use exact public callback origin/path from configuration, PKCE/state validation and no client-supplied instance name. OAuth success updates D1 connection status only after the server reaches `ready`; failure remains owner-visible. Token material stays in the connection DO only. |
| 155 | The Cloudflare API MCP server supports minimal initial scopes and MCP step-up: a tool can return `insufficient_scope` naming required scopes, and supporting clients can request additional owner consent while preserving existing grants. Client support is not universal. | Connect with minimal/read scopes. An insufficient-scope result becomes a retained owner-visible `needs_scope` state naming server, tool and requested scopes; no agent auto-approves or widens authorization. After consent and catalog revalidation, the owner retries under the same logical effect identity. Unsupported clients receive an actionable failure, not a broad pre-grant or hidden fallback token. |
| 156 | `getAITools()` namespaces tools by normalized server ID and tool name and converts JSON Schema to Zod. Conversion failures skip a tool. Catalog replacement/reconnect invalidates converted schemas. Reading tools before `ready` can return a missing/incomplete catalog. Raw prompts/resources/tool descriptions remain server-controlled content. | Freeze a server-selected allowlist and digest from a verified `ready` catalog. Model tools are generated only for the chosen connection IDs/tool names and matched against that digest at execution. A missing/schema-changed tool blocks the turn for re-selection; it does not disappear silently. Descriptions, prompts, resources and schemas are untrusted data, never system policy, authorization or evidence without capture/validation. |
| 157 | Connection/reconnection retry settings cover transport establishment and discovery, not exactly-once external tool effects. `callTool()` forwards request options such as timeout/abort to the MCP client, but a timeout, disconnect, hibernation or cancelled elicitation may occur after a remote mutation. Automatic connection restoration cannot determine the external outcome. | Every mutating call first writes an Eliot effect intent with stable effect ID, actor/project/connection/tool digest and bounded args. Timeout/disconnect/cancel yields `unknown`, never blind tool retry. Retry requires tool-specific idempotency/reconciliation or owner decision and uses the same effect identity. Connection retry may restore availability only; it never replays a tool call. Read-only calls may use bounded retry after classification. |
| 158 | MCP server capabilities and tools can change after reconnect; `getAITools()` rebuilds closures/catalog records and schema conversion cache follows the live catalog. Connection state broadcasts are operational and may replay around hibernation. | Store catalog fingerprint, protocol version and verification timestamp with each selected connection. Product/chat state refers to the stable selected-tool digest, not a live unconstrained `getAITools()` set. Reconnect/catalog change marks dependent drafts/turns stale until revalidated. UI connection events update a view but do not create duplicate product activity or imply authorization. |
| 159 | MCP server portals are GA and can aggregate approved upstream servers, route traffic through Gateway and expose context optimizations. `search_and_execute` hides upstream tools behind a generic `query`/`execute` pair. Service-token sessions can use admin credentials with full access to every linked upstream server authorized for that token, without per-user OAuth. | Do not select a portal or generic `execute` for initial Eliot. It obscures the exact selected tool/permission boundary and can turn one service token into broad mutable authority. A future portal is one explicitly reviewed connection for a named need, keeps per-user authorization where possible, exposes a bounded allowlist/digest and still uses Eliot approvals/effect ledger. Portal logs remain operational evidence, not effect truth. |
| 160 | MCP Events/webhooks and Skills-over-MCP are new/experimental extension surfaces. Cloudflare Issues events require broad Notifications Write plus Workers Observability Write and deliver signed webhooks. Skills are remote instructions/files, not trusted executable policy. | Keep MCP Events and remote Skills disabled initially. If a named incident workflow later adopts Events, verify signature, deduplicate event ID, scope to one replacement Worker and allow investigation/PR only—never deployment or product mutation. Skills/resources may be captured as untrusted reference material after license/provenance review; they are never auto-installed, executed or merged into system instructions. |

## Selected MCP profile

```text
incoming transport = POST /mcp only
incoming server = MCP SDK v2 factory + createMcpHandler; fresh server per request
incoming compatibility = stateless 2025 lane only for named tested clients; no /sse/session semantics
incoming auth = Access Managed OAuth + verified server-created actor context
incoming long work = admit D1 job, return handle, poll/read result
incoming notifications/elicitation = not product authority; elicitation disabled initially

outgoing runtime = one owner Tool Connection Agent using MCPClientManager
connection authority = D1 owner-approved connection + selected-tool digest
connection state required = ready after bounded wait
endpoint = exact reviewed HTTPS URL; no agent/client arbitrary registration
OAuth callback = fixed path, hidden instance identity, state/PKCE validated
OAuth scope = minimal; step-up explicit owner consent
catalog = untrusted, fingerprinted and allowlisted
mutating call = D1 effect intent before call; timeout/disconnect = unknown, no blind retry
connection retry = transport only, never tool replay
portals/events/skills = disabled initially
```

## Required implementation checks

```text
compile exact agents + MCP client/server 2.3.1 peers
serve concurrent requests from fresh MCP server factories
verify /sse=404/410-equivalent product absence and only /mcp is routed
exercise stateless 2026 and named 2025 clients without session IDs/GET/DELETE/replay
reject wrong Host, malformed/opaque Origin and wildcard bypass
verify Access OAuth actor derivation for origin-less and browser clients without token logging
return a long job handle and reopen status/result without notifications
prove elicitation is not advertised initially
register one reviewed outgoing server, hibernate/reconnect and require ready catalog
replace same-name endpoint without leaving both connections active
reject literal private URL and unapproved public hostname/loopback outside fixture profile
complete OAuth on fixed callback path with hidden instance identity
exercise insufficient_scope with approval, unsupported client and no broad pre-grant
change/remove a tool/schema and invalidate selected-tool digest before inference/execution
interrupt a mutating tool after remote receipt and keep effect unknown without replay
prove catalog/state reconnect events do not duplicate product activity
verify portals, Events and remote Skills are absent from initial runtime/config
```

## Primary sources

- [`agents 0.30.1` MCP server guide](https://github.com/cloudflare/agents/blob/agents%400.30.1/docs/agents/mcp-servers.md),
  [client guide](https://github.com/cloudflare/agents/blob/agents%400.30.1/docs/agents/mcp-client.md) and
  [exact client manager source](https://github.com/cloudflare/agents/blob/agents%400.30.1/packages/agents/src/mcp/client/index.ts).
- [Current handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/),
  [client API](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/) and
  [SDK v2 migration](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/).
- [MCP 2026-07-28 Agents release](https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/),
  [Cloudflare stateless servers](https://developers.cloudflare.com/changelog/post/2026-07-28-cloudflare-mcp-servers-mcp-2026-07-28/) and
  [`/sse` retirement](https://developers.cloudflare.com/changelog/post/2026-10-22-cloudflare-mcp-servers-retire-sse/).
- [Access Managed OAuth](https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/),
  [Workers OAuth Provider v1](https://developers.cloudflare.com/changelog/post/2026-10-01-workers-oauth-provider-1x/) and
  [Cloudflare API MCP step-up](https://developers.cloudflare.com/changelog/post/2026-10-19-cloudflare-mcp-step-up/).
- [Client elicitation](https://developers.cloudflare.com/changelog/post/2026-07-13-mcp-client-elicitation/) and
  [OAuth client guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/oauth-mcp-client/).
- [MCP portals GA](https://developers.cloudflare.com/changelog/post/2026-09-24-mcp-portals-ga/),
  [portal service tokens](https://developers.cloudflare.com/changelog/post/2026-06-26-mcp-portal-service-tokens/) and
  [MCP Events](https://developers.cloudflare.com/changelog/post/2026-10-13-cloudflare-mcp-events/).

## Verification boundary

The current official MCP server/client/auth/portal documentation, full relevant changelog entries and exact selected
`agents 0.30.1` guides/client-manager source were inspected. No MCP handler, Access application, OAuth provider, portal,
connection, callback, step-up flow, elicitation, event subscription, skill or tool call was configured or exercised. No
unknown-effect reconciliation, hibernation reconnect, catalog drift or client compatibility test was run. Those checks
remain owned by stage 0 and the incoming/outgoing MCP verticals.