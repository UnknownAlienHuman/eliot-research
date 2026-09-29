# ADR-0007: External operators and qualified Cloudflare evolution

- Date and source check: 2026-09-29.
- Status: accepted architectural direction; integrations and runtime migrations are **not qualified**.
- Repository baseline: `8282bcc818dbaee1003c117b580e74fe90e01abd`.
- Tracking: #301; execution order remains [backend-delivery-plan.md](../implementation/backend-delivery-plan.md).

## 1. Decision and precedence

Add an optional external operator/research/QA role, initially targeting Meta Muse. Reuse ERC's
human UI and authenticated application interfaces. Do not add another backend, Research engine,
source owner, evidence store or durable execution authority.

This ADR narrowly amends [LANGUAGE_RUNTIME_CONTRACT.md](../architecture/LANGUAGE_RUNTIME_CONTRACT.md):

- Sections 0 and 3: read permanent TypeScript platform ownership as the **current production baseline**,
  open to measured, per-capability Rust adapter promotion under a subsequent normative cutover ADR.
  This ADR permits evaluation, not a platform rewrite or production ownership transfer.
- Section 1: its 2026-09-01 platform snapshot is historical; use the dated facts below for this decision.
- Section 11: Python and other external tools may also implement operator-side connectors, analysis
  and QA. They remain outside the deployed Worker. Imported results retain normal admission rules.

The rest of that contract remains binding, especially pure-core isolation, canonical ABI,
versioned behavior, SQL authority, differential conformance and removal of duplicate authority.
[ELIOT_RESEARCH.md](../architecture/ELIOT_RESEARCH.md), ADR-0001/0002/0006 and the selected
`gemini-mcp` Google transport retain their other requirements. Muse is an independent external
client role, **not** a new value of `GOOGLE_EXTERNAL_TRANSPORT` or a replacement for Gemini.

| Area | Decision now | Not authorized by this decision |
|---|---|---|
| Muse | Adopt external operator/QA design; qualify actual account, browser and connector separately | Production owner session, shared Gemini credentials, automatic production mutations |
| ADLC tooling | Use existing runtime with bounded diagnostics and isolated preview acceptance | Replacement CI platform or a parallel agent software factory |
| Rust | Continue deterministic kernel; evaluate an isolated platform adapter when a concrete benefit exists | Whole-backend rewrite, new production service, Emscripten default |
| `cf` | Qualify as optional operator tooling, starting with discovery/readback | Immediate config migration, changed accounts/resources, deployment |
| Forge | Evaluate contract-derived client generation outside runtime | Second schema authority, automatic exposure of internal APIs |

## 2. Dated facts and their limits

Primary sources are linked to the relevant sections. These are vendor statements and source inspection,
not live ERC or account conformance results.

- **Muse, September 8:** [design](https://introducing.muse.ai/) describes a computer, browser,
  code/tools, scheduled and event-driven background work. [Security architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)
  documents custom API/CLI connectors and a brokered browser without agent page-JavaScript, raw DOM
  or DevTools. Secure VM is not the promised Confidential VM; training opt-out is a separate setting.
  Python availability is owner-reported, not verified in this account during this review.
- **ADLC, August 4, not September 28:** the [lifecycle post](https://blog.cloudflare.com/agent-development-lifecycle/)
  presents `@cloudflare/ci`, Workflows-based orchestration, local OpenTelemetry/Agent Traces,
  previews and browser tooling. Availability does not establish zero cost or production authorization.
- **Rust, September 28:** the [Emscripten announcement](https://blog.cloudflare.com/rust-workers-emscripten-target/)
  is an experimental preview with required patchsets in its Tokio examples. JavaScript/Node
  compatibility bridges remain; the host event loop cannot be blocked. The
  [existing Rust Workers guide](https://developers.cloudflare.com/workers/languages/rust/)
  already documents Rust Workers and bindings including D1, R2, Queues and Durable Objects.
- **`cf`, September 28:** the [launch post](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)
  describes open beta, JSON-first discovery and typed configuration. Rust/Python dev and deployment
  still delegate to Wrangler. Wider declarative account configuration is forward-looking; the
  stated 18-month Wrangler maintenance window starts **after beta ends**, not on launch day.
- **Forge, September 28:** the [announcement](https://blog.cloudflare.com/forge-open-source-generation-pipeline/)
  describes Apache-2.0, OpenAPI input and composable generation. Other input formats are future work.
  The [inspected repository README](https://github.com/cloudflare/forge/blob/main/README.md), blob
  `3d499ed6c1c5a1c595db83ed87f1756c16931a01`, includes multi-language workspace wrappers, including
  Rust, and says full standalone TypeScript SDK generation requires Docker. A wrapper is not proof
  of emitted Rust compatibility with ERC or parity with Workers runtime bindings.

A model API, terminal availability, a custom connector or a proactive goal is not proof of a public
Muse agent-control API, MCP compatibility, unrestricted CDP, uptime SLA, unlimited quota or repeatable
execution. Those properties remain unknown until separately observed.

## 3. External agent boundary

```text
Muse browser / VM / custom connector (optional, replaceable)
  -> isolated owner-approved PWA session OR independently authenticated machine interface
  -> existing Access verification + project grant + application authorization
  -> existing ERC services / ResearchWorkflow / receipts / evidence resolution

Muse outputs -> untrusted acquisition or synthesis candidates -> normal ERC admission
Muse observations -> sanitized QA artifacts, never an alternative authority database
```

ERC must keep working when Muse disconnects, is rate-limited, changes models or is unavailable.
An always-on client may observe and request work; existing ERC workflow and receipt identities own
its execution, cancellation, recovery and disposition. Retry a lost acknowledgement by reading the
existing attempt/run first, never by generating a new identity or duplicating a paid effect.

### 3.1 Existing code to reuse, and the identity gap

The checked [MCP runtime](../../packages/cloudflare-workspace-mcp/src/gemini-mcp.ts) currently has
`MCP_LOGICAL_PRINCIPAL = "gemini-spark"`, `requiredServiceTokenClientId()` and
`configuredVerifier()` with one exact service Client ID. Its
[documented contour](../implementation/gemini-spark-mcp.md#runtime-contour) is profile-specific;
managed OAuth does not currently expose the same Research tool set. A browser session is not a
machine credential, and `clientInfo.name` is not verified identity.

Prefer the existing ordinary machine HTTP path for the first custom connector **if its actual
signed principal and owner-issued project grant can be qualified**. Use
[`handleClientGrantHttp()`](../../apps/eliotr-core/src/client-grant-http.ts) and its existing grant
service, never client self-grant. Do not advertise a Muse-ready endpoint before testing that path.

If MCP is required, extend the existing adapter through a separately owned implementation checkpoint:
explicit versioned identity configuration, independently verified principals, grant isolation and
backward compatibility for stored Gemini identities. Do not rename the constant, share a Gemini
secret, widen the issuer/audience allow-list indiscriminately or invent another transport engine.
Reuse [MCP protocol dispatch](../../packages/cloudflare-workspace-mcp/src/gemini-mcp-protocol.ts),
configured tool discovery and the existing [client connection check](../implementation/gemini-spark-mcp.md#client-connection-check).
A successful challenge proves a past call, not current authority or vendor/model identity.

### 3.2 Permissions and disclosure

Start with public/synthetic data and a dedicated staging environment. A browser logged into the
owner PWA has the owner's effective rights: a prompt saying “read only” does not restrict them.
Do not give unattended Muse a production owner session or Cloudflare administration, D1/R2, Google
account-wide or deployment credentials. Use the narrowest supported host/project/action/expiry and
verify credential handling for the **custom** connector, not only Meta's built-in connectors.

Separate discovery/status, authorized search/report reads, candidate submission and research execution.
Do not classify by HTTP verb or MCP annotations alone: search/query can create bookkeeping state or
incur provider work. Paid execution requires existing spend authority, cancellation and idempotency.
Do not automatically promote imported drafts, execute instructions inside sources, or change grants.

Confirm owner-approved disclosure to both inference and storage providers before any private corpus
leaves ERC. Verify the account's training/privacy settings; do not equate an opt-out with no processing.
Logs, screenshots, tokens, signed URLs and source text must not be copied into public issues or this
repository. Apply existing residency, retention and erasure rules to authorized stored artifacts.

## 4. Muse-assisted debugging and NotebookLM comparison

Use the [operator runbook](../implementation/muse-operator-runbook.md) for concrete inputs and outputs.
Muse is a user-journey observer and candidate researcher, not the sole judge of its own answers.
Its brokered browser cannot replace instrumentation requiring DOM geometry, page JavaScript or CDP.
Keep Playwright/workerd/native acceptance; a separate VM-installed browser harness is another
capability to qualify, not something assumed from “Muse has a browser.”

Compare the products on the same frozen, authorized source bytes and explicit tasks. Keep separate
tracks for closed-corpus retrieval, research with additional acquisition, and human usability. Record
unsupported input formats, ingestion losses, product-version unknowns, retries and truncation instead
of silently modifying one competitor's workload. Ground scoring in source locations and independent
review. No score or superiority claim is authorized until recorded runs exist.

Reproduce observed ERC defects at an exact code/deployment SHA with existing fixtures. For Windows
layout defects (#298/#305), a remote Linux browser is supporting evidence, not Windows acceptance.
Local integration remains S92 before S94 staging; S93 quality and S95/S96 conformance/cost follow the
attested build. This optional client does not become a new release blocker for unrelated code.

## 5. ADLC: diagnostics rather than another orchestrator

Adopt a bounded trace correlation design on existing request/run/stage/attempt identities and deployment
versions. Record durations, typed outcomes, retries, resource measurements and sanitized provider-call
metadata; not prompts, corpus bytes, credentials or sensitive URLs. Trace sampling/retention must be
bounded. Missing or sampled telemetry means unknown observation, not proof that no effect happened.
D1 receipts and authorized exact evidence remain authoritative.

Use local tools and, when explicitly authorized, access-protected previews with isolated D1/R2/queues,
separate callbacks and mocked or explicitly budgeted providers. Never attach production remote bindings
by default. Check environment separation before running a browser or agent against a preview.
Do not add `@cloudflare/ci`, containers or a persistent agent factory merely to use tracing; keep
current manual-only GitHub Actions and the existing assembly/acceptance sequence. Any billable service,
remote binding, trace exporter or deployment requires separate scope/cost approval.

## 6. Rust: three distinct decisions

1. **Pure kernel:** continue S78–S89 and existing native/Wasm promotion. Keep canonical byte ABI,
   explicit observed state, no runtime I/O and no duplicate authority. Emscripten is not a prerequisite.
2. **Rust platform adapter:** evaluate `workers-rs` on `wasm32-unknown-unknown` first when it can remove
   a concrete integration burden or improve a measured property. Isolate runtime I/O outside pure
   crates. Start with one bounded side-effect-free adapter probe, not a tree-wide rewrite.
3. **Emscripten/Tokio:** select only for a demonstrated dependency/capability that the simpler target
   cannot provide economically. Pin all compiler/linker/patchset versions, document host-event-loop
   assumptions and rollback, and prove workerd behavior. No implicit threads, local durable filesystem,
   embedded authority database or native process is allowed by the preview.

Before any production adapter promotion, record this ERC-specific matrix, not just Hello World:

| Surface | Required proof |
|---|---|
| D1/SQL | Installed depth-100 constraints, transactions, generation fences, stale CAS, conflict/replay/readback |
| R2 and queues | Bounded streams/ranges/conditional writes; outbox identities, ACK/lost-ACK/retry/DLQ semantics |
| DO and Workflows | Existing class names/migrations/storage; restart/concurrency and stored v5/v6/v7 research semantics |
| Access, HTTP and MCP | Issuer/audience/expiry/grant isolation, body limits, canonical error/receipt compatibility |
| AI Search/Workers AI/Gateway | Every actually used binding, options, cancellation and paid-attempt accounting |
| Resources and operation | Native/Wasm/workerd conformance, emitted size/startup/memory/CPU, diagnostics and rollback |

Unknown cells remain pending; they are not automatically unsupported. Prove feature and behavior
parity plus a maintainability, correctness or measured resource benefit. Production promotion needs
its own owned packet/cutover ADR, exact receipts and one active owner per capability. Shadow mode
must not issue duplicate external effects. Preserve rollback and remove superseded TS authority only
after the existing removal gates. PWA, SQL and generated JavaScript/tooling are separate decisions:
“Rust-authored backend” does not mean a platform with no JavaScript or SQL.

## 7. cf and Forge adoption gates

For `cf`, first qualify a pinned package/version in an isolated tool environment: command discovery,
exact account/resource selection, authorization and redacted readback. Do not assume an existing
browser login or broad token supplies appropriate CLI permissions. A future `cf migrate` trial must
compare resolved bindings, environments, routes, compatibility flags/date, DO class/migration names,
Workflows, queue/DLQ configuration and static assets with the current Wrangler configuration. Preserve
a tested rollback and the frozen build until parity is established; no mass config or lockfile edit now.

For Forge, start with one allow-listed, already implemented, bounded read operation. The source of
truth stays the strict/versioned [contract family](../agent-work/ER-01-versioned-contracts-and-schemas.md),
not a parallel hand-maintained OpenAPI file. Derive a restricted OpenAPI view, generate a client/docs
surface, and compare it with existing HTTP/MCP dispatch and negative fixtures. Preserve unknown-field,
size/precision, error, scope, version and cancellation semantics; generated code is not authorization.
Record the input digest, generator version, overlays, output hashes and reproducibility check.
Verify Docker/toolchain feasibility in a disposable supported build environment; do not weaken Muse's
isolation or install a privileged daemon to make a generator work. Add no generator to the Worker.

## 8. Delivery mapping and remaining work

This is not a competing queue. Attach additions only when the existing owning checkpoint is selected:

| Existing area | Bounded addition | Completion evidence |
|---|---|---|
| S10–S13/S98–S99; ER-17/ER-21/ER-36 | Independently scoped Muse HTTP connector; MCP identity extension only if needed | Wrong client/project/audience and revoked/expired grant denied; no token or source leak |
| S73–S77, S92–S95; ER-23/ER-25/ER-27 | Operator fixtures, replayable UX defects and paired comparison manifests | Exact build/corpus/task/artifact refs; independent source-grounded scores; Windows cases separately qualified |
| S90/S96; ER-17/ER-24/ER-26 | Correlated redacted diagnostics; isolated preview and CLI qualification | No production bindings; measured resources/cost; deterministic config comparison |
| S78–S89; ER-00/ER-40 with explicit adapter ownership | Continue kernel; optional bounded Rust-target probe | No ABI drift or duplicate effects; all applicable matrix cells measured before cutover |
| ER-01 with interface/tooling owners | Optional contract-derived Forge client probe | Reproducible hashes, strict schema parity, no internal/admin endpoint exposure |

Do not change shared files without their named integrator ownership. No new runtime state enum,
client whitelist, wire schema or environment value is installed by this document.

**Delivered here:** design decisions, source review and operator procedure only.
**Pending:** actual Muse account/runtime/auth qualification, connector implementation, benchmark runs,
trace/config/generator prototypes and Rust adapter measurements. No production capability is promoted.
**Unchanged:** S37/#229 remains the active code checkpoint; broad acceptance follows code assembly.
