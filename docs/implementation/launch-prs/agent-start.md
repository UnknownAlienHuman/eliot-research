# Start an agent on a launch checkpoint

Use current main plus the selected existing PR head. Reviewed code baseline is f94bd7a; do not start
from the old 92118fa/2e554f2 planning tips. Task refresh changes documentation only; it launches no agent,
implements no missing feature, and authorizes no deployment.

Read [execution-contract.md](execution-contract.md), the selected numbered plan and its cited canonical
sections/ER packets. The plan's tests and good-result conditions are mandatory, not suggestions.

## Default first wave: three independent code tasks

| Agent | PR / checkpoint | Exact assignment |
|---|---|---|
| Retrieval | #90 Q1 | Reuse `lanes.ts`, current managed decoder and real ingest/outbox/projection executor. Implement and test one bounded parameterized D1 lane fed from an admitted source; no pre-seeded finished index and no PWA edits. |
| Google | #95 G1 | Wire reviewed server configuration and owner-only begin into the existing OAuth admission service. Derive owner/session from verified Access, never request claims. Do not rewrite RSA/state/PKCE/vault or activate an unqualified exchange. Coordinate HTTP/Env through ER-21/24. |
| Rust | #97 K1 | Audit current shared vectors and close initial namespace-owner identity parity using the actual ER-44 implementation plus native/Wasm execution. Do not rewrite existing primitives, change stored hashes or promote an untested family. |

A fourth UI/runtime agent is not automatically authorized. #98 L1 may replace one slot to establish the
shared Playwright/local-storage harness. Other independent checkpoint work may be scheduled only after
exact-path conflict review. All UI belongs to ER-25; all shared code is integrator-serialized.

## Start/finish message an agent must post in its PR

```text
Claim: <checkpoint ID>, <ER owner>, base main=<SHA>, head=<SHA>
Files: <exact existing/new paths; shared-file owner approvals>
Inputs: <accepted predecessor commit/fixture/artifact references>
Tests: <named success, negative, race, restart and bound tests>
No account changes: true
```

At finish replace intent with evidence: commands, exit codes, before/after regression, durable identity
and expected/actual states, output SHA, contract/migration impact and unchecked follow-ups. No test count
alone closes a task. No secrets or source payloads in comments. Keep a theme draft until all its local
code acceptance passes; preserve live work separately as NOT_EXECUTED. An owner-requested partial merge
must keep the incomplete theme tracked rather than silently close it.

## Existing code agents must not duplicate

Library: normalized-folder upload, same-tab/reload/lost-ID recovery, namespace/read-policy local setup,
Library-to-metadata-Lens and recorded-only revision history are on main. #98 now owns their remaining
raw-file/project/active-readiness/error/full-browser acceptance.

Google: G1a REST/serializer, encrypted vault/D1 refresh and internal first OAuth admission are on main.
Use `drive-rest.md`, `drive-credentials.md`, `drive-oauth-admission.md`. Required Drive stays IN_PROGRESS;
optional Gemini is not a substitute. First admission deliberately returns AUTHORIZING, not ACTIVE.

Rust: M1 plus narrow canonical JSON/SHA/generation/residency shadow primitives exist. They accept their
current schema domains (including safe-integer canonical-body rules), not every imaginable JSON value.
M5 is Wasm/shadow, M6 promotion and M7 superseded TS removal. See #97's per-family checklist.

## When account agents may start

They may implement test/probe runners locally now. They may NOT start provisioning/deploy to finish code.
O6/O7 in #96 and the shared handoff govern first complete staging; O8 governs production qualification.
`pnpm launch:code` currently must fail. All nine local code checklists, complete integrated user loops,
critical Rust promotion, full exact-head CI and an explicitly approved isolated target are required.
Real T4/T6 receipts are generated during/after that first staging trial, not fabricated beforehand.

Use the checkpoint dependency graph in README.md. A blocked integration task does not authorize a stub
service: take only an independent specified predecessor or report the precise missing dependency.
