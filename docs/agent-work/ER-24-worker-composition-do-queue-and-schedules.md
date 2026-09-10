# ER-24: Worker composition DO Queue schedules and MCP transport

**Slice:** 0
**Depends on:** ER-13, ER-15, ER-17, ER-21
**Live gate:** deployed Access/HTTP/MCP/Queue/D1/DO smoke; otherwise NOT EXECUTED

## Objective

Compose implemented ports in the single Worker while keeping unsupported capabilities mechanically
fail-closed. The Worker is a composition and transport boundary, not a second domain layer.

## Owned paths

- `apps/eliotr-core/src/env.ts`
- `apps/eliotr-core/src/index.ts`
- `apps/eliotr-core/src/http.ts`
- `apps/eliotr-core/src/http-errors.ts`
- `apps/eliotr-core/src/artifact-draft-http.ts`
- `apps/eliotr-core/src/research-query-http.ts`
- `apps/eliotr-core/src/queue.ts`
- `apps/eliotr-core/src/scheduled.ts`
- `apps/eliotr-core/src/readiness.ts`
- `apps/eliotr-core/src/research-session.ts`
- `apps/eliotr-core/test/research-run-status.test.ts`
- `apps/eliotr-core/src/research-stage-handlers.ts`
- `apps/eliotr-core/src/research-retrieve-branches.ts`
- `apps/eliotr-core/src/research-retrieval-composition.ts`
- `apps/eliotr-core/src/exhaustive-query-service.ts`
- `apps/eliotr-core/src/exhaustive-workflow-service.ts`
- `apps/eliotr-core/test/research-query-jobs.test.ts`
- `apps/eliotr-core/wrangler.jsonc`
- `packages/cloudflare-navigation/src/index.ts`
- `packages/cloudflare-navigation/src/orientation-authority.ts`
- `packages/cloudflare-navigation/src/orientation-currentness.test.ts`
- `packages/cloudflare-navigation/src/orientation-currentness.ts`
- `packages/cloudflare-navigation/src/orientation-input.ts`
- `packages/cloudflare-navigation/src/orientation-materialization.ts`
- `packages/cloudflare-navigation/src/orientation-service.ts`
- `packages/cloudflare-navigation/src/orientation-storage.ts`
- `apps/eliotr-core/test/orientation-boundaries.test.ts`
- `apps/eliotr-core/test/orientation-fixture.ts`
- `apps/eliotr-core/test/orientation-http.test.ts`
- `apps/eliotr-core/test/orientation-resilience.test.ts`
- `apps/eliotr-core/vitest.config.ts`
- `apps/eliotr-core/src/catalog-service.ts`
- `apps/eliotr-core/src/catalog-service.test.ts`
- `apps/eliotr-core/src/catalog-queries.ts`
- `apps/eliotr-core/test/catalog-http.test.ts`
- `apps/eliotr-core/src/source-revisions.ts`
- `apps/eliotr-core/test/source-revisions.test.ts`
- `apps/eliotr-core/src/library-readiness.ts`
- `apps/eliotr-core/test/library-readiness.test.ts`
- `apps/eliotr-core/src/google-token-store.ts`
- `packages/google-drive-exchange/src/google-token-store.ts`
- `apps/eliotr-core/test/google-token-store.test.ts`
- `apps/eliotr-core/src/google-oauth-store.ts`
- `packages/google-drive-exchange/src/google-oauth-store.ts`
- `apps/eliotr-core/src/google-oauth-service.ts`
- `apps/eliotr-core/src/google-oauth-begin.ts`
- `apps/eliotr-core/src/google-oauth-callback.ts`
- `apps/eliotr-core/test/google-oauth-admission.test.ts`
- `apps/eliotr-core/test/retrieval-ident-lex.test.ts`
- `apps/eliotr-core/test/retrieval-q1-fixture.ts`
- `apps/eliotr-core/test/raw-capture-http.test.ts`
- `apps/eliotr-core/test/retrieval-generation-fences.test.ts`
- `apps/eliotr-core/src/exhaustive-query-service.test.ts`
- `apps/eliotr-core/test/research-query-exhaustive.test.ts`
- `apps/eliotr-core/test/exhaustive-workflow-output.test.ts`
- `packages/cloudflare-navigation/src/exhaustive-query-service.ts`
- `packages/cloudflare-navigation/src/exhaustive-workflow-binding.ts`
- `packages/cloudflare-navigation/src/exhaustive-workflow-output.ts`
- `packages/cloudflare-navigation/src/exhaustive-workflow-service.ts`

ER-09 exclusively owns `apps/eliotr-core/src/research-workflow.ts`; ER-24 may compose its exported
boundary but does not edit or reimplement that workflow authority.

ER-38 owns the projection runtime package. The known-length R2 stream repair is contributed through
a reviewed ER-38 integration handoff; ER-24 retains the actual owner-loop acceptance boundary.

ER-36 owns the Google transport profile selection and legacy OAuth route gating. ER-24 retains the
underlying OAuth service and storage authority. ER-36 is also the canonical owner of the shared
`composition-root.ts` and `index.test.ts` integration files; ER-24 contributes through the reviewed
integration handoff without claiming those paths.

## Implemented HTTP contour

```text
request
→ exact route/method match
→ route byte/query contract
→ signed Cloudflare Access JWT verification
→ owner/service principal-class authorization
→ typed AuthenticatedRequestContext
→ exact D1 schema-generation readiness
→ bounded application dispatch
→ bounded JSON response or typed problem
```

## Implemented Gemini MCP contour

```text
POST /mcp
→ hostname Cloudflare Access
→ explicit service-token or managed-oauth profile
→ signed Access JWT verification with the dedicated MCP audience
→ exact signed service-token Client ID or verified human actor
→ profile-bound internal principal
→ MCP protocol/header/body validation
→ four-tool product allow-list
→ bounded JSON-RPC response
```

The Access service-token name is not a signed identity. In the `service-token` profile, the exact
configured Client ID must match signed `common_name` before mapping to `gemini-spark`.
The `managed-oauth` profile instead requires a verified human JWT with a dedicated MCP audience and
derives a domain-separated actor reference. Service-token credentials, mixed configuration and an
ordinary owner audience cannot substitute for that profile. Deployed OAuth client qualification
remains separate from local JWT verification.

ELIOT MCP is plan/readback-validation only. The selected Workspace client performs Google-side actions
through its connected Drive/Workspace tools, obtains explicit user authorization for mutations, and
reads back the exact result. Google Cloud/gcloud is an unselected optional profile. A Google receipt
never promotes itself into canonical ELIOT state.

## Implemented delivery contour

```text
scheduled event
→ bounded D1 outbox claim
→ stable Queue message
→ producer settlement

Queue delivery
→ strict envelope
→ D1 inbox fence
→ D1 intent/outbox/source authority reload
→ one durable projection job ACCEPTED receipt
→ fenced projection execution and exact terminal readback (or retry on failure)
→ inbox settlement
→ ACK
```

`PROJECTION_QUEUED` and `ACCEPTED` mean only that durable work exists. The composed executor builds
projection items, persists and reads back D1 Search state, handles the configured managed index and
updates channel readiness before returning a terminal receipt. Its real owner-loop qualification
must exercise the production R2 stream boundary; a fixture that buffers a stream before `put` cannot
prove that boundary. Already bounded projection bytes must retain their known length when converted
to an R2 upload stream, while exact size, digest and immutable readback checks remain enforced.

Full research/query execution, federation, Wiki, Drive and erasure remain
typed unavailable or fail-closed.

## Q8 exhaustive query composition

The existing `research.query` route accepts the already-defined `EXHAUSTIVE_JOB`
product through a separate strict parser and the versioned
`eliotr.exhaustive-query.v1` result shape. ORIENT parsing and its metadata
limits remain unchanged. The Q8 adapter owns scope freeze/currentness,
authoritative normalized-section inventory and pinned section reads as injected
ports, then delegates planning, exact verification, shard reconciliation and
coverage to ER-07 Q7. The default Worker wiring binds those authorities to the
owner ScopeSnapshot, admitted normalized manifest, persisted structural
projection ranges and pinned R2 evidence ports. Local COMPLETE requires verified persisted authority
and evidence; post-staging receipts separately qualify LIVE. The existing ER09 `ResearchWorkflow` host accepts a
bounded Q8 job through one `step.do` owner boundary. `research.query` launches,
reads and cancels that durable Workflow through the existing operation, with
the D1 binding rechecking principal, credential, deployment, request identity,
active policy and cancellation state. Local Q1 import-to-projection HTTP tests
cover launch, readback, cancellation and no-resume behavior; deployed Workflow
and live user-loop qualification remain `NOT EXECUTED`. A Q7
`result_artifact_ref` is a receipt reference; it is not a published research
artifact. Before a terminal Workflow result is exposed, the binding strictly
decodes the versioned COMPLETE/UNFINISHED shape and reads the canonical Q7 job
through the existing retrieval store, matching the owner credential/job tuple
and currentness callbacks. A transport output cannot fabricate a receipt or
pending coverage state; this remains local `IMPLEMENTED_NOT_LIVE` evidence and
does not qualify deployed Workflow, live user-loop handles or RETRIEVAL.

The owner-only `GET /api/v1/research/query/jobs` route provides a bounded recent metadata page for
reload recovery. It accepts `limit` in `[1,20]` (default `20`) and an opaque keyset `cursor`; the
cursor is bound to the authenticated owner/client/credential/deployment context and carries no
authority. Each item exposes only Workflow instance/status, binding state, creation/expiry metadata
and recoverable/cancelable flags, with Q7 job state fields present only after canonical job readback.
Rows are filtered by current D1 binding and owner policy, and currentness is checked before and after
the asynchronous Workflow status read. Remote deployed Workflow and live Access qualification remain
`NOT EXECUTED`.

## Acceptance

- missing/forged Access identity is rejected before application execution;
- stale Core/Search schema generations block protected product routes;
- service principals cannot cross owner-only boundaries;
- the service-token profile admits only the configured signed Client ID; managed-oauth admits only
  the verified human actor with the dedicated audience;
- the internal tool context receives the profile-bound logical principal; actor identity is not caller-supplied;
- browser-originated MCP calls are rejected;
- Queue messages without matching D1 authority are never executed;
- duplicate/failed receipts cannot fabricate success;
- transient Queue/DO deletion cannot remove durable job, Investigation or artifact authority;
- handlers remain below source/runtime budgets and expose explicit degraded state.

## Mandatory negative boundary

Delete or redeliver transient Queue state after the durable projection acceptance receipt. The Worker
must reconstruct from D1, return the same receipt and never create a second job. Separately, reuse a
catalog cursor under another project and reject it, then submit `dry_run=false` through MCP and prove no
Google or ELIOT effect occurs.

## Verification

```text
pnpm --filter @eliotr/core typecheck
pnpm --filter @eliotr/core test
pnpm delivery:check
pnpm gemini:check
pnpm cf:types
pnpm cf:dry-run
pnpm check:implementation-status
```

Live owner JWT, Gemini service token, remote D1, Queue duplicate/DLQ, deployed Worker, Google readback and
WebSocket receipts remain `NOT_EXECUTED`; status is `IMPLEMENTED_NOT_LIVE`.

## Active local-first integration

See [`local-launch.md`](../implementation/local-launch.md). The owner metadata orientation, bounded
FAST_SEARCH retrieval and trace routes are active and tested through actual Worker/D1 dispatch;
full research products and live qualification remain separate gates. The integration library replaces moved core service
implementations, rather than duplicating them. No new service or production language is introduced.


The owner catalog now shares the current namespace/admission read-policy authority used by orientation.
Only admitted readable LIVE heads are listed; a project needs a readable active-member witness.
Opaque v2 navigation cursors bind principal, credential, deployment, project, authority epoch and expiry.
A cursor is not an access grant; SQL candidates and current authority are rechecked on every page.
Legacy cursors require refreshing the first page. The primary D1 epoch and temporal frontier are
rechecked before returning titles. MCP cannot impersonate the owner catalog.

## Read-only Library revision history

`source-revisions.ts` reuses catalog eligibility, the admitted-source/read-policy authority and its
primary D1 mutation/temporal fence. An accessible LIVE current head is required; only independently
readable admitted LIVE revisions under the current owner generation may be emitted. Every page
validates its history admissions, not only the head. Hidden versions and their counts are not exposed.

The page and recorded channel metadata are selected together in a read-only D1 batch, at most ten
versions plus one lookahead. The source/session/credential/deployment/epoch/expiry-bound cursor is
navigation, not a grant. Reason payloads are bounded before materialization; malformed stored rows
fail instead of producing partial successful metadata. Post-read withdrawal/purge/expiry cancels output.
Recorded channel observations carry their existing generation/receipt references when present; this
reader does not attest the current D1 Search or managed index. The UI labels that limitation explicitly.
Actual D1/HTTP tests cover pagination, corruption, hidden histories and read races. Live Access and
remote history/readiness observations remain NOT_EXECUTED.

## Initial Google OAuth integration

The bounded service, cryptographic verifier and primary-D1 intent/admission store are implemented in
`drive-oauth-admission.md`. ER-20 owns Google I/O and crypto; ER-24 composes D1, and ER-13 owns migration
0013. ER-18 retains the package barrel; this integration only adds the reviewed OAuth exports there.
## Initial Google OAuth integration

The bounded service, cryptographic verifier and primary-D1 intent/admission store are implemented in
`drive-oauth-admission.md`. ER-20 owns Google I/O and crypto; ER-24 composes D1, and ER-13 owns migration
0013. ER-18 retains the package barrel; this integration only adds the reviewed OAuth exports there.
All shared edits are integrator-serialized. The owner HTTP/PWA adapter is still required: trusted owner
session/currentness and server configuration cannot be replaced by request-body claims. Admission ends
in AUTHORIZING, not ACTIVE; no exchange asset, cursor, source grant or runtime activation is implied.

## Launch 07 G1 begin integration (Writer B, PR #95)

G1 owns the strict server-admitted owner-only OAuth begin path only: `POST
/api/v1/google/oauth/begin` wiring in `http.ts`/`env.ts` (this packet),
route/DTO in ER-21 `routes.ts`/`owner-api.ts`, PWA surface in ER-25, and the
new Worker HTTP test `apps/eliotr-core/test/google-oauth-begin-http.test.ts`
(registered in the ER-00 manifest alongside this note). Reuses migrations
0012/0013 and the existing `google-oauth-service.ts`/`google-oauth-store.ts`
admission stack; no new migration, no G2 callback/exchange, no RSA/PKCE/state
primitive rewrite. Owner/session/currentness come only from verified
Cloudflare Access with same-origin + CSRF enforcement; configuration is
server-owned. Begin makes no provider/token call and creates no
credential/exchange/folder/sheet/cursor/grant/source/result.

The connected raw conversion route is an owner-only server operation composed from the existing
raw-capture currentness bridge and immutable R2 store. Its `eliotr.raw-markdown-conversion.v1`
ledger records one Workers AI attempt and reconciles lost acknowledgements without retrying an
uncertain provider effect. It produces candidate conversion metadata only; it does not create a
normalized manifest, evidence handle, source map, or research admission. Controlled tests inject
the AI binding, and production binding/live qualification remain separate gates.
