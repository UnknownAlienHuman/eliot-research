# ER-24: Worker composition DO Queue schedules and MCP transport

**Slice:** 0
**Depends on:** ER-13, ER-15, ER-17, ER-21
**Live gate:** deployed Access/HTTP/MCP/Queue/D1/DO smoke; otherwise NOT EXECUTED

## Objective

Compose implemented ports in the single Worker while keeping unsupported capabilities mechanically
fail-closed. The Worker is a composition and transport boundary, not a second domain layer.

## Owned paths

- `apps/eliotr-core/src/client-grant-http.ts`
- `apps/eliotr-core/src/ingest-composition.ts`
- `apps/eliotr-core/src/project-client-attachment.ts`
- `packages/cloudflare-navigation/src/client-grant-store.ts`
- `packages/cloudflare-navigation/src/client-grant-service.ts`
- `packages/cloudflare-navigation/src/client-grant-authority.ts`
- `packages/cloudflare-navigation/src/client-scope-grant.ts`

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
- `apps/eliotr-core/src/research-run-failure.ts`
- `apps/eliotr-core/src/research-service-error.ts`
- `apps/eliotr-core/src/research-run-admission.ts`
- `apps/eliotr-core/src/research-run-read-authorization.ts`
- `apps/eliotr-core/src/research-client-run-read.ts`
- `apps/eliotr-core/src/research-deployment-compatibility.ts`
- `apps/eliotr-core/test/research-deployment-compatibility.test.ts`
- `apps/eliotr-core/src/research-run-control.ts`
- `apps/eliotr-core/src/research-client-spend.ts`
- `apps/eliotr-core/src/research-client-execution.ts`
- `apps/eliotr-core/src/research-run-control-fence.ts`
- `apps/eliotr-core/src/research-run-cancel-action.ts`
- `apps/eliotr-core/src/research-run-list.ts`
- `apps/eliotr-core/test/research-run-status.test.ts`
- `apps/eliotr-core/test/research-session.test.ts`
- `apps/eliotr-core/test/research-input.test.ts`
- `apps/eliotr-core/src/research-stage-handlers.ts`
- `apps/eliotr-core/src/research-retrieve-branches.ts`
- `apps/eliotr-core/src/research-retrieval-composition.ts`
- `apps/eliotr-core/src/research-exact-search.ts`
- `apps/eliotr-core/test/research-exact-search.test.ts`
- `apps/eliotr-core/test/research-query-retrieval.test.ts`
- `apps/eliotr-core/test/research-query-replay.test.ts`
- `apps/eliotr-core/src/research-evidence-freeze-composition.ts`
- `apps/eliotr-core/src/research-semantic-composition.ts`
- `apps/eliotr-core/src/exhaustive-query-service.ts`
- `apps/eliotr-core/src/exhaustive-workflow-service.ts`
- `apps/eliotr-core/test/research-query-jobs.test.ts`
- `apps/eliotr-core/wrangler.jsonc`
- `packages/cloudflare-navigation/src/index.ts`
- `packages/cloudflare-navigation/src/orientation-authority.ts`
- `packages/cloudflare-navigation/src/owner-scope-profile.ts`
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
- `apps/eliotr-core/test/catalog-service.test.ts`
- `apps/eliotr-core/test/project-owner-service.test.ts`
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
- `apps/eliotr-core/test/exhaustive-query-service.test.ts`
- `apps/eliotr-core/test/research-query-exhaustive.test.ts`
- `apps/eliotr-core/test/research-exhaustive-sections.test.ts`
- `apps/eliotr-core/test/exhaustive-workflow-output.test.ts`
- `packages/cloudflare-navigation/src/exhaustive-query-service.ts`
- `packages/cloudflare-navigation/src/exhaustive-workflow-binding.ts`
- `packages/cloudflare-navigation/src/exhaustive-workflow-output.ts`
- `packages/cloudflare-navigation/src/exhaustive-workflow-service.ts`
- `apps/eliotr-core/src/bounded-json.ts`
- `apps/eliotr-core/test/bounded-json.test.ts`
- `apps/eliotr-core/src/federation-http.ts`
- `apps/eliotr-core/test/federation-runtime-http.test.ts`
- `apps/eliotr-core/src/research-artifact-reauthorization-http.ts`
- `apps/eliotr-core/src/source-revision-freshness.ts`

ER-09 exclusively owns `apps/eliotr-core/src/research-workflow.ts`; ER-24 may compose its exported
boundary but does not edit or reimplement that workflow authority.

The bounded exploratory evidence-freeze composition connects accepted stage-0/stage-5 readers to
ER-09's RECONCILE/FREEZE_EVIDENCE handlers. Its first local fixture must execute actual W2/D1/R2
lineage with an explicit trusted test profile. This ownership does not select a production model,
enable a public handler generation, qualify a provider or claim that a synthesized answer exists.
ER-27 retains the existing `research-evidence-freeze.test.ts` fixture ownership and delegates its
bounded caller update through the same reviewed handoff.

ER-38 owns the projection runtime package. The known-length R2 stream repair is contributed through
a reviewed ER-38 integration handoff; ER-24 retains the actual owner-loop acceptance boundary.

ER-36 owns the Google transport profile selection and legacy OAuth route gating. ER-24 retains the
underlying OAuth service and storage authority. ER-36 is also the canonical owner of the shared
`composition-root.ts` and `index.test.ts` integration files; ER-24 contributes through the reviewed
integration handoff without claiming those paths.

- `apps/eliotr-core/src/federation-http.ts`
- `apps/eliotr-core/test/federation-runtime-http.test.ts`
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

Federation is locally composed across all seven authenticated operations; independent-peer deployment receipts remain pending. Remaining external Drive, erasure and live-provider qualifications stay fail-closed.

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

## Multi-section exact retrieval

Exact phrase verification keeps the admitted SourceRevision digest separate from the digest of a
projected section. The materializer's full-object digest must match the pinned SourceRevision; the
active anchor and optional candidate item digest must match the exact materialized excerpt. Scope,
owner, source revision, projection generation and item identity checks remain in force. The provider's
preview and normalized text never substitute for the materialized bytes.

The exhaustive section inventory retains each pinned projection item's digest and passes it to the
evidence resolver when that section is read. Inventory remains metadata-only; it neither substitutes
the full-source digest for a section digest nor eagerly reads every section. Canonical projection
item-set validation can reject a changed digest before a job is created.

Focused Core tests cover the distinct digests and reject mismatched anchor, candidate and full-source
identities. The real two-section research fixture also reaches evidence resolution through admission,
projection and retrieval. These are local controlled acceptance checks; they do not establish a
live retrieval channel or enable a new public research generation.

## S06 owner reauthentication read boundary

The owner run-status and recent-runs routes authorize a refreshed Access session through the existing
historical-scope and artifact readers. The run's original credential, frozen source references,
W1/W2/W3 receipts and cancellation state remain execution provenance; reading does not renew the
execution grant or rerun a model. Original grant revocation, current source-policy denial and purge
still deny disclosure. Request expiry and currentness are rechecked after asynchronous native-status
or result reads. A new credential does not imply compatibility with another deployment.

Local acceptance uses `apps/eliotr-core/test/research-run-status.test.ts`: 13 cases, including a real
D1/R2 v3 synthesis/audit/citation/coverage/materialization chain with controlled external AI responses,
followed by HTTP reads using the original and refreshed owner sessions. The same draft reference is
returned without another synthesis/audit; corrupt result bytes and revoke/expiry races fail closed.
The focused combined suite also covers artifact readers, gateway runtime and workflow recovery
(5 files, 41 tests). Core/PWA source and core-test TypeScript checks, package boundaries and their
negative tests pass locally. This is not whole-project CI or live Cloudflare qualification; S05
compatible deployment and S33 long-run execution renewal remain separate tasks. See PR #198 for
implementation commits and exact commands; no schema migration or public DTO change is introduced.


## S14 public run cancellation

`POST /api/v1/research/run/:workflow_id/cancel` accepts only `{}` and a bounded
`Idempotency-Key`. The verified current owner is authorized independently of the original
execution credential. The action uses the existing W2 run and deterministic cancellation
receipt: it does not create a second job, change frozen inputs or renew execution authority.
The existing ledger/orientation epochs and current grant/deadline predicates fence the
conditional cancellation write. Failed or lost D1 acknowledgements are reconciled by reading
that same run; only confirmed CANCELLED returns success. A completion that won first returns
409. Native termination is attempted only after durable cancellation and cannot undo it.

The shared store's explicit `owner-read` mode returns owner-filtered, structurally validated
metadata, not an authorization result. Current reader/action authorization is mandatory
before disclosure or mutation; the default execution mode and all executor guards remain.

Focused local acceptance: 32 tests across run status and workflow recovery, including 10 new
public-cancellation scenarios. These use the actual HTTP/application/D1/R2 path and controlled
Access/native lifecycle boundaries. Concurrent callers, revoke-at-settlement, failure/lost ACK,
refreshed JWT, completion-first and late in-flight output are covered. This does not qualify
native Cloudflare termination. S15 public recovery, S10 machine delegation, S32 client controls
and S05/S33 lifetime changes remain separate. See PR #206 for the code commit and commands.

## S15 public run recovery

`POST /api/v1/research/run/:workflow_id/recover` accepts only `{}` and a
bounded `Idempotency-Key`. It authorizes the current owner over the run's
original frozen source set, then acts on the same native Workflow instance;
it never creates a replacement run or rewrites the stored scope, handler,
source revisions or W1/W2/W3 identities. Active and completed runs are
read-only responses. Paused runs use native resume; errored or terminated
runs use one durable restart action, from the current Workflow step when an
attempt already exists. A lost native acknowledgement is reconciled by
status and cannot issue a second restart for the same run/stage.

Recovery of an existing W2 attempt keeps its original spend receipt. While
that receipt is current the normal Budget Governor check remains mandatory.
After expiry, settlement is allowed only when the exact owner-authorized
`research.run.recover.v1` action exists for that run and stage. The executor
then invokes only the registered readback recovery callback, never the paid
handler. The D1 output/checkpoint guards independently require the same
recovery action before accepting an expired-reservation settlement. VERIFY
recovery replays the deterministic verifier over the exact persisted
synthesis bytes; SYNTHESIZE, AUDIT_CLAIMS, RESOLVE_CITATIONS and MATERIALIZE
reuse their existing recovery adapters. Unknown provider effects remain
unresolved and cancelled/revoked/corrupt state stays closed.

Focused local acceptance covers five public HTTP recovery cases, a real
STARTED VERIFY recovery with no second synthesis, and four W3 lost-ACK
readback cases including expiry of the original spend reservation. Core/PWA
and test TypeScript, changed-file ESLint, package boundaries and ownership
checks pass locally. Native Cloudflare lifecycle acceptance, UI/MCP controls,
delegated service recovery and the full product suite remain separate gates.


## S04 Project mutation runtime regression

`test/project-owner-service.test.ts` calls the actual project-owner service through
local workerd/D1 after the full current migrations. It verifies membership history,
immutable response digests, replay after a new service instance, stale-head rejection,
a concurrent service commit between preflight and batch, in-transaction policy
revocation fencing, rollback of earlier statements after a late constraint failure,
and readback after a lost commit acknowledgement. Scheduling/fault hooks delegate to
the native D1 batch; no application SQL or D1 results are reimplemented in the test.
The depth-100/max+1 negative explicitly distinguishes D1 from permissive host SQLite.
Project mutations currently have no outbox producer; tests assert no invented events.
The independent `d1-mutations` CI job uses the existing Workers configuration on Linux
and Windows, alongside ER-12's Wiki edit/publication regressions. It does not bypass
or replace the full CI gates, enable a feature, or qualify a live deployment.

## Protocol retrieval generation compatibility

New explicit InquiryProtocol requests use `research-handlers.exploratory.v6`, whose
RETRIEVE_BRANCHES plan includes managed SEM. Stored v5 runs retain FAST_SEARCH and
their original request/output hashes; replay selects the stored generation, never
the current admission default. Existing v3/v4 behavior also remains unchanged.
The shared generation predicate keeps v3-v6 report readback, cancellation, recovery
and materialization on the existing services. This is a new-run correction, not
an automatic upgrade of old checkpoints or a live search-quality qualification.

## Project-client delegation backend (S10 / S31)

Migration 0072 introduces one append-only `project_client_grant` authority/receipt table.
One project and verified issuer/method/Client ID tuple owns one immutable logical grant ID;
changes append CAS revisions and revocation retains the tombstone. Owner issuance checks
project ownership, the complete current source-read ceiling and explicit import namespaces.
Grant identifiers are lookup keys, never credentials. A spend-policy locator is currently rejected
with `CLIENT_GRANT_SPEND_NOT_SUPPORTED`; no model budget is delegated by a read grant.

Owner GET/PUT/DELETE routes live under `/api/v1/research/projects/:project_id/client-grants`.
Creation requires expected_revision=0; changes and revocation require the previous revision and
Idempotency-Key. Same-key replay reads the original immutable receipt even after later mutations;
authorization always reads the latest revision. No receipt replay itself reactivates access.

`GET /api/v1/research/catalog?project_id=...` and service-token MCP `eliotr_catalog` share
the same delegation gate and existing source-authority decoder. The actual signed actor is
preserved separately from the grantor's read-policy subject and the legacy Workspace logical label.
Every requested project member must pass the read ceiling; the result stays bounded metadata,
not evidence or an implicit frozen-scope grant. Cursors bind actor, delegation revision and epoch;
expiry, membership, purge and current authority are checked before disclosure.

Connections management is implemented through the same owner API. Service-token HTTP FAST_SEARCH
and query-derived evidence verify/open are wired as described below. Runtime/native acceptance,
managed-OAuth/MCP query, machine run/control/history and actual import handlers remain separate.
Operation enum membership never enables a handler. No existing execution grant is renewed or
reinterpreted; later run integration must also pin the originating delegation revision.


## Delegated FAST_SEARCH and query evidence (S11 code checkpoint)

`POST /api/v1/research/query` admits verified service-token clients only for FAST_SEARCH under
one active project-client grant with `query`. A PROJECT atom selects that project; expressions
without one require the existing non-secret `X-Eliotr-Client-Grant` locator. GLOBAL_LIBRARY,
multiple projects and any atom extending outside the project fail before scope storage. Every
atom is resolved against the grantor's existing read-policy ceiling in full; it is never silently
intersected with the delegated project. Actor attribution remains the verified service identity.

The existing scope service freezes the expression and membership. Its atom/policy identities bind
the exact delegation revision and project generation. Additive migration 0073 appends that origin
to `scope_access_grant`; a current-authority epoch fences issuance and ambiguous writes reconcile
by exact readback. Grant expiry is capped by the frozen scope, signed service session, delegation,
source policy/admission and project membership boundaries. No old grant is promoted or renewed.

Retrieval and the exact evidence resolver use the same `scope_access_grant_effective` SQL view.
Current delegation, project/grantor ownership, membership, policy, source owner and purge state
are mandatory both during resolution and at durable result/trace/handle/receipt writes. Query
scope revocation invalidates persisted results; regrant cannot revive a prior scope or cache.
Source/head/tag/namespace/admission changes conservatively revoke all active delegated query
scopes, including unrelated ones, so arbitrary tag/class expressions cannot resurrect earlier
rights. Project and read-policy changes target their affected grant origins. This deliberately
coarse query-cache invalidation is not a complete reverse-dependency index. It does not touch
legacy grants or S33 owner execution reservations.

Public `/research/verify` and `/research/open/:ref` additionally require `evidence` on the same
originating revision, before and after the shared resolver. A `query`-only grant can receive its
search pack but cannot use a returned handle as independent evidence-read permission. These are
query-derived evidence reads, not general Research report/section/history or MCP readers.

FAST_SEARCH retains its 64-member/16-result and existing byte/section budgets; overflow is explicit,
coverage stays NONE/SAMPLED and no model/spend authority is inferred. Owner behavior and the
existing serializer/digests are retained. **Apply migrations through 0073 before deploying this
code**, including owner paths that now read the effective-grant view. Code compilation and static
SQL/ownership checks are not native D1/R2, concurrency, browser or live acceptance. Machine run,
status, control, paid sponsorship and import/attach remain implementation work.

## Delegated run status (S11 code checkpoint)

`research-client-run-read.ts` composes model-free HTTP/MCP status for a known owner-authored
run originally scoped to one explicit delegated project. It requires `status`, the actual signed
service actor, current grantor/project authority and all original-source policies, membership,
ownership, disclosure and purge checks. Original owner grants may expire but may not be revoked;
only the existing proven source-head-advance invalidation can be reauthorized. Compatible
deployment readback and W1/W2 identity remain mandatory; no execution grant is issued or renewed.

`report` separately permits discovery of the completed DRAFT reference through the shared historical
coverage reader and delegated artifact reader. Without it, answer availability stays `unavailable`.
The common reader keeps recorded authorship separate from the actual service identity and preserves
all original manifests, references, hashes and lineage checks. No new reader engine or storage schema.
GET run status alone admits owner-or-service; admission/cancel/recover handlers are not broadened.
Machine run creation, controls, sponsorship and machine-authored history remain code work.
Compilation/static review only; native/behavioral acceptance and live qualification remain pending.
