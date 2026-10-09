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

Remaining acceptance includes production pause/resume, complete scientific `consumeResult`,
pinned production configuration, COMPUTER route, public HTTP/JWT, foreign/
malformed/late events, timeout/result boundary, restart/completed predecessors,
historical generation, selected-profile native/live and release receipts. Passing
bounded source or fixture cases do not close those gates.
