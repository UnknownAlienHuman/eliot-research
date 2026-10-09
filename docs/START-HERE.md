# Start here

This is the only repository entry point for implementation work.

## Current authorities

- Current backend execution order and dependency-ready cards: [backend-entrypoints.md](implementation/backend-entrypoints.md).
- Owner-resumed checkpoint and historical evidence: [backend-delivery-plan.md](implementation/backend-delivery-plan.md).
- Repository boundaries: [AGENTS.md](../AGENTS.md).
- Packet ownership: [agent-work/README.md](agent-work/README.md), `manifest.json` and validated fragments.
- Implemented/scaffold/live state: [implementation-status.json](implementation/implementation-status.json).
- Known blockers: [gap-register.md](implementation/gap-register.md).
- Original S01-S99 requirements: [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292).

### Owner web

- Exact frontend DAG: [frontend-owner-execution-map.md](agent-work/frontend-owner-execution-map.md).
- Autonomous manager operation: [frontend-autonomous-manager-runbook.md](agent-work/frontend-autonomous-manager-runbook.md).
- Current-main reconciliation: [frontend-current-contract-amendment-2026-10-09.md](agent-work/frontend-current-contract-amendment-2026-10-09.md).
- React presentation: [ER-47](agent-work/ER-47-owner-web-interface.md).
- Owner-client extraction: [ER-48](agent-work/ER-48-owner-api-client-extraction.md).
- Leaf scheduler: [ER-49](agent-work/ER-49-frontend-leaf-scheduler.md).
- Platform/runtime: [ADR-0016](adr/0016-react-cloudflare-owner-ui.md) and
  [ADR-0017](adr/0017-owner-web-browser-runtime-and-tooling.md).
- Stack/cutover: [stack validation](implementation/frontend-stack-validation-2026-10-08.md) and
  [cutover inventory](implementation/frontend-cutover-inventory-2026-10-08.md).
- Product design: [OWNER_WEB_UI.md](design/OWNER_WEB_UI.md).
- Live reference and autonomous execution: [NotebookLM/Material protocol](agent-work/frontend-notebooklm-material-reference.md)
  and [autonomous manager runbook](agent-work/frontend-autonomous-manager-runbook.md).

The current-main amendment is mandatory for every affected checkpoint. It supersedes dated frontend inventory
assumptions only for the topics it names; exact current TypeScript contracts remain authoritative.

ER-25 remains served compatibility until cutover. ER-47/48 are manager packets with empty coarse dependencies;
execution map owns real leaf prerequisites/handoffs. ER-49 owns static scheduling mechanics. After PR #329 is
merged, Issue #335 authorizes one manager to execute F1-F4 continuously through U5-X. U1-D and U2-X are internal
quality gates; the first owner UI review is the finished integrated interface before merge/deploy. One durable owner comment may authorize an autonomous
tranche; that removes per-checkpoint continuation prompts but does not expand path, merge, deployment or account
authority.

Before ER-49 acceptance, maximum concurrency is one frontend manager plus one leaf. Afterward:

- manager publishes claims only in its packet-owned directory;
- claim commit is a strict ancestor of covered source edits;
- every source-edit commit has exactly one active covering claim in parent tree;
- same-commit claim+source, unclaimed/out-of-scope edit and overlap fail;
- one active claim per checkpoint and one active manager context per packet;
- predecessor refs name checkpoint and reachable ancestor commit; manager/external gates include approval ref;
- ER-49 validates mechanics, not semantic truth of human approval or test evidence.

Historical service-worker-registering PWA is not post-retirement rollback. U6 prebuilds an attested online
legacy rollback without registration/old fetch worker and retains permanent inert `/sw.js`.

Open planning PRs, old Launch plans and audits are evidence, not competing queues.

## 1. Orient from current main

```bash
git fetch origin --prune
git log --oneline -5 origin/main
git status --short
pnpm launch:code
pnpm work-packets:check
pnpm check:implementation-status
gh pr view 327
gh pr view <assigned-task> --comments
```

Read in order:

1. dependency-ready card in `backend-entrypoints.md` and owner-resumed checkpoint in delivery plan;
2. latest assigned-task comment;
3. `AGENTS.md`;
4. owning packet;
5. exact architecture/source named by checkpoint.

For ER-47/48, read the exact execution-map block and current-main amendment first. Do not infer current work
from old PR body, branch name, audit percentage, PR count or local patch. `origin/main` plus current task
discussion is authoritative.

## 2. Claim one checkpoint inside the authorized program

A tranche manager claims/delegates one checkpoint at a time but continues through the tranche automatically.
Post:

```text
Baseline: <exact origin/main SHA>
Packet / checkpoint: <one bounded result>
Manager + manager context: <one owner-authorized packet context>
Owner authorization: <immutable issue/PR comment or accepted evidence reference>
Owned files: <canonical exact repository paths>
Predecessor refs: <checkpoint IDs + ancestor commit SHAs + gate approval refs where required>
Exit: <commands, negative case, human gate when named>
Deferred: <browser/native/staging/live checks not run>
```

Rules:

- direct main is default;
- owner may authorize exactly one manager worktree/review branch with manager, base SHA, scope and stop;
- one leaf receives one exact checkpoint inside manager context;
- no subagent creates another branch/worktree, manifest, barrel, migration or shared fixture;
- manager branch does not lift stop, expand ownership, satisfy dependencies or authorize merge/deploy/account
  mutation;
- before ER-49, no more than one frontend leaf;
- after ER-49, claim must be committed and validated before source edits;
- shared root/Worker/CI/deploy files require named integrator;
- if `origin/main` moves, reconcile before publication; never force-push except the exact owner-authorized
  manager review branch under an expected-head lease;
- finish/handoff before next checkpoint.

ER-47 owns web/UI/tests/scripts and ER-47 claims. ER-48 owns owner client, three legacy browser packages and
ER-48 claims. ER-49 owns static registry/checker. ER-25 is compatibility authority and bounded U6 rollback
handoff—not ER-47/48 completion prerequisite.

## 3. Implement one authority path

When implementation resumes:

- TypeScript: scoped compile/ESLint;
- SQL: depth-100 compiler + migration/constraint fixtures;
- Rust: compilation and applicable Clippy/native/differential gates;
- owner UI: stories, browser/visual/a11y/CSP/performance/rendered inspection;
- owner client: import-side-effect, strict decoder, headers/status/body/range-validator/lifecycle and legacy
  compatibility;
- broad repository/native/live suites follow assembly unless checkpoint names narrow gate.

`pnpm check:affected` runs full repository check. Deferred checks are `PENDING`, never PASS.

Reuse contracts/stores/Workflow/authority readers. Missing composition is not permission for another engine.
Every mutation remains:

```text
Intent → Attempt → Receipt → Readback → Reconciliation
```

No HTTP/model/R2/crypto inside D1 transaction. Lost acknowledgement is `UNKNOWN`, not permission to repeat
paid/storage effect or mint identity.

Owner-web changes presentation/lifecycle/client organization—not Worker/retrieval/evidence/Research authority.
Polling remains canonical progress/readback fallback. The accepted authenticated ResearchSession route is an
`IMPLEMENTED_NOT_LIVE` presentation transport owned through ER-48; event/data gaps, reconnects and old epochs
reconcile through canonical readback and never create/repeat a run. Exact range bytes require admitted
revision, strong validator/conditional and untransformed representation.

### Human gates

- **U1-D:** owner-visible approval of coherent golden direction before production shell assembly. Token swatches,
  isolated components or green pixel tests are insufficient.
- **U2-X:** recorded no-hint owner walkthrough of project → source → question → exact evidence → supported
  artifact → Connections recovery. Automated clicks cannot substitute.

## 4. Publish safely

Before:

```bash
git fetch origin --prune
git diff --check
```

Use authenticated Git or authorized GitHub Git Data API. Update main only non-forced fast-forward from
refreshed expected head unless owner requested review PR. An owner-authorized manager review branch may be
rebased/squashed only with exact expected-head force-with-lease; never rewrite another manager's branch.

After:

1. read main ref again;
2. verify file list;
3. post SHA, commands/results, negative/human gates and remaining work;
4. update active router/plan when queue changed.

A local patch, manifest, claim or unattached blob is not published work.

## 5. Authority map

| Need | Read |
|---|---|
| Backend router/cards | [backend-entrypoints.md](implementation/backend-entrypoints.md) |
| Owner-resumed checkpoint/history | [backend-delivery-plan.md](implementation/backend-delivery-plan.md) |
| Frontend DAG | [frontend-owner-execution-map.md](agent-work/frontend-owner-execution-map.md) |
| Current frontend/backend reconciliation | [frontend-current-contract-amendment-2026-10-09.md](agent-work/frontend-current-contract-amendment-2026-10-09.md) |
| Static scheduler | [ER-49](agent-work/ER-49-frontend-leaf-scheduler.md), then registry after implementation |
| ER-47/48 claims | `agent-work/frontend-owner-claims/ER-47/`, `ER-48/` |
| React / client | [ER-47](agent-work/ER-47-owner-web-interface.md), [ER-48](agent-work/ER-48-owner-api-client-extraction.md) |
| Platform/runtime | [ADR-0016](adr/0016-react-cloudflare-owner-ui.md), [ADR-0017](adr/0017-owner-web-browser-runtime-and-tooling.md) |
| Cutover | [frontend-cutover-inventory](implementation/frontend-cutover-inventory-2026-10-08.md) |
| Design/human gates | [OWNER_WEB_UI.md](design/OWNER_WEB_UI.md), [agent harness](implementation/frontend-agent-harness.md) |
| Product/state | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md), named sections only |
| Runtime ownership | [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md), ADR-0007 |
| Status/gaps | [implementation-status.json](implementation/implementation-status.json), [gap register](implementation/gap-register.md) |
| Failure/security | [failure-model.md](implementation/failure-model.md), [security checklist](implementation/security-checklist.md) |
| Branch/tools | [branch-discipline.md](implementation/branch-discipline.md), [toolchain.md](implementation/toolchain.md) |

Conflict stops work and names exact issue; no leaf-local hidden exception.

## 6. Final acceptance

GitHub Actions are manual-only. Do not restore automatic triggers or broad workflows without authorization.

After assembly: S92 local integration → S94 staging → S93/S95/S96 on attested build → S97 release.
`pnpm check:full` does not replace ordered release acceptance.

Compilation, docs, screenshots, stories, benchmarks, claims, MCP responses, Explorer traces, Preview URLs,
emulators, Workflow completion or provider acceptance alone do not establish readiness.

Cutover additionally requires exact Vite graph, no-registration rollback, permanent non-claiming tombstone,
controller-null inbox recovery and first-paint privacy mask in one reviewed receipt family.

## 7. Never treat these as permission

- branch age/count or closed PR;
- stale planning head/audit estimate;
- configured client ID without verified possession;
- index hit without exact authorized evidence bytes;
- screenshot/benchmark without exact source/build/fixture/browser identity;
- claim/predecessor reference without accepted work/evidence;
- attractive component set without U1-D approval;
- automated journey without U2-X owner walkthrough;
- local Golden fixture integrity as product/visual promotion;
- historical legacy artifact as post-retirement rollback;
- optional managed OAuth/unselected Slice 7 as baseline blocker;
- missing local Git credentials as proof GitHub write access is unavailable.
