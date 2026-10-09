---
title: "Backend implementation entry points"
date: 2026-10-08
status: "current execution router after audit handoff"
source_baseline: "3e6c25660c1ae515760e19d5f9e6b8a735795c4c"
audit_pr: 327
---

# Backend implementation entry points

**Owner-resumed full continuation, 2026-10-08:** the owner assigned this chat all
remaining documented implementation and acceptance except website design, with
up to ten leaf workers. On October 9 the owner requested a gradual move from
Luna Max to `opencode-go2/step-5-preview-free`, after each Luna finishes its
assigned checkpoint. The named integrator and workers use the existing
`main` checkout with disjoint write sets. The manager/worktree examples below
describe the historical audit handoff protocol; this run creates no additional
worktree. The Goal remains active across checkpoints and publication. Explicitly
canceled backup/export/restore and replay of the historical uncertain run remain
excluded. Refer to [the active delivery plan](backend-delivery-plan.md) and
[October 8 source evidence](backend-checkpoint-2026-10-08.md) for actual results.
Native, selected-profile and release acceptance remains pending until its
required receipts exist; a source checkpoint does not establish those gates.

The transition is complete for the assigned Luna leaves. Branch-library source
closure is published in `2adbc42d`; bounded local Session transport acceptance
now has five passing cases across the retained run and one failed-case-only
repair. C1/C2/C5 still defer their named pipeline cutovers.

Current shared-checkout continuation: R05 source assembly is published in `a59f441e`.
Frontend B-U source `1e1c6213`, acceptance receipt `950bf86e`, tooling `0a211f6f`
and the accepted backend prerequisites are published. SQL depth recovery and five
receipt boundary cases pass with source review; these do not qualify the native pipeline.
The Core decorator dependency is committed in `0c4f39a1`; frontend released the
reconciled/frozen installation. Native fixture acceptance injects AccessVerifier
and simulates Workflow status `waiting`; real JWT/native Workflow/browser/live
acceptance remains pending. Workflow-kind parser compile/lint and six focused
cases pass. Socrates accepted the exact parser and Session test pairs read-only
and is closed/archived; local source commits are `3f7d873a` and `8c5fc604`.
Canonical result readback `a2b38729` retains existing guards and exposes the
original stored-byte digest, with compile/lint/six focused cases and independent
source acceptance. One separate generated Session DO qualification passes on
the exact emitted graph through injected AccessVerifier/source HTTP, using the
real local fixture's active `running` status. Neither result accepts actual
ResearchWorkflow wait, emitted JWT/HTTP, browser, live or release behavior.
Root owns [R05 topology/outbox integration](native-external-task-wait-cutover.md); neither repair
qualifies native wait. All 37 previous backend descendants are closed/archived.

Branch prepare/read ports are published in `79f66f54`; owning compile,
exact lint and independent source review pass. The separate W2 preparation seam
and migration 0130 have source acceptance; native assembly is now published.
The migration preserves the exact legacy recovery predicate and permits only
current, predeadline recorded-result settlement for the new descriptive generation.
SQLite 3.50.4 depth-100 Core schema checks and five positive/eighteen negative
view-predicate cases pass; upstream views in the latter fixture are explicit rows.
The SQL extractor now respects `.tsx` filename dialects. Its focused parser
fixture and corrected depth compiler pass; target qualification remains incomplete
(1,048 unknown targets, 85 unknown arities and 152 unresolved sites).

The published sibling native prepare/wait/settle prerequisite has exact source
acceptance, owning compile and lint. New-generation result recording
now uses one D1 batch for the existing canonical result UPDATE and intent/outbox
inserts. Migration 0131 binds locator authority to the exact recorded timestamp,
digest and 0130 settlement view; a missing/replaced result cannot leave an orphan
wake. Original result/outbox readback reconciles a lost ACK; legacy callbacks
retain their original path. Exact source review, seven focused cases, depth-100
Core schema (639 shapes) and nineteen owning-source queries pass. Upstream
currentness in the focused fixture is explicit input.

The published source assembly wires `research-handlers.exploratory.external-wait.v1`
through admission, same-grant routing, pinned configuration and the Workflow
application. Stage 8 uses sibling native prepare/wait/settle steps outside the
legacy outer `step.do`; historical generations retain their graph. Manual
recovery restarts the new generation at its named prepare step. Queue dispatch
uses the existing outbox/inbox runtime with an explicit reserved-topic handler;
native callbacks return the exact durable receipt after canonical generation
readback, while historical callbacks retain digest-bound recovery.

Preparation persists a strictly validated canonical JSON string because native
RPC objects acquire platform disposer symbols. Settlement reads canonical result
bytes once, forwards the event digest even for OUTPUT_RECORDED, and checks the
original W2 manifest before existing executor settlement. Absent expired results
remain uncertain; recovery authorization still fences known-result mutation.
Nine helper, three pinned-configuration, twenty callback and nine server-port
composition cases pass. The final test fixture's metadata/type-only correction
passes owning compilation and lint; passing runtime cases were retained.
The new callback query compiles against actual Core at depth 100 (639 schema
shapes, one query, no unresolved site or failure). The R05-only Core graph compiles
on TypeScript 6.0.3 with zero diagnostics, excluding earlier C2 WIP. Revised
executor/ports and runtime routing have bounded source acceptance; generation
review leaves canonical acceptance outside its scope. Publication remains
separate from canonical native acceptance.

Seven local native topology cases and two added restart/pause cases pass with
injected server ports and counter D1. These exercise real Workflow steps/events,
not the complete W2/grant/R2/callback/Queue path. Canonical/native/live/release
acceptance and #326 remain open; the Goal remains active.

The subsequent actual-Core fixture found missing native-generation predicates
in the existing payload binding/current view and COMPUTER dispatch trigger.
Append-only migration 0132 extends exactly those three predicates, retaining
historical v8 and every existing authority fence. Three Core regressions pass
for exact payload, absent payload and foreign attempt; owning TypeScript 6.0.3
compilation and exact lint pass. SQLite 3.50.4 depth-100 accepts 128 migrations,
639 schema shapes and the callback query without failure or unresolved site.
The [local native qualification record](r05-local-native-qualification-2026-10-09.md)
distinguishes the bounded actual D1/R2/W2/callback/Queue results from scientific
`consumeResult`, pinned production configuration, COMPUTER/public caller and
live acceptance. Paused native continuation after original expiry initially
failed three stopped attempts. The causal audit found pause falling through the
helper's catch-all into premature settlement. Explicit RPC error serialization
preserves `WorkflowTimeoutError`; only that timeout now permits canonical reread,
while native lifecycle and unknown errors propagate. Eight changed/new helper
cases, owning compilation/lint and independent source review pass. Actual native
pause/resume after expiry and timeout with a recorded result both pass against
canonical D1/R2/W2, each with one read and the original attempt. Complete scientific,
production/public/live acceptance, #326 and implementation status remain open.

This is the canonical day-to-day backend router. It does not replace product architecture, work-packet
ownership or release acceptance. It tells each role where to begin, which active PR owns the result,
and where the concise donor/anti-duplication instructions live.

[`backend-delivery-plan.md`](backend-delivery-plan.md) records the active owner
continuation and retains the October 6 stop as dated historical evidence. The
cards and passports below govern the implementation queue.

## 1. Start by role

| Role or question | First document | Next authority |
|---|---|---|
| Manager starting a backend slice | [Implementation cards](../../.github/audits/2026-10-08/BACKEND-IMPLEMENTATION-CARDS.md) §4/§5 | Assigned PR body, owning ER packet and only its named architecture sections |
| Shared-code integrator | This document §4 | [Final PR matrix](../../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md) and accepted manager SHAs |
| Reviewer deciding whether a slice is complete | [Implementation cards](../../.github/audits/2026-10-08/BACKEND-IMPLEMENTATION-CARDS.md) §6 | PR acceptance, changed callers and removed duplicate path |
| Agent asking “what should I implement now?” | This document §2 | First dependency-ready PR assigned to its manager |
| Agent asking “what should we borrow from donors?” | [Implementation cards](../../.github/audits/2026-10-08/BACKEND-IMPLEMENTATION-CARDS.md) §3 | Pinned donor function in the active PR/playbook |
| Agent asking “why does Eliot own this instead of Cloudflare?” | [Cloudflare ownership](../../.github/audits/2026-10-08/CLOUDFLARE-NATIVE-OWNERSHIP.md) | Active PR’s semantic-authority boundary |
| Agent reviewing an old or closed PR | [Final PR matrix](../../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md) | [Preservation reconciliation](../../.github/audits/2026-10-08/PRESERVATION-RECONCILIATION.md) when applicable |
| Agent needing detailed donor evidence | [Donor playbook 1](../../.github/audits/2026-10-08/BACKEND-DONOR-PLAYBOOK.md) / [playbook 2](../../.github/audits/2026-10-08/BACKEND-DONOR-PLAYBOOK-2.md) | Treat their old process headers as historical; the cards/router own execution order |
| UI manager | [PR #329](https://github.com/UnknownAlienHuman/eliot-research/pull/329) | ER-47/ER-48 and UI-owned docs; do not edit backend shared contracts in parallel |
| Staging/release operator | [production-readiness-plan.md](production-readiness-plan.md) | S94–S97 after implementation identities and local gates exist |

The audit closure marker is
[`BACKEND-AUDIT-PREPARATION-COMPLETE.md`](../../.github/audits/2026-10-08/BACKEND-AUDIT-PREPARATION-COMPLETE.md).

## 2. Current dependency-ready wave

One manager owns one worktree and one bounded checkpoint at a time.

| Manager lane | Start | Required result before downstream work |
|---|---|---|
| A | [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209) | Shared first-cause/citation outcome vocabulary aligned across TypeScript and SQL |
| B | [#321](https://github.com/UnknownAlienHuman/eliot-research/pull/321) → [#331](https://github.com/UnknownAlienHuman/eliot-research/pull/331) | Common bounded reader fixed, callers migrated, weaker private readers deleted |
| C | [#322](https://github.com/UnknownAlienHuman/eliot-research/pull/322) + [#323](https://github.com/UnknownAlienHuman/eliot-research/pull/323) | Ordered direct lanes and collision-free compound identity ready for #242 |
| D | [#324](https://github.com/UnknownAlienHuman/eliot-research/pull/324) → [#320](https://github.com/UnknownAlienHuman/eliot-research/pull/320) | Decoder compatibility and scoped provider prefilter ready for the #242 integrator |
| E | [#332](https://github.com/UnknownAlienHuman/eliot-research/pull/332) | Ledger event read bound to the head frontier actually observed |
| F | [#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282) | Real emitted Worker/owner-web build budgets before formatting or size claims |

Current owner-directed source state is recorded in
[the October 8 checkpoint](backend-checkpoint-2026-10-08.md). Compilation,
source/native reproductions and exact-SHA review are reported separately there.
The earlier audit handoff state below is retained as historical evidence:

```text
#320 reconciled to current main; scoped workspace checks pending
#321 reconciled to current main; scoped workspace checks pending
#322 current-main source patch; focused package checks pending
#323 current-main source patch; focused package checks pending
#328 bounded source repair complete; repository-pinned checks pending; #285 owns expected-set/Golden v2
```

Do not start shared #242 integration before #324/#320/#322/#323 are reconciled in its manager worktree.
Do not let separate managers edit #325/#214/#233 shared branch/product contracts concurrently.

## 3. Manager launch protocol

Create exactly one worktree for the manager. Subagents do not create additional worktrees; they work
inside that manager-owned tree under disjoint exact-path ownership or remain read-only.

```bash
git fetch origin --prune
git worktree add ../eliot-research-mgr-<manager> \
  -b manager/<manager>/<pr>-<slug> origin/main
cd ../eliot-research-mgr-<manager>
git status --short
git log --oneline -5
```

Before editing, record in the active PR:

```text
Baseline: <exact origin/main SHA>
Manager/worktree: <manager ID and branch>
Checkpoint: <one bounded result>
Owned files: <exact paths>
Shared files: <none, or named integrator handoff>
Dependencies: <accepted predecessor SHAs or PENDING>
Cloudflare primitive reused: <binding/API or none>
Duplicate to remove/retire: <exact function/path>
Build gate: <TypeScript compile/scoped lint; minimal Clippy for Rust>
Deferred: <focused/full/native/live checks not executed yet>
```

Rules:

1. One manager has one worktree and one checkpoint. Finish or explicitly hand off before another lane.
2. One named integrator owns shared contracts, composition, migrations, manifests, lockfiles, barrels,
   generated bindings and CI.
3. Never force-push over another manager. Reconcile the refreshed expected head before publication.
4. Code first during assembly: compile and scoped lint; Rust also gets minimal Clippy; SQL uses the
   installed D1 depth/target compiler. Run only narrow reproductions required by the active PR.
5. Mark every unexecuted gate `PENDING`, never implied `PASS`.
6. A historical branch is evidence, not a tree to merge wholesale.
7. A donor invariant is implemented only inside the existing Eliot owner named by the card/PR.

## 4. Integrator entry point

The integrator uses one dedicated integration worktree and is the only writer for shared surfaces named
by more than one manager.

First-wave order:

```text
#209
#321 → #331
#322 + #323
#324 + #320 → #242
#332 independently
#282 independently
```

For every integration:

1. refresh `origin/main` and the manager head;
2. compare the exact diff and file list;
3. verify that no unrelated planning/history tree entered the change;
4. run the scoped compiler/lint/Clippy gate and named narrow reproduction;
5. preserve persisted identities and legacy codecs unless an explicit migration exists;
6. verify the implementation uses the Cloudflare primitive named by the card rather than replacing it;
7. verify all callers moved and the duplicate path is deleted or provably retired;
8. publish without rewriting history and read the resulting ref back;
9. record exact SHA, commands, pending tests and released downstream owners in the PR.

A policy wrapper over two active engines/readers/retry paths is not consolidation.

## 5. Reviewer entry point

A backend PR is reviewable only when its body answers:

```text
Which callers moved?
Which duplicate functions, branches or engines were deleted or retired?
Which legacy bytes/codecs remain readable?
Which Cloudflare primitive owns the commodity mechanism?
Which Eliot semantic checks still run after external I/O?
What is the net production LOC and emitted bundle delta?
What is the D1/R2/provider-call delta?
Which negative, replay, lost-ACK and bound cases were executed?
Which compiler/lint/Clippy/test/native/live gates remain PENDING?
```

Reject:

- a wrapper over two unchanged execution engines;
- a new generic framework where Cloudflare already owns the primitive;
- a donor store/registry/runtime beside an existing Eliot owner;
- provider success treated as evidence, coverage, permission or publication authority;
- retryability treated as permission to repeat an unknown paid effect;
- a source-only refactor presented as emitted-size/runtime improvement;
- model-authored citation, contradiction or completion state treated as canonical;
- a deferred donor feature promoted to a core blocker without benchmark evidence.

## 6. Authority and precedence

When documents disagree:

1. current `origin/main` code and installed schemas;
2. active implementation PR/passport and accepted predecessor SHAs;
3. this router, implementation cards and final PR matrix;
4. owning ER packet and manifest ownership;
5. normative architecture, language/runtime contract and accepted ADRs;
6. dated audits, old launch plans and closed PRs as historical evidence only.

A leaf task may not resolve a shared-contract conflict by inventing a private schema, registry, retry
engine or compatibility exception.

## 7. Core dependency graph

```text
#209
├─ #261 / #262 / #263 / #256
└─ shared failure vocabulary for later lanes

#321 → #331
#322 + #323
#324 + #320 → #242
#332 independently

#242 + #209 → #325 → #214
#209 + #330 → #326 / #264
#209 + #242 + #325 → #233
#233 → #246 → #247 → #255

#209 → #231 → #239 → #240 → #241
                    └→ #244
#239 + #240 → #248
#240 + #247 + #248 → #249

#328 → #285
#282 → #268
```

Optional Google/federation profiles, optional Rust/Wasm promotion, UI completion, staging and paid
quality runs do not block deterministic backend core work unless the active PR names a concrete
cross-owner dependency.

## 8. Donor use rule

The implementation cards are the decision register. The long donor playbooks supply evidence and exact
pinned functions. They do not authorize importing donor frameworks.

```text
Cloudflare commodity mechanism
  → native binding/API
  → thin Eliot adapter and receipt

Missing semantic guarantee
  → one existing Eliot owner
  → isolated donor invariant
  → migrate callers
  → delete duplicate
```

Anything else requires a measured gap and an explicit architecture/integrator decision.
