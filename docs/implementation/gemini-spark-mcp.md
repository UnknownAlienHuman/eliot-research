# Selected MCP transport and connected-agent boundary

Checked 2026-10-21 against `main@bc78c207`. This owns the selected `gemini-mcp` transport. It is not the old Drive
Exchange product, a generic federation platform, a second backend or a live-qualification diary.

## Product role

MCP exposes a bounded external interface to the existing Eliot application. A verified owner or service client may
use only discovered operations allowed by its current project/task authority. Core services still own sources,
projects, runs, reports, citations, tasks and results.

`GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp` enables the selected MCP/Google candidate contour. It does not enable the
unselected Google Sheet/Drive Exchange OAuth/cursor/freeze/publication system. Current Drive checkpoint documents are
historical and the dormant predecessor remains disabled pending caller/deployment/data inventory.

## One HTTP and authentication boundary

Current source starts at:

- `packages/cloudflare-workspace-mcp/src/gemini-mcp.ts`;
- `gemini-mcp-protocol.ts`, `gemini-mcp-tools.ts` and `gemini-mcp-research-tools.ts`;
- Core `src/index.ts` and `mcp-research-service.ts`;
- Access/runtime reconciliation under `scripts/lib/access-runtime-mcp*.mjs`;
- `apps/eliotr-core/wrangler*.jsonc` and the actual Access provisioner.

The one Core Worker handles `POST https://<exact-mcp-host>/mcp`. The route uses a dedicated Cloudflare Access
audience distinct from the ordinary owner/API audience, rejects browser `Origin`, validates the exact host/path and
never trusts caller identity/profile fields.

The pinned server accepts MCP `2025-06-18` and `2025-03-26`, one JSON-RPC object at a time, a 128 KiB request and a
512 KiB response. It returns JSON, exposes no resources/prompts, emits no SSE/server notifications and allocates no
MCP session/transcript store. These are current code bounds, not a requirement to preserve every old protocol forever.

## Authentication profiles

Runtime source supports:

- **managed-oauth** — the current verified Access user becomes the ordinary owner context; every operation names one
  explicit project and passes the existing owner checks;
- **service-token** — an exact verified Access service-token Client ID maps to a domain-separated service actor;
  project-scoped operations require an owner-issued `client_grant_id`, which is a locator rather than a credential;
- **hybrid** — each verified request resolves to exactly one of the two profiles; owner and service authority never
  merge inside one call.

The verified Access identity supplies principal, credential generation, expiry, issuer/audience and profile. Tool
arguments cannot mint an actor, change profile, select database/provider secrets or bypass current project/grant
checks. The dedicated service-token ID must not authenticate ordinary owner HTTP routes.

## Tool surface

Discovery is profile- and wiring-dependent. Keep one registry for names/schema/dispatch, but presence in that registry
is not product selection or a grant. Expose only operations backed by a current application callback and the verified
profile:

- bounded system status and explicit project catalog;
- selected source/project intake operations;
- selected query/run/status/control operations;
- saved report/section/citation/source reads;
- selected connected/computer-agent task and result operations;
- one optional client diagnostic;
- candidate-only Google plan/readback normalization when `gemini-mcp` is selected.

Research tools delegate to existing Core application services; there is no HTTP loopback, second query engine,
second permission store or MCP-owned report/task state. Managed OAuth uses owner policy. Service tokens use the
existing client-grant/task authority. Tool schemas are input bounds, not authorization.

`eliotr_create_google_sync_plan` and `eliotr_validate_google_sync_receipt` do not execute a Google action or mutate
canonical Eliot state. A normalized receipt records a candidate observation only. Do not present planning, a valid
receipt or a historical diagnostic challenge as continuing client availability or completed Google synchronization.
Remove candidate tools if no selected client/user journey consumes them.

## Effects and recovery

Every mutating operation keeps its existing application identity/idempotency key. After an uncertain response, repeat
only the same operation identity and reconcile through its canonical reader. MCP transport retries are not permission
to allocate another run, upload, project change or task lease.

A tool failure returns a bounded typed error without provider/storage internals. For research/task operations,
`persistence_outcome=UNKNOWN` means callers reconcile; it does not mean safe-to-retry-with-new-identity. Read and
mutation results remain subject to the existing response/body bounds.

The owner-issued client diagnostic proves one past authenticated `/mcp` call. It is not an agent identity, tool grant,
Google action/readback, model qualification or continuing health signal. Keep challenge material out of persistent
browser state and show the observation time.

## Current source defects to repair

These are implementation tasks, not reasons to build another registry:

1. Runtime accepts `hybrid`, but `scripts/lib/access-runtime-mcp-receipt.mjs` and the deployment reconciliation helper
   accept only `service-token | managed-oauth`. Until one shared profile parser/materializer is used by runtime,
   provisioner and receipt readback, hybrid cannot be claimed deployable. Fix the existing caller chain or select one
   supported profile; do not add a parallel deployment profile database.
2. Core `workspaceMcpRuntime().projectCatalog` calls `createManagedOAuthOwnerContext` again after `readCatalog` and
   discards the result. Remove the dead call; current authorization must be performed once at the real boundary, not
   repeated ceremonially.
3. Readiness currently has its own observation-error/schema-missing defect. Repair it under
   [release and schema transitions](production-readiness-plan.md); MCP must not convert an unavailable readiness read
   into proof that migrations are absent.
4. The research tool registry contains a broad historical surface. Trace actual configured clients and selected
   product paths, then remove unselected tools, adapters, tests and configuration with their last caller. Do not keep
   them because discovery/schema tests exist.

## Configuration and live evidence

The canonical Wrangler source currently selects `gemini-mcp` and a service-token profile with placeholder values.
Configuration text, a successful build and a registered tool are not live evidence.

For a named deployed profile, verify at execution time:

- exact target Worker, hostname, Access application/audience and configured actor profile;
- service Client-ID set or managed user identity without exposing secrets;
- actual `initialize → tools/list → selected tool call → canonical readback`;
- project/grant denial and stale/expired credential behavior;
- no cross-audience/browser-origin access;
- no duplicate effect after lost acknowledgement;
- user-visible Connections status that separates configuration, last observation and current task/result state.

Keep private credentials and response bodies out of receipts/logs. Record the exact environment/date and limitations in
the PR or deployment record, not in this implementation contract.

## Client references

Antigravity/Spark setup is a client concern. `integrations/antigravity/README.md` may provide a disabled template, but
it does not establish a safe secret-reference mechanism or authorize deployment. Legacy Gemini CLI extensions and
optional gcloud profiles are not prerequisites. Current provider/client documentation must be checked when an actual
client is configured.

## Completion

Complete the selected contour when one real configured client can authenticate on the dedicated boundary, discover
only its allowed surface, perform the selected owner/task operations through existing application services, reconcile
unknown effects and show honest current/last-observed state. Then delete unused tools, old profile adapters,
status-comment/checkpoint diary text and unselected Drive Exchange code after actual caller/data inventory.

During implementation compile/lint the changed packages and run focused MCP/Access/application tests. Remote Access,
client compatibility and irreversible configuration remain explicit deployment checks. This document does not claim
current live qualification.
