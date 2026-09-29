# Backend delivery plan

Current execution order, reconciled on 2026-09-29 against `main`
`25be3164b7aee8e76f83f5e60808641ac58c4b0a`.

This is the volatile handoff and queue. Refresh `origin/main` and the active task before editing. [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292) preserves the original S01–S99 passports and negative acceptance criteria; it is not a second queue.

## Completion boundaries

Keep these states separate:

1. **code delivered at an exact SHA**;
2. **known residual code**;
3. **acceptance pending**;
4. **live qualified**.

The current phase is product code first: compilation, scoped lint, the depth-100 SQL compiler when relevant, and minimal Clippy for Rust changes. Broad behavioral/browser/native/mutation/live suites follow assembly. Deferred checks remain mandatory and must not be labelled `PASS`.

## Current active checkpoint — S37 / #229

### What is already in `main`

| SHA | Delivered |
|---|---|
| `c25df085` | Recovered the exact historical S37 patch, published strict branch contracts, removed the obsolete writable publisher and closed #299. |
| `b98ee60f` | Added one shared governed branch executor for `READ_AND_EXTRACT`, `ANALYZE_BRANCHES` and `COUNTER_SEARCH`, with exact scope/protocol/planning/W1/stage-five revalidation and receipt-based recovery. |
| `25be3164` | Registered `research-handlers.exploratory.v7`, connected the shared executor to the stage factory and started-attempt recovery, and retained fail-closed missing-handler behavior. |

### Exact current boundary

`v7` is registered but **not active**:

- new explicit-protocol admissions still select `v6`;
- stored `v5/v6` runs keep their original semantics;
- semantic composition does not yet pass branch-executor dependencies;
- EvidenceFreeze does not yet bind the committed branch reconciliation, contradiction refs or open ResearchDebt;
- the current branch executor emits evidence-bound candidate material but performs no role model calls and no W1 observation mutation.

Do not describe S37 as complete or executable end-to-end.

### Next checkpoint: activate v7 and bind reconciliation into EvidenceFreeze

Task: [S37 / #229](https://github.com/UnknownAlienHuman/eliot-research/pull/229).

Expected source paths:

```text
apps/eliotr-core/src/research-session.ts
apps/eliotr-core/src/research-semantic-composition.ts
apps/eliotr-core/src/research-evidence-freeze-composition.ts
packages/cloudflare-research/src/research-evidence-freeze-composition.ts
packages/cloudflare-research/src/research-evidence-freeze-preparation.ts
```

`research-retrieve-branches.ts` and `research-stage-handlers.ts` already contain the published v7 registration/factory work. Do not rewrite them unless a concrete integration defect requires it.

Required result:

1. newly admitted requests carrying the explicit installed InquiryProtocol select `v7`;
2. idempotent replay keeps the previously stored handler generation; persisted `v5/v6` remains accepted and unchanged;
3. semantic composition supplies the existing shared branch executor with the same database, Work R2, navigation, ledger and committed stage-five reader;
4. v7 EvidenceFreeze requires the exact committed branch reconciliation and binds its identity, unresolved contradiction refs, unmet roles and open ResearchDebt into freeze preparation/currentness;
5. legacy generations retain their existing freeze input and lineage; do not reinterpret old receipts as v7;
6. a missing, foreign, corrupt or stale v7 reconciliation fails closed instead of falling back to the legacy path;
7. recovery continues through the same stored generation and checkpoint identities.

Verification for this code-first checkpoint:

```text
TypeScript build: contracts + cloudflare-research + eliotr-core
scoped ESLint for changed production files
package boundaries
work-packet ownership
whitespace / diff check
```

No broad test, workflow dispatch, deployment, provider call or remote migration is implied. Record those as pending.

### Following S37 checkpoints

After v7 activation/freeze binding, continue #229 in this order:

1. **Semantic role execution.** Use the installed prompts and existing model-attempt/reservation/W3 ports for only the required SUPPORT, COUNTER, ALTERNATIVE, CHRONOLOGY, IMPLEMENTATION, LITERATURE and SOURCE_AUDIT roles. An absent role must cost zero calls. Source-class heuristics alone are not substantive branch execution.
2. **Settle W1 observations.** Append only permitted evidence-bound observations with stable branch identities. Do not rewrite protected portfolio/debt refs. Identical replay is a no-op; conflict is integrity failure.
3. **Counter/reconciliation truthfulness.** Preserve contradiction, failed-probe, unmet-role and independence information through freeze. Duplicate origins cannot satisfy missing independent support.
4. **Duration, budget and recovery.** Classify actual paid I/O, keep every expensive call behind existing W3 authority, recover committed output before redispatch, and block new work after cancellation/deadline/currentness failure.
5. **Assembly acceptance.** Retain the S37 passport's named fixtures and native restart/lost-ACK/concurrency cases for the later acceptance phase. Real-model quality remains S93.

## Delivered checkpoints that must not be restarted

| Area | Delivered code boundary | Remaining boundary |
|---|---|---|
| Queue/audit reconciliation | `bf1ffa2e` | Selected residual tasks still need exact current-main disposition. |
| D1 depth compiler | `fc25ee02` | #294 dynamic-query coverage and native acceptance. |
| D1 authority/grant/control repair | `7d2bb36` | #293 native negative/replay/concurrency acceptance. |
| Full lint/error retention | `eaa4efa` | #296 focused fault/replay acceptance. |
| CI independent reporting/root selection | `a76acd98` | #295 structural resource work and #304 execution acceptance. |
| S37 source/contracts/executor/factory | `c25df085`, `b98ee60f`, `25be3164` | Active v7 admission/freeze binding, then substantive role/W1/budget execution. |

Also reuse the already delivered project/client grants, machine HTTP/MCP readers and controls, owner historical reads, long-run authority, append-only project attachment, normalized bundle ingestion, runtime failure diagnostics and reconnect intent. Their exact lineages remain in #202–#205, #209, #211, #223–#225, #290 and #291. Open planning cards do not mean those systems are wholly absent.

## Queue after S37

Finish the active checkpoint before switching. Then resume this dependency order:

| Order | Tasks | Next product result |
|---|---|---|
| A | S29/#221, S34/#226; verified residuals in S10–S15, S31–S33, S98–S99 | Finish selected-profile configuration/qualification and genuine machine-path gaps without reimplementing delivered grants, controls, importer or readers. |
| B | S21–S23 and remaining S38–S46 | Complete truthful procedure reporting, protocol execution, observations, freeze/debt/supersession, verifiers and product handlers on the shared Research engine. |
| C | S47–S61 | Complete source/navigation/index boundaries, requested coverage, artifacts/publication, Workspace candidate admission/readback and federation. Prioritize dependency-ready S50–S52 and S58/S59. |
| D | S62–S72 | Complete erasure closure, outbox/DLQ/reconciliation, backup/isolated restore, rollback, Steward and durable events. |
| E | S20/#212, S73–S77, #298/#305 | Complete human Library/Connections/artifact flows and Windows layout/session-aware browser fixtures after product assembly. |
| F | S78–S89, #106/#176 | Complete deterministic Rust families, versioned Wasm promotion and removal of superseded TypeScript authority family by family. |
| G | S18/#210, S30/#222, S90/#282, S91/#283 | Reconcile composition, implementation states, emitted artifacts/runtime budgets and D1 mutation boundaries. |

After code assembly: reconcile #297 and #305, verify #298 independently, run S92 local integration before S94 staging, then S93/S95/S96 on the attested build and S97 release acceptance.

## Cross-cutting open records

These are not permission to interrupt the active checkpoint unless they block its code:

- #293/#294 — delivered SQL/compiler repairs; native/dynamic-query acceptance remains;
- #295/#304 — delivered CI wiring/selection; resource and real execution acceptance remains;
- #296 — delivered lint/error repair; fault/replay acceptance remains;
- #297 — historical root-suite failures require per-file code-vs-fixture disposition during assembly acceptance; the old count is not a current census;
- #298/#305 — browser fixture/session first, Windows geometry separately;
- #300/#301 — bounded documentation/task reconciliation alongside code;
- #302 — external hostname/account decision requires explicit operator authorization and does not block coding;
- #106/#176 — deterministic Rust mutation/test-strength debt.

#299 is complete. Do not reopen or recreate the S37 payload-recovery task.

## Agent checkpoint protocol

Every active-task comment should state:

```text
Baseline: <exact main SHA>
Delivered before this checkpoint: <SHAs and boundaries>
Residual code: <one precise result>
Owned files: <exact paths>
Static verification: <commands actually run>
Acceptance deferred: <named tests/live work not run>
```

Publication rules:

- main only, no new worktree/task branch;
- one coherent checkpoint per commit;
- refresh `main` immediately before creating the commit;
- non-forced fast-forward only;
- verify the remote ref and published commit file list after the write;
- use `Refs #NNN` with the actual task;
- update the task discussion and this plan whenever the active boundary changes;
- never claim publication from a local patch, unattached blob or prepared manifest.

## Preserved scope and safety

Mandatory baseline remains v1 and Slices 0–6. [ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md)
makes model providers, external agents and Google tools independent choices; Muse may replace Spark.
The currently recorded `gemini-mcp` release configuration is not a mandatory vendor choice. Explicit
`disabled` is valid for a Google-free release; configuration and registry must still agree. Unselected
integration gates do not block other work. S29/profile and S10–S13/S98–S99 client work implement the
remaining selection/adapter changes without redoing delivered services. The active S37 checkpoint is unchanged.

No branch deletion, force push, pushed-history rewrite, live deployment, provider spending, hostname change or remote database migration is authorized by this plan.
