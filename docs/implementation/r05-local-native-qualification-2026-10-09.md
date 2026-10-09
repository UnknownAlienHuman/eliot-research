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
| Paused native delivery after expiry | UNRESOLVED: three attempts stopped for audit. |

The retained progressive record holds the first four cases; it is not a complete
aggregate suite receipt. Separate receipts retain payload baseline/fix,
revocation/cancellation and direct settlement. The earlier standalone early-result
receipt predates payload admission and must not substitute for the later scope.
Private files are under `.eliotr-state/backend-full-20261008/`:

- `native-canonical-retained-progress-20261009.json` (preserved progressive snapshot);
- `native-canonical-receipt-{pre0132-,}canonical-payload-generation-fence.json`;
- `native-canonical-receipt-canonical-cancelled-before-wake_canonical-revoked-before-wake.json`;
- `native-canonical-receipt-canonical-known-result-direct-after-expiry.json`.

## Unresolved paused continuation

The result commits before both original lease and W2 budget expiry. Delivery is
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

The current [Workers API reference](https://developers.cloudflare.com/workflows/build/workers-api/),
retrieved October 9, documents a timeout exception but does not specify a public
pause/timeout discriminator in the returned excerpt. Do not introduce a guessed
error-message check or treat internal Miniflare strings as a production contract.

Remaining acceptance includes pause/resume, exact scientific `consumeResult`,
pinned production configuration, COMPUTER route, public HTTP/JWT, foreign/
malformed/late events, timeout/result boundary, restart/completed predecessors,
historical generation, selected-profile native/live and release receipts. Passing
bounded source or fixture cases do not close those gates.
