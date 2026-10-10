# R05 local native qualification — October 9, 2026

R05 source assembly is published in `a59f441ee068e0f315addbb933aa5245b3a2dee2`.
[#326](https://github.com/UnknownAlienHuman/eliot-research/pull/326) remains open
and the project Goal remains active. This record does not promote implementation
status or authorize deployment/cutover.

## Verified generation repair

The existing 0086 payload JOIN/current-view requirement and 0090 COMPUTER
dispatch acceptance recognized only `research-handlers.exploratory.v8`.
Consequently native `external-wait.v1` payload was invisible, its task could be
published without a payload, and its COMPUTER dispatch could not be accepted.

Append-only migration 0132 changes exactly these three generation predicates
to include `research-handlers.exploratory.external-wait.v1`. Historical migrations
and all other grant/scope/route/actor/lease/payload/immutability predicates remain.
Migration 0130 continues to own known-result settlement authority.

`apps/eliotr-core/test/native-external-task-payload-binding.test.ts` uses actual
Core migrations, PROJECT scope, delegated service-token grant with spend
provenance, PREPARED→COMPLETE orientation, current authority epoch, real ledger,
R2 and W2 predecessor checkpoints. Its three cases pass: exact immutable payload
is visible; absent payload and foreign payload attempt cannot publish a task.
The exact case compares task/payload with the persisted single W2 attempt and
the original deadline captured before preparation. Scientific predecessors are
fixture bytes, not admission or scientific pipeline acceptance.
After strengthening those assertions, only the changed positive case was rerun:
one PASS and two skipped; the two previous negative results were retained.

Owning TypeScript 6.0.3 compilation has zero diagnostics and exact ESLint passes.
The actual Core depth-100 check uses SQLite 3.50.4: 128 migrations, 639 schema
shapes, one callback query, zero failures and unresolved sites. This is bounded
schema/query proof, not repository-wide SQL target qualification.

## Bounded actual native evidence

The private local fixture uses Miniflare 5.20260926.1-alpha and esbuild 0.28.1.
It retains actual Core migrations/views/triggers, delegated grant/orientation/
epoch, R2, W2 executor/native ports, `ExternalAgentTaskStore.recordResult`,
callback routing, native Queue and D1 inbox. Its output conversion is explicit
fixture data rather than the existing branch `consumeResult`. It runs without
remote bindings, paid provider calls or deployment.

| Case | Result and scope |
| --- | --- |
| Generation payload fence | PASS: payload invisible before 0132 and visible after 0132 against the exact tuple. |
| Early/duplicate result | PASS: canonical result precedes native execution; duplicate callback returns the same receipt and no extra task. |
| Lost result commit ACK | PASS: actual result batch commits before injected ACK loss; exact readback reconciles and Queue advances the original W2 checkpoint. |
| Lost native send ACK | PASS: inbox retry deadline is respected; no repeated business effect and later obsolete delivery is acknowledged. |
| Revocation before wake | PASS: obsolete transport ACK, stage 8 remains STARTED and no new checkpoint. |
| Cancellation before wake | PASS: run remains CANCELLED and no new checkpoint. |
| Known result, direct settlement after expiry | PASS: same native server ports return SETTLE and advance original attempt to stage 9/revision 10. This excludes paused Workflow continuation. |
| Paused native delivery after expiry | PASS after the lifecycle repair: native Queue wakes the original attempt after expiry; one canonical read and checkpoint at stage 9/revision 10. |
| Native timeout with a recorded result | PASS after the lifecycle repair: no event is sent; one canonical read settles the original attempt after timeout. |

The retained progressive record holds the first four cases; it is not a complete
aggregate suite receipt. Separate receipts retain payload baseline/fix,
revocation/cancellation and direct settlement. The earlier standalone early-result
receipt predates payload admission and must not substitute for the later scope.
Private files are under `.eliotr-state/backend-full-20261008/`:

- `native-canonical-retained-progress-20261009.json` (preserved progressive snapshot);
- `native-canonical-receipt-{pre0132-,}canonical-payload-generation-fence.json`;
- `native-canonical-receipt-canonical-cancelled-before-wake_canonical-revoked-before-wake.json`;
- `native-canonical-receipt-canonical-known-result-direct-after-expiry.json`.

## Paused continuation — diagnosis and local resolution

In the original failed attempts, the result commits before both lease and W2 budget expiry. Delivery is
delayed across expiry while the Workflow is paused, then native Queue returns a
`:sent` receipt. The canonical settlement-authority row exists. On resume the
helper reaches settlement, but Workflow reports `WORKFLOW_EFFECT_UNCERTAIN`;
the active run remains stage 8/revision 9 with the original STARTED attempt,
no output and no new checkpoint. The diagnostic D1 proxy records no storage
error. First/latest failure records remain null. In the original three attempts,
one canonical-result read starts without the fixture's absent-result or
authorized-result marker.

Evidence: `native-canonical-debug-canonical-paused-delivery-after-expiry.json`,
`native-canonical-failure.json` and `native-canonical-fixture-failure-audit.md`
in the private directory above. Direct settlement after expiry passes. These
facts do not identify a Miniflare defect or a product defect; the cause is
unverified by those original observations. Do not repeat the same fourth
approach without new causal evidence.
Do not extend deadlines, weaken guards, or use restart as ordinary result wake.

A bounded installed-source audit found a concrete investigation seam:
Miniflare's `waitForEvent` races its pause signal and throws the USER_PAUSE error
(installed `binding.worker.js:2871–2891`), while the helper's catch-all reaches
settlement for any wait exception (`native-external-task-step.ts:118–132`).
After that audit, one diagnostic-only run wrapped the native wait and settlement
callbacks without changing product code. At `2026-10-09T18:40:53.985Z` it records
`Aborting engine: User called pause`; at `18:40:54.027Z` it records settlement's
`WORKFLOW_EFFECT_UNCERTAIN` and an absent canonical-result read. Both precede
the original `18:41:01.722Z` deadline. This establishes premature settlement
from pause fallthrough in that local diagnostic run, before result recording.
It does not establish the production runtime's pause exception contract or
accept the completed paused continuation. The diagnostic remains failed, with
no new checkpoint. Its logs are the two `PRIVATE_PHASE` rows in the same debug
artifact named above; the original progressive successes have been preserved.

The initial [Workers API reference](https://developers.cloudflare.com/workflows/build/workers-api/),
retrieved October 9, documents a timeout exception but does not specify a public
pause/timeout discriminator in the returned excerpt. Do not introduce a guessed
error-message check or treat internal Miniflare strings as a production contract.

The subsequent [Workers RPC error contract](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/)
and [compatibility flag reference](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enhanced-error-serialization),
retrieved October 9, specify preserved error `name`/serializable fields with
`enhanced_error_serialization`; custom prototypes and `instanceof` are not the
RPC contract. The current SDK donor's [errors.ts](https://github.com/cloudflare/workers-sdk/blob/794855c42714f68fafaf6be420ab192707ef8f43/packages/workflows-shared/src/lib/errors.ts#L1)
defines `WorkflowTimeoutError`, and its [context.ts](https://github.com/cloudflare/workers-sdk/blob/794855c42714f68fafaf6be420ab192707ef8f43/packages/workflows-shared/src/context.ts#L1349)
uses that error for native wait. The inspected commit is dated October 9,
`17:18:14Z`. These are platform references, not a copied Workflow runtime.

The installed Miniflare engine fixes its compatibility date at `2024-10-22` and
copies explicit application flags. The application's newer date alone therefore
left the native timeout's observed `name` as `Error`. One dedicated actual
canonical timeout qualification established that shape. Adding the documented
flag preserved `WorkflowTimeoutError` through RPC in a separate qualification.
Core Wrangler now declares the flag explicitly. The helper reads the preserved
name field, permits exactly one canonical read after that timeout, and rethrows
pause/restart/terminate/unknown errors to the native engine. It never inspects
error message/stack or requires a custom prototype.

Eight changed/new helper regressions pass (seven unchanged cases skipped), with
TypeScript 6.0.3 owning compilation at zero diagnostics, exact ESLint and bounded
three-file source acceptance. The final affected native run passes pause/resume
across original expiry and timeout with a predeadline recorded result. Both reach
canonical stage 9/revision 10 with the original attempt, one task publication,
one predecessor execution and one authorized canonical-result read. Passing
earlier unrelated native cases were retained rather than repeated.

The final private receipt is
`native-canonical-receipt-enhanced-errors-canonical-paused-delivery-after-expiry_canonical-timeout-recorded-result.json`.
The baseline timeout and flag-only platform qualification are retained separately
in `native-canonical-receipt-canonical-timeout-recorded-result.json` and
`native-canonical-enhanced-timeout-platform-qualification.json`. The final run
uses the same explicit flag as Core; scientific conversion remains fixture data.

## Existing scientific consumption — bounded local qualification

Five additional native cases pass on Miniflare `5.20260926.1-alpha` and esbuild
`0.28.1`, over committed `e14c1974` source with foreign C2/retrieval WIP excluded
by the HEAD overlay. The new fixture uses the actual protocol-freeze handler,
planning manifest, committed D1/R2 stage-0 readback, D1 navigation/current scope,
W1 ledger, read/extract handler, external `prepareTask` and
`readRecordedResult`/`consumeResult`. It retains actual W2, native Workflow,
callback receipt routing, outbox, native Queue and inbox.

| New case | Result |
|---|---|
| Existing scientific result consumption | PASS: one BLOCKED SUPPORT branch, server-derived unknowns and `UNASSESSED` authority in exact persisted branch bytes; original attempt commits at stage 9/revision 10. |
| Arbitrary task output | PASS: `WORKFLOW_OUTPUT_CORRUPT`; native transport ACK does not advance stage 8 or create a successful branch. |
| Scientific pause/resume after original expiry | PASS: original attempt, one task publication, one canonical result read, one `consumeResult` and one completed predecessor effect. |
| Immutable configuration with scientific consumption | PASS: actual D1 immutable configuration store, Core attach/read and runtime binder; two exact configuration rereads preserve the original pointer through native settlement. |
| Forged expected configuration digest | PASS: `WORKFLOW_AUTHORITY_STALE` before task publication; zero tasks and zero canonical result reads. |

The scope is deliberately bounded. Frozen evidence is empty, SUPPORT is BLOCKED,
stage 1–6 outputs and the stage-five retrieval lineage are fixture inputs, and
the COMPUTER route callback is injected. Configuration pins follow the existing
Core readiness fixture; runtime configuration objects are empty and provider/
qualification references are fixture values. No production model, spend,
project selection or provider qualification follows from this check. Initial
admission, public HTTP/JWT, nonempty exact-evidence resolution, complete scientific
pipeline, COMPUTER route, selected-profile native/live and release remain open.

The stronger scientific path first rejected the transport fixture's synthetic
issuer/subject; only fixture inputs were corrected to the existing strict Access
issuer/`.access` subject schema. The configuration reader also rejected the
store-only fixture's empty model selection list; the final bounded fixture uses
the two existing Core readiness selections. Neither production guard was changed.
Passing earlier transport/lifecycle cases were retained without repetition.

Private receipts under the same checkpoint directory are:

- `native-scientific-receipt-enhanced-errors-scientific-native-result_scientific-invalid-output.json`;
- `native-scientific-receipt-enhanced-errors-scientific-paused-after-expiry.json`;
- `native-scientific-receipt-enhanced-errors-pinned-scientific-pinned-native-result_scientific-pinned-identity-mismatch.json`.

## Existing COMPUTER route services — bounded local qualification

Three new named cases pass on the same Miniflare/esbuild versions, using a
separate private fixture that preserves the earlier scientific fixture sources.
It creates the connection, project `ORIGINATING_MATCH` route and immutable run
binding through their existing D1 services. Exact binding readback checks the
stored canonical bytes/digest, grant, actor, connection and route revision.
The existing route reader runs at both task preparation and scientific result
consumption; Core's existing stale/uncertain error mapping is retained.

| New case | Result |
|---|---|
| COMPUTER route with immutable configuration and native result | PASS: two exact route reads and two configuration rereads; original attempt settles at stage 9/revision 10 with one task, result read, scientific consumption, predecessor effect and native settlement. |
| Missing immutable run binding | PASS: `WORKFLOW_AUTHORITY_STALE`, no task inserted and no native settlement; stage 8 remains current. |
| Foreign grant against the persisted run binding | PASS: the same fail-closed result before task insertion. |

Authenticated owner/service contexts are still injected, the connection has no
claimed computer capabilities, and no dispatch or connection qualification runs.
Empty evidence, supplied retrieval/predecessor outputs and diagnostic configuration
remain explicit boundaries. This qualifies the local connection/route/binding
service seam; public HTTP/JWT, production COMPUTER dispatch/provider selection,
complete scientific/native/live and release acceptance remain open.
The receipt is
`native-computer-receipt-enhanced-errors-pinned-computer-pinned-native-result_computer-missing-route-binding_computer-foreign-grant.json`
under the same private checkpoint directory. Earlier passing cases were not rerun.

## Signed HTTP and WEB_INBOX qualification — bounded local result

The next private fixture preserves all earlier passing sources and composes the
existing `handleHttp` route dispatcher with real RSA/JWKS verification. Initial
service identity comes from the verifier; the same exact credential generation
is used by qualification, the scope grant, task lease and callback. The existing
connection service declares WEB_INBOX; qualification is obtained through actual
owner issue and service confirmation HTTP routes, never fabricated receipt rows.

| New case | Result |
|---|---|
| WEB_INBOX-capable connection without qualification | PASS: `EXTERNAL_AGENT_TASK_DENIED`, ten D1 prepares, zero task SQL and zero batches. |
| Signed owner issue and signed service confirmation | PASS: exact connection/revision/transport/deployment and credential generation become READY through the existing diagnostic service. |
| Signed task pull, result and duplicate callback followed by native delivery | PASS: duplicate receipt is identical; one original task/attempt, result read, scientific consumption, predecessor effect, Queue event and native settlement; two route and configuration reads; canonical next stage 9/revision 10. |

The HTTP callback remains `RESULT_RECORDED` and `workflow_settled: false`.
Canonical native readback, including exact persisted R2 branch bytes/digest,
establishes settlement. The BLOCKED branch remains `UNASSESSED` with empty evidence.
Five earlier HTTP negatives also pass: signed unlisted service, signed owner on
a service route, missing Origin and Cookie are denied before D1; missing WEB_INBOX
capability is denied before task SQL. Their receipt records the preceding
four-operation auth postimage, whose task classification and browser guards are
unchanged by the subsequent extension to COMPUTER operations.

Actual signed-token regressions reproduced the generic service-to-federation
classification defect for task and COMPUTER routes. The repaired exact set covers
four task operations, qualification confirmation and dispatch pull/accept/decline.
All seven federation operations and unrecognized service defaults retain their
class. Five signed-token cases, TypeScript 6.0.3 Core source/test-project compilation
(zero diagnostics, 4273 virtual outputs), exact lint and independent final-source
review pass. The source and owning inbox document are in local commit `034469c6`;
remote publication is a separate coordinated transition.

Miniflare 5.20260926.1-alpha and esbuild 0.28.1 run the private graph with
`nodejs_compat` and enhanced error serialization. This is local Workerd acceptance,
not emitted production Worker or deployed Access/browser qualification. JWKS,
initial admission, stages 1–6/retrieval lineage, budget and configuration values
remain fixture inputs. COMPUTER dispatch acceptance, nonempty exact evidence,
production-selected profiles/providers, the complete scientific pipeline, selected
native/live and release remain open. No implementation-status or #326 promotion
follows from these results.

Receipts under the same private checkpoint directory:

- `native-public-http-negative-receipt-20261009.json`;
- `native-public-qualified-receipt-20261009.json`;
- `computer-service-principal-source-review-20261009.json`.

The private runner's first positive attempt read the HTTP `{data,...}` envelope
as a raw qualification object; correcting its existing response decoding produced
the three passing cases. No product parser, grant, qualification, Origin or Cookie
guard was weakened. The raw failure receipt is preserved; prior native suites were
not rerun.

## Nonempty exact evidence — consumer repair and local negatives

A separate added-only fixture supplies one admitted source revision and one
78-byte UTF-8 normalized Markdown object with real R2 checksum and immutable
metadata. Its initial source-admission rows, nonempty scope and stage-five lineage
are explicit fixture inputs. Actual D1 authority, exact handle materialization,
R2 conditional read, canonical resolution receipts, signed HTTP callback and
native Queue/Workflow consumption run through existing product services.

The positive case reproduced `WORKFLOW_OUTPUT_CORRUPT` in
`currentSelectedEvidence`. Resolver receipt identity includes the resolution
timestamp, so an unchanged handle obtains a fresh verification receipt on
reopening. The consumer now uses the existing source-bound evidence identity,
which retains the full immutable handle, exact bytes, source content digest,
scope digest, credential generation and taint/effect ceilings. Exact authorization
receipt equality remains required; resolver/currentness/checksum checks are intact.

| Added case | Bounded result |
|---|---|
| Nonempty selected handle with fresh exact resolution | PASS: two resolution receipts, one original committed Stage-8 attempt, stage 9/revision 10, one callback delivery/Queue read/consumer settlement; disposition remains `UNASSESSED`. |
| Forged frozen source content binding | PASS: `WORKFLOW_OUTPUT_CORRUPT`, two resolution receipts but no consumer settlement or Stage-8 checkpoint; stage 8/revision 9 and original attempt remain. |
| Normalized R2 bytes changed after callback | PASS: typed `EVIDENCE_OBJECT_INTEGRITY` from actual materialization, no fresh successful resolution or Stage-8 checkpoint; stage 8/revision 9 and original attempt remain. |

TypeScript 6.0.3 owning virtual compilation passes with zero diagnostics and
2700 outputs; exact lint and independent final-hash source review pass. Private receipts:
`native-exact-evidence-receipt-20261009.json`,
`native-exact-forged-source-binding-receipt-20261009.json`,
`native-exact-corrupt-r2-object-receipt-20261009.json` and
`native-exact-evidence-graph-compile.json`. The positive baseline failure is
retained separately. Two initial seed failures exposed missing owner read policy/
project membership and an incorrect R2 key; the private seed now uses the existing
authority rows and canonical key builder. No production guard was weakened.
The R2 negative initially asserted a typed code against native status's human
message; only that failed case was repeated after checking the retained typed
local diagnostic. Earlier passing suites and the positive case were not repeated.

Miniflare 5.20260926.1-alpha and esbuild 0.28.1 qualify the local private graph.
Complete ingest/admission, actual stage-five retrieval, earlier scientific stages,
production profile/provider, COMPUTER dispatch, complete native/live and release
remain open. These three cases do not promote implementation status or close #326.

## Canonical admission before evidence — local application and public HTTP

Separate added-only fixtures reuse the existing Core `createIngestApplication`,
D1 admission authority, R2 staging port and actual persisted promotion authorizer.
Ownership/policy are explicit fixture preconditions. The product service writes
operation/candidate/qualification/decision/source/revision/head/readiness/outbox
and receipt state; the fixture inserts no canonical source/admission result.
Work and Evidence use separate real R2 buckets. Content is read from the actual
promotion's `promoted_objects` entry; `normalized_artifact_ref` remains the
manifest reference. Initial read policy/project membership/scope and scientific
predecessors remain separately labelled fixtures.

| Added case | Bounded result |
|---|---|
| Existing Core application admission, injected owner context | PASS: actual admission/promotion/78 UTF-8 bytes, two exact resolution receipts and one original Stage-8 commitment, stage 9/revision 10, `UNASSESSED`; duplicate callback identical. |
| Persisted policy excludes injected owner | PASS: typed `INGEST_POLICY_DENIED`, zero deltas in eight canonical/Workflow tables, zero Work/Evidence objects. Private wrapper 500 does not qualify product HTTP mapping. |
| Existing public HTTP admission, local signed owner RS256/JWKS | PASS: eight existing prepare/part/complete/commit requests return 200; `handleHttp` constructs verified owner context and its application; same actual canonical/evidence/Queue/native single commitment and duplicate result checks pass. |
| Persisted policy excludes verified public owner | PASS: actual nonretryable product HTTP403 `INGEST_POLICY_DENIED`, one prepare request, eight zero table deltas and zero Work/Evidence objects. Private seed wrapper 500 only carries the observed product response. |

The application-only denial initially read a nested private error field although
the existing transport had already returned a flat `code`. Only that failed
assertion was corrected and the failed case repeated. The public positive's first
attempt failed `SCHEMA_NOT_READY` before ingestion because its private runtime
bound only Core. Adding Search and applying the actual Search migrations satisfies
the existing readiness reader; no readiness row was fabricated or guard bypassed.
Only that failed new case was repeated. Both first failure receipts are preserved.

Miniflare 5.20260926.1-alpha and esbuild 0.28.1 qualify these local private graphs.
All receipt-loaded input hashes and derivation baselines read back exactly;
previous passing fixtures and receipts were retained without repetition. The new
private graph has no semantic TypeScript verdict yet. Local JWKS/network override,
owner/policy/initial scope/project/stage-five/earlier scientific/budget/configuration
fixtures and private Workflow entrypoint leave production configured Access/ingress,
complete ingest/retrieval/scientific pipeline, COMPUTER dispatch, selected native/live
and release acceptance open. No implementation-status, #326 or Goal closure follows.

Private records in the same checkpoint directory:

- `native-admitted-evidence-receipt-20261009.json`;
- `native-admitted-denied-owner-receipt-20261009.json`;
- `native-http-admitted-evidence-receipt-20261009.json`;
- `native-http-admitted-denied-owner-receipt-20261009.json`;
- `admitted-evidence-completion-proof-20261009.json`.

The original application-only denial receipt retains a copied broad descriptive
scope string. Its actual case/zero effects are authoritative for that bounded run;
it executed no Workflow/result/Queue/scientific path. The completion proof records
this correction without rewriting the raw receipt. The separate public-denial
receipt uses a narrow scope matching its execution.

## Native locator negatives after public admission

Three separate added-only cases reuse the passing public-admission fixture without
changing or repeating its earlier cases. A private native subclass records the
typed terminal error and rethrows; the original product helper/ports own behavior.
The private event-type reader calls the existing `externalTaskWakeEventType`.

| Added event | Bounded result |
|---|---|
| Correct native event type, foreign attempt in locator | PASS: `WORKFLOW_OUTPUT_CORRUPT` before settlement or canonical result read. |
| Locator with an unknown authority field | PASS: `WORKFLOW_OUTPUT_CORRUPT` before settlement or canonical result read. |
| Valid locator before a canonical result exists | PASS: exactly one canonical read and `WORKFLOW_EFFECT_UNCERTAIN`; no result authority or scientific consumption. |

Each case retains stage 8/revision 9, one original `STARTED` attempt, one published
task with null result digest, and zero Stage-8 checkpoints. No Queue result was
delivered in these cases. All three passed on their first run; loaded input hashes
and the retained passing runner read back exactly. Receipts are
`native-http-admitted-events-{foreign-attempt,malformed-locator,event-before-result}-receipt-20261009.json`;
`native-http-admitted-events-completion-proof-20261009.json` records their scope.
The same local owner/policy/JWKS/scope/stage-five/predecessor/budget/configuration
and private Workflow entrypoint limits apply. These negative results do not close
lost/duplicate/late ACK, full product Workflow, selected native/live or release gates.

## ResearchSession HTTP extraction — bounded regression result

The existing `project`, `start`, `read`, `execute` and `cancel` handlers now live in
`research-session-http-projection.ts`. The DO forwards their existing arguments
through a private host factory whose closures call private load/save/terminal
settlement. AST comparison verifies five exact bodies modulo host references,
six exact helpers, unchanged retained DO members and unchanged wrapper signatures.
No public persistence or additional callable RPC was introduced.

The final files contain 393/362 physical lines under the repository checker.
TypeScript 6.0.3 owning virtual compilation passes with zero diagnostics and 4937
outputs; exact lint and independent review of both final SHA-256 values pass.
The existing locator regression passed on the first run. Bootstrap and native
waiting projection initially failed because two retained imports were missing;
after restoring those imports, only the two failures were rerun, both passing.
The original passing case was retained. These three results do not qualify a
complete Workflow, production JWT/Access, browser or live deployment.

Private evidence: `session-projection-root-final-ast-proof.json`,
`session-projection-graph-compile.json`, `session-projection-refactor-result.json`
and `session-projection-refactor-followup.json` in the checkpoint directory.
The source-budget scan exits successfully in advisory mode with eight observations;
it is not a green budget gate. Session's file overage is removed, while Core and
other package totals remain over their limits. The Goal and #326 remain open.

The coordinated frontend unpublished-history repair maps Session local commit
`40f08d27` to `d6b21d493b461685046ce6689786328ee09a2675` with an identical full
tree and all six reviewed blobs. The private runtime/compile receipts retain
their original identities; this delivery mapping does not rerun their checks.

Remaining acceptance includes production pause/resume, complete scientific `consumeResult`,
pinned production configuration, COMPUTER dispatch, selected public HTTP/JWT, foreign/
malformed/late events, timeout/result boundary, restart/completed predecessors,
historical generation, selected-profile native/live and release receipts. Passing
bounded source or fixture cases do not close those gates.

## Actual Core candidate and product Workflow — added bounded qualification

The retained exact `2607583d` source graph produces a custom esbuild 0.28.1
candidate of 4,979,092 bytes with 1,209 inputs. Its SHA256 is
`58157172bc4ca0f5953dcfaa0d136433e8d56db90124278e9760980fcbeab5b2`.
Actual `ResearchSession` and `ResearchWorkflow` exports are bound under Miniflare
5.20260926.1-alpha; canonical compatibility date/flags remain unchanged.
Current Cloudflare documentation makes node compatibility the default from
August 4, 2026, so the canonical August 28 date needs no speculative flag repair.
Real Core/Search migrations and product `/healthz` return readiness 200. The
private createRequire bridge makes this custom candidate loadable; neither its
build nor bootstrap is official Wrangler 4.143.1 artifact attestation.

Four new separately executed instances run the actual product `ResearchWorkflow`
class, without a private Workflow subclass or replaced callbacks:

| Input boundary | Actual bounded result |
|---|---|
| Unknown Workflow kind | `WORKFLOW_INPUT_INVALID` before stage execution. |
| Unknown authority field | `WORKFLOW_INPUT_INVALID` before stage execution. |
| Uninstalled deployment | Existing typed `WORKFLOW_AUTHORITY_STALE` with PREPARATION/NOT_STARTED outcome. |
| Absent investigation after actual deployment compatibility read | `WORKFLOW_PREPARATION_FAILED` with safe `WORKFLOW_AUTHORITY_STALE` cause. |

Each case leaves seven observed business tables unchanged and both R2 buckets
empty. No run exists, so durable failure retention is not claimed. The first
deployment case failed only the private expected-outer-code assertion; its
failure is retained, the actual error contract was read, and only that failed
case was repeated. The two earlier passing parser cases were not rerun.

A separate positive invokes the actual product Workflow binding and native
`step.do` with its existing deterministic confirmatory handler. The existing
ledger service creates the initial ledger over genuine local D1/R2; owner,
scope, grant and current policy remain explicit fixture preconditions. All 18
attempts commit with 18 checkpoints/outbox intents/ledger events, stage 18 and
revision 19. All 18 output bytes match persisted lengths/digests. A second native
instance for the same operation returns the identical retained result, with no
new business effects. `ENGINE_COMPLETED` supplies no scientific disposition.

Private artifacts under `.eliotr-state/backend-full-20261008` retain the
`core-head-candidate-*` build/bootstrap receipts, four
`core-product-workflow-*-receipt-20261009.json` negatives, and
`core-product-confirmatory-workflow-receipt-20261009.json`. The consolidated
`backend-candidate-continuation-completion-proof-20261009.json` checks 346 exact
seed inputs and preserves earlier admission/event receipts without rerunning
them. The previous public-admission audit's raw reviewer label `Nash` is a
metadata error: actual reviewer was Pasteur; its seven audited hashes are exact
and its scope does not include the later candidate cases.

Private seed semantic TypeScript, actual DO RPC, product external-task native
wait and full scientific positive, selected Access/provider/configuration,
official emitted build, staging/live and release remain pending. The new
confirmatory native execution does not close #326 or the Goal.

## Actual product Session RPC — Worker-side bounded qualification

One added native case passes against the same immutable `2607583d` custom Core
candidate and SHA256 above. It binds the actual `ResearchSession` and
`ResearchWorkflow`, genuine local D1 migrations and R2, and the existing
deterministic confirmatory handler. The WebSocket client runs in a separate
local Worker; Node receives HTTP JSON. Node 25.6.1, Wrangler 4.143.1,
Miniflare 5.20260926.1-alpha and esbuild 0.28.1 retain the canonical August 28
compatibility date and flags. This does not attest official Wrangler emission.

| Observed boundary | Bounded result |
|---|---|
| Actual Session RPC | Exactly one successful `eliotr.research-session-projection.v1` frame with the completed operation's persisted investigation, receipt and output-manifest references. No scientific disposition is added. |
| Foreign operation upgrade | HTTP 409 `SESSION_AUTHORITY_STALE`, with no socket returned. |
| Current grant-use revocation | Exact full-row readback changes only the original grant's `allowed_use_json` from `["research"]` to `[]`; the socket closes cleanly with code 1008 and `SESSION_AUTHORITY_STALE`, ready state 3. |
| Business readback and process | Completed run remains stage 18/revision 19 with 18 attempts and 18 checkpoints. Child exits 0 without a signal; `Miniflare.dispose()` resolves. These counts are not an all-table zero-effects proof. |

The initial Worker-side assertion expected D1 `meta.changes` to equal one.
Installed Miniflare uses the `total_changes()` delta, which includes the
orientation/ledger epoch and historical-grant triggers. The harness now proves
the exact grant's full before/after row instead. The original failed observation
and process remain preserved; production D1 or authority guards were not changed.

A later source audit found that a settled error observer did not prove actual
socket teardown. The private probe now installs a fresh close observer before
teardown, preserves both primary and teardown errors, and releases listeners and
timers. Four isolated fake-socket cases pass for accept, socket, close and timeout
errors; these are separate from native acceptance. Fresh Luna Max accepted the
current probe SHA256
`6115d8c112de607b93c6f40e3285301a694973ec2202247b7754040d9df18ec1`
before the one changed-byte native run. The unchanged runtime/parent and the
full-grant runner retain their original exact-source reviews.

The earlier resumed auditor switched from Luna to Sol. Its verdict failed the
model gate, but the root incorrectly launched the second run after that failed
gate. That sequence and its process result remain separate; the later current
run follows the accepted source gate. The earlier accepted v1 receipt is retained
separately and is not evidence for the repaired probe. The final receipt verifier
also preserves its initial order-sensitive input comparison failure: all 346
unique per-path seed records match; esbuild discovery order differs. No native
run was repeated for that metadata correction.

Private receipts are `core-product-session-worker-v2-audit-20261009.json`,
`core-product-session-worker-error-ports-20261009.json`,
`core-product-session-worker-receipt-20261009.json` and
`core-product-session-worker-v2-completion-proof-20261010.json` under the same
checkpoint directory. Seven committed Session modules match the candidate at
the fetched `bc027c62` frontier; this is not complete current-Core graph equality.
Owner/grant/policy preconditions remain injected. Signed production HTTP/Access,
browser lifecycle, hibernation/transcript, full #334, scientific/external-wait,
selected providers, staging/live and release acceptance remain open. #326 and
the project Goal remain open.

## Expired Access before Session upgrade — added bounded negative

One separate Worker-side case passes against the same immutable Core candidate.
A valid ISO Access-expiry header set 60 seconds in the past returns HTTP 409
`SESSION_AUTHORITY_STALE` with no socket. This observes the `/status` guard before
upgrade, not the later `onConnect` 1008 or scheduled-expiry behavior. It uses the
existing internal owner/policy/grant and service-created ledger seed, with no
Workflow or stored Session prerequisite. The three operation-specific
run/attempt/checkpoint counts remain zero; one exact grant full row is unchanged.
No all-table, transcript, R2, Queue or provider-effect conclusion follows.

Root's first direct host-proxy request carried `upgrade: websocket` and failed
with unhandled `ECONNRESET` before a child observation. That unaccepted process
and runner remain preserved; no product or platform defect is established.
The revised candidate keeps the upgrade request inside a Worker and returns
only HTTP JSON to Node. Its private runtime differs from the accepted base only
in the isolated resource tag and probe path. Original accepted four files remain
unchanged. Four syntax checks and fresh exact-four Go2 Step 5/high source review
precede the one revised native case; child exit 0/null signal and resolved dispose
pass. Separate final readback rechecks all four hashes without a runtime repeat.
The raw review's prose overstated automatic parent checks before receipt writing;
the parent checks before spawn and the final verifier checks after completion.

Receipts are `core-product-session-expired-access-{source-audit,receipt,process}-20261010.json`
and `expired-access-completion-proof-20261010.json` in the private checkpoint
directory. The mapper's earlier completed-run proposal remains unexecuted; this
root variant qualifies only the earlier expiry boundary described here. Signed
public Access/JWT, connected timers, browser, two-tab, hibernation, whole #334,
scientific/provider/live and release remain open. No implementation status or
Issue/PR is promoted. The project Goal remains active.

## Connected Access expiry — one idle-socket native case

One added case passes against the same immutable `2607583d` custom Core
candidate, actual `ResearchSession`/`ResearchWorkflow`, local migrated D1/R2 and
internal confirmatory owner/policy/grant fixture. The Worker-side client receives
one exact completed-operation projection RPC before its selected three-second
Access deadline, then sends no further frame, changes no grant and invokes no
expiry callback. The product uses its persisted Agents schedule to close the
idle connection. Node receives only HTTP JSON.

The initial RPC is observed 2,741 ms before Access expiry. Closure is observed
31 ms after the product's deadline rounded up to whole seconds, with code 1008,
reason `SESSION_AUTHORITY_STALE`, ready state 3 and a clean close. The exact grant
full row remains unchanged with research use allowed. The completed operation
remains stage 18/revision 19 with 18 attempts and 18 checkpoints. Child exits 0
without a signal and `Miniflare.dispose()` resolves. These are selected
business/grant readbacks, not an all-table or transcript zero-effects proof.

Fresh Go2 Step 5/high exact-four source ACCEPT and persisted owning-context/model
verification precede the single native attempt. The parent checks the four new
and four retained harness hashes before spawn and after child exit, before
receipt acceptance; an existing process or receipt prevents unchanged replay.
The private runtime differs from the accepted base only in its isolated resource
tag and probe path. All 346 unique seed input records match the retained baseline.
Final receipt/hash readback runs without a native repeat; seven committed Session
modules match the candidate at local frontier `edf0a0b1`. This is not whole
current-Core equality or official Wrangler emission. Tool versions, compatibility
date and flags remain those recorded for the earlier Worker-side case.

Private receipts are `core-product-session-deadline-{source-audit,receipt,process}-20261010.json`
and `session-deadline-completion-proof-20261010.json`. The raw review's routing
identity is checked against persisted metadata by root; root writes the audit
receipt. Source inference about exclusive closure causes is not broader runtime
instrumentation. No hibernation/eviction, browser/reconnect/two-tab, signed public
Access/JWT, complete #334, scientific/provider/official-build/live/release result
is established. `IMPLEMENTED_NOT_LIVE`, original Issue/PR and Goal remain open.

## Signed public JWT — retained native observation and service fixture repair

The first signed-JWT run uses the actual configured Access verifier with an
ephemeral local RS256/JWKS issuer, its development-only owner-E2E loopback hook,
public Core Worker ServiceBinding ingress and the actual ResearchSession. Identity
is verified separately in seed and Core. No injected AccessVerifier or direct
DO bootstrap is used. The existing private confirmatory policy/scope/grant seed
and immutable custom Core artifact remain explicit limitations.

The real ResearchWorkflow completes stage 18/revision 19 with 18 attempts and
18 checkpoints. The retained Worker observation records signed owner upgrade
101, exactly two strict terminal projection RPCs, missing/signature-invalid 401s,
foreign 404 and no denial sockets. Forged research/Agents authority headers do
not substitute the verified owner. One full grant row and the canonical business
tuple are unchanged; the socket closes cleanly with 1000/state 3. Both seed and
Core fetch local JWKS; Miniflare disposal resolves and the JWKS server closes.

The original process is **exit 1**, not PASS. It fails the service error-code
assertion because the fixture encodes `ACCESS_SERVICE_PRINCIPALS` as a JSON array;
the existing parser takes comma-separated names. The signed service token thus
returns `ACCESS_SERVICE_PRINCIPAL_DENIED` before owner-class authorization.
The expected `PRINCIPAL_CLASS_DENIED` is retained for a correctly configured
service principal. Product authorization is unchanged. Original child/process,
source manifest, audit and all source bytes remain preserved.

Only this failed service case was rerun for native repair: the private runtime
changes its isolated tag, probe path and that binding to the documented CSV.
The probe reaches Core through the same ServiceBinding with a signed allowed
service principal, expects 403/no socket/`PRINCIPAL_CLASS_DENIED`, reads unchanged
grant rows and zero Workflow-run rows, and creates no Workflow. Earlier observed
owner/RPC/other-negative results are rechecked from retained exact bytes. The
separate exact-four Luna Max source gate and one guarded service-only native run
pass: 403 `PRINCIPAL_CLASS_DENIED`, no socket, identical full grant rows, and
Workflow-run counts zero before and after. The repair process exits 0 with no
signal; Miniflare disposal resolves and the JWKS server closes. Source, original
observations and dependency bytes are checked again after that process. The
reconciled receipt retains the original failed process with exit 1; it never
rewrites it as a process-zero result or repeats the earlier passing cases.

The accepted source preparation separately records all 1,105 seed inputs:
345 prior dependencies unchanged, one replacement seed and 759 explicit new
verifier/Env dependencies. Exact set/object and pre/post byte equality reject
unreviewed additions. The source verdict also pins the entire raw manifest.
Fourteen public-route files retain independent working/Git raw hashes and
CRLF-to-LF-only comparison hashes without changing product bytes. Source ACCEPT
does not establish runtime acceptance; the first incomplete closure gate was
rejected before any native run.

Original evidence is `core-product-session-public-jwt-{source-manifest,source-audit,child,process}-20261010.json`;
service repair evidence is `core-product-session-service-repair-{source-manifest,source-audit,child,process}-20261010.json`;
the combined receipt is `core-product-session-public-jwt-reconciled-receipt-20261010.json`,
all in the private checkpoint directory. The repair audit was recorded only
after the actual Luna/max reviewer completed and was closed and archived; it
binds all four source hashes and the full raw manifest digest. Official Wrangler/Vite emission,
production Access, browser/reconnect/two-tab, hibernation/eviction, transcript/
all-table invariance, full #333/#334, scientific/provider/live/release and the
project Goal remain unaccepted.

## Local forced hibernation — three retained failures, October 10

All three private attempts retain their original sources, audits, child/process
observations and teardown. V1 and R2 failed before eviction while the inspector
read the platform-private `_cf_KV` and `_cf_METADATA` tables respectively.
The official workerd source at `a68d28aab029fe2c509ce42b3af9fe689b26670a`
(October 10) reserves the entire case-insensitive `_cf_` namespace. R3 therefore
retains every listed schema and explicitly marks reserved contents
`PLATFORM_PRIVATE_NOT_ASSESSED`; every nonreserved application table is read,
and unrelated SQL failures remain fatal. That rule is a pinned source reference,
not a claim that this commit identifies the installed workerd binary.

After independent Luna/max source acceptance, one guarded R3 run reached the
first forced eviction and obtained the second projection on the same socket.
The warm/restored observations contain two frames, one completed Workflow,
stage 18/revision 19 and 18 attempts/checkpoints. All 13 listed schemas and
inspectable application rows compare equal; the business/grant readbacks before
revocation also compare equal. These are partial observations from a failed
process, not complete native acceptance.

R3 failed at `revoke-hibernate`: the private assertion required D1
`meta.changes === 1`, but the actual value was 4. Installed
Miniflare `5.20260926.1-alpha` computes this metadata from the difference of
SQLite `total_changes()`, which includes trigger writes. It does not identify
the cardinality of the target grant row. Existing grant/epoch/provenance
triggers were preserved; the failure does not prove four grant rows changed.
The stale eviction/denial was not reached. Child exit 1/null signal, socket
failure teardown 1000, resolved Miniflare disposal and closed JWKS are retained.

After the third failure, native execution stopped for documentation and audit.
[SQLite total_changes](https://www.sqlite.org/c3ref/total_changes.html) and
[RETURNING](https://www.sqlite.org/lang_returning.html) were captured on
October 10; RETURNING reports directly modified rows rather than trigger effects.
The prepared R4 correction requires exactly one full returned grant row, followed
by an independent full grant readback equal to the original row except for the
explicit `research`-use removal. D1 metadata remains diagnostic. Syntax and six
changed-helper refusal cases pass; R4 native remains unrun pending independent
source acceptance. No product SQL, trigger or authority contract was changed.

Private evidence includes `session-hibernation-r3-failure-proof-20261010.json`,
the R3 source manifest/audit/process/child, and the R4 source manifest plus
`hibernation-returning-r4-fixture-20261010.json`. Reserved contents, browser
reconnect/two-tab, automatic production hibernation, official generated routing,
staging/live and complete #333/#334 acceptance remain unassessed. Goal is active.
