# Backend delivery plan

Current execution order, reconciled on 2026-10-01 against `main`
`8db894c6da834cd337cdd6f0d7057545af4e18fa`.

This is the volatile handoff and queue. Refresh `origin/main` and the active task before editing. [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292) preserves the original S01–S99 passports and negative acceptance criteria; it is not a second queue.

## Completion boundaries

Keep these states separate:

1. **code delivered at an exact SHA**;
2. **known residual code**;
3. **acceptance pending**;
4. **live qualified**.

The current phase is product code first: compilation, scoped lint, the depth-100 SQL compiler when relevant, and minimal Clippy for Rust changes. Broad behavioral/browser/native/mutation/live suites follow assembly. Deferred checks remain mandatory and must not be labelled `PASS`.

## Current active checkpoint — S92 local integration

92.1 is delivered (`8db894c6`): six browser-harness scenarios in
`tests/integration/browser/s92-intake.mjs` — owner identity (RS256),
local config readiness, project admission, read-policy grant, model D1
fail-closed, Library/Lens exact readback — registered as real `node:test`
assertions in `tests/integration/browser/library.spec.ts`. Honest states:
5 PASS + 1 PENDING_OWNER_D1B (live-model assertions need owner decision
D1(b)). Every scenario drives the real harness (`scripts/lib/local-*.mjs`,
`owner-e2e.mjs`) against in-memory SQLite seeded with the real migration
DDL; no new browser framework.

92.2–92.6 (delegation, products, continuity, COW, negatives) and the local
runbook / INPUT draft are in flight. The S92 done-state requires
`pnpm test:local-launch`, `test:local-owner`, `local:prepare`,
`local:smoke`, `test:owner-e2e`, `cf:types`, `build`, `cf:dry-run` and full
F on applicable CI platforms; unexecuted checks stay pending, never PASS.
D1(a) applies: no local fake model gateway exists — configuration and
readiness fail-closed only; anything needing a live model response stays
`PENDING_OWNER_D1B`.

After S92: S94 staging is blocked — staging isolation is unresolved
(Option A: env-suffixed resource names + deny-list guard, Option B:
separate Cloudflare account) and no live deployment is authorized — then
S93/S95/S96 on the attested build, then S97 release acceptance.

## S37 / #229 — code delivered, do not restart

Task: [S37 / #229](https://github.com/UnknownAlienHuman/eliot-research/pull/229).

### What is in `main`

| SHA | Delivered |
|---|---|
| `c25df085` | Recovered the exact historical S37 patch, published strict branch contracts, removed the obsolete writable publisher and closed #299. |
| `b98ee60f` | Added one shared governed branch executor for `READ_AND_EXTRACT`, `ANALYZE_BRANCHES` and `COUNTER_SEARCH`, with exact scope/protocol/planning/W1/stage-five revalidation and receipt-based recovery. |
| `25be3164` | Registered `research-handlers.exploratory.v7`, connected the shared executor to the stage factory and started-attempt recovery, and retained fail-closed missing-handler behavior. |
| `d252eb69` | Bound research branches into EvidenceFreeze: exact committed v7/v8 branch reconciliation required before freeze; checkpoint, W2 attempt and request identity bound into manifest/freeze refs; unresolved contradictions and open ResearchDebt derived server-side; legacy v2 freeze bytes unchanged. Refs #229. |
| `70dc0965` | Hardened branch freeze lineage: reopen exact committed Stage7/Stage8 outputs before accepting Stage9 reconciliation; exact required-role coverage, nested branch identities, canonical contradiction derivation, one-to-one canonical OPEN debt per blocked role. |
| `16ced6eb` | Passed `branch_execution` deps (database, Work R2, committed stage-five reader, role model) from semantic composition into the workflow handler factory. |
| `a3930696` | Substantive model-backed execution for v7 branch roles: per-role model calls behind W3 admission, installed prompts, model-attempt/reservation ports. |
| `b5ea49df` | Settled W1 observations after v7 branch execution, wired into the session execute path. |
| `8250ff20` | Bound COUNTER to committed read-extract bytes, not analysis output. |
| `fb1c9167` | Branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH (1/2): admission port branch-role awareness. |
| `bccd6037` | Branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH (2/2): `admitBranchRole` spend-policy path and policy readers. |
| `05c3c3a1` | Gated W1 branch settling behind branch-execution handler generations, with a regression test for the legacy settling path. |
| `2d1d0ae6` | S37 branch-role unit tests: executor binding, output schema boundaries, preparation fail-closed. |
| `68678041` | S37 `model.roles` server wiring: per-role evidence packs derived only from the frozen stage-five pack (Variant A), deterministic manifest refs, roles assembled in the semantic server; registry contours. |
| `d6041be7`, `331a41b8` | Registered S37 subsystem contours in `implementation-status.json`: 43 exact contours, all `IMPLEMENTED_NOT_LIVE`, 0 `LIVE_QUALIFIED` (`scripts/check-implementation-status.mjs` exit 0). |
| `71348bb2` | T5-A erasure-restore live-gate trial runner (ingest/erase/absence-readback/purge-replay). |
| `0d796ba9` | T5-B prompt-injection trial runner (gate `T5-prompt-injection`). |
| `90f694d0` | T5-C failure-injection trial runner (gate `T5-failure-injection`). |
| `f067fe9c` | T5-D disclosure-audit trial runner (gate `T5-disclosure-audit`). |
| `178f7b25` | T6 representative-load trial runner (gate `T6-representative-load`). Gates enumerated in `tests/integration/live-gates.example.json` (13 gates). |
| `55c83038` | S96 live cost observer + settlement (`research-model-spend-observation`). |
| `b7b7d657` | S37 hardening (1/2): `admitBranchRole` role↔stage fail-closed binding in the spend policy; port-layer re-validation at write time. |
| `90dcfdff` | S37 hardening (2/2): migration `0095` adds the `role` column to `research_model_spend_admission` with a stage-tied CHECK, bound into the admission digest; new tests. |
| `8db894c6` | S92 92.1 intake scenarios + `library.spec.ts` registration (see active checkpoint above). |

### Exact boundary

- `v7` (`research-handlers.exploratory.v7`) is the selected generation for new
  explicit-protocol admissions (`SERVER_OWNED_BRANCH_HANDLER_GENERATION` in
  `apps/eliotr-core/src/research-session.ts`); delegated computer-agent runs
  select `v8` (`SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION`); idempotent
  replay keeps the previously stored handler generation; persisted `v5/v6`
  (and other prior generations) remain accepted and unchanged.
- Semantic composition passes `branch_execution` deps (database, Work R2,
  committed stage-five reader, navigation, ledger, role model) into the stage
  handler factory.
- EvidenceFreeze requires the exact committed v7/v8 branch reconciliation
  before freeze: a missing or inconsistent lineage fails closed
  (`WORKFLOW_AUTHORITY_STALE`), never falling back to the legacy path;
  contradiction refs are derived server-side; a canonical OPEN ResearchDebt is
  recorded per blocked role; legacy v2 freeze bytes are unchanged.
- The branch executor performs per-role model calls behind branch-aware W3
  spend admission (`admitBranchRole`) and settles W1 observations after
  execution, gated behind branch-execution handler generations; COUNTER binds
  committed read-extract bytes.
- `model.roles` is assembled in the semantic server from the installed
  `ELIOTR_MODEL_PROFILE_DEFINITION_JSON` model policy, evidence
  authority/resolver ports and the committed stage-five reader; per-role packs
  are filtered views of the frozen pack with exact frozen digests and
  receipts; absent `config.roles` means roles are not passed at all
  (fail-closed current behavior).
- T5-A/B/C/D and T6 trial runners are code-delivered; their attested/live
  gate runs are acceptance-pending, not PASS.
- S96 cost observer is code-delivered; live qualification is pending.

Do not describe S37 as live-qualified or acceptance-complete. The remaining
work is acceptance (assembly, S93 real-model quality), not code.

### Known S37 residual — separate packet, do not fold into 0095

`research_model_spend_admission` still carries migration 0046's
`CHECK(stage_index IN (12, 13, 14))`, and the 0084 trigger
`research_model_spend_admission_w2_guard` maps only stages 12/13/14
(`SYNTHESIZE`/`VERIFY`/`AUDIT_CLAIMS`). Stage 8/9 branch admissions
(`ANALYZE_BRANCHES`/`COUNTER_SEARCH`) cannot be inserted at the DB layer,
so the 0095 role CHECK is vacuous for branch stages until the table is
widened. Widening needs a table rebuild plus trigger updates; do not widen
0095's CHECK alone.

## Delivered checkpoints that must not be restarted

| Area | Delivered code boundary | Remaining boundary |
|---|---|---|
| Queue/audit reconciliation | `bf1ffa2e` | Selected residual tasks still need exact current-main disposition. |
| D1 depth compiler | `fc25ee02` | #294 dynamic-query coverage and native acceptance. |
| D1 authority/grant/control repair | `7d2bb36` | #293 native negative/replay/concurrency acceptance. |
| Full lint/error retention | `eaa4efa` | #296 focused fault/replay acceptance. |
| CI independent reporting/root selection | `a76acd98` | #295 structural resource work and #304 execution acceptance. |
| S37 source/contracts/executor/factory | `c25df085`, `b98ee60f`, `25be3164` | v7/v8 admission, freeze binding, substantive role execution, W1 settling, branch-aware budget, `model.roles` server wiring, admission hardening (migrations through `0095`) and the 43-contour registry are delivered (see S37 record above). Do not restart them; remaining work is acceptance (assembly, S93 real-model quality) plus the known stage 8/9 DB-widening packet. |

Also reuse the already delivered project/client grants, machine HTTP/MCP readers and controls, owner historical reads, long-run authority, append-only project attachment, normalized bundle ingestion, runtime failure diagnostics and reconnect intent. Their exact lineages remain in #202–#205, #209, #211, #223–#225, #290 and #291. Open planning cards do not mean those systems are wholly absent.

## Queue after S92

Finish the active checkpoint before switching. Then resume this dependency order:

| Order | Tasks | Next product result |
|---|---|---|
| A | S34/#226; S29 workspace-candidate admission gate delivered (`37ba91eb`, `5e7ed589`) as `IMPLEMENTED_NOT_LIVE`; verified residuals in S10–S15, S31–S33, S98–S99 | ER-36 fail-closed `evaluateWorkspaceCandidateAdmission` bound to durable `OBSERVED_MATCH` v2 plus a separate owner-issued exact-candidate authorization. Two genuine code residuals remain: S29/#221 immutable semantic configuration revision (`ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0`/`_1` still read in `apps/eliotr-core/src/env.ts`); S34/#226 lazy model-proof renewal single-flight (same-key replay returns `DYNAMIC_ROUTE_PROMOTION_CONFLICT`, no cross-operation single-flight in `packages/cloudflare-ai/src/dynamic-route-provisioning.ts`). Finish selected-profile configuration/qualification and genuine machine-path gaps without reimplementing delivered grants, controls, importer or readers. |
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
remaining selection/adapter changes without redoing delivered services. The active checkpoint is S92 local integration; S37 code is delivered (acceptance pending).

No branch deletion, force push, pushed-history rewrite, live deployment, provider spending, hostname change or remote database migration is authorized by this plan.
