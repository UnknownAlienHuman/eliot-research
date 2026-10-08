---
title: "Backend implementation entry points"
date: 2026-10-08
status: "current execution router after audit handoff"
source_baseline: "3e6c25660c1ae515760e19d5f9e6b8a735795c4c"
audit_pr: 327
---

# Backend implementation entry points

This is the canonical day-to-day router for backend implementation after the 2026-10-08 audit handoff.
It does not replace product architecture, work-packet ownership or release acceptance. It tells each
role where to begin and which document owns the next decision.

The former [`backend-delivery-plan.md`](backend-delivery-plan.md) records the paused October 6 source
checkpoint and remains historical evidence. It is **not** the current implementation queue.

## 1. Choose the entry point for your role

| Role or question | Start here | Then read |
|---|---|---|
| Manager starting an implementation slice | This document §3 and the assigned PR body | The owning ER packet and only the architecture sections named by it |
| Shared-code integrator | This document §4 | [Final PR matrix](../../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md) and affected shared owners |
| Reviewer deciding whether a slice is complete | This document §5 | The PR acceptance list, changed callers and removed duplicate path |
| Agent asking “what should I implement now?” | This document §2 | The first dependency-ready PR assigned to its manager |
| Agent asking “why does Eliot own this instead of Cloudflare?” | [Cloudflare ownership](../../.github/audits/2026-10-08/CLOUDFLARE-NATIVE-OWNERSHIP.md) | The named official capability and Eliot semantic boundary |
| Agent looking for donor code | [Donor playbook 1](../../.github/audits/2026-10-08/BACKEND-DONOR-PLAYBOOK.md) and [playbook 2](../../.github/audits/2026-10-08/BACKEND-DONOR-PLAYBOOK-2.md) | Only the pinned functions named by the active PR |
| Agent reviewing an old or closed PR | [Final PR matrix](../../.github/audits/2026-10-08/FINAL-PR-DISPOSITION-MATRIX.md) | [Preservation reconciliation](../../.github/audits/2026-10-08/PRESERVATION-RECONCILIATION.md) when applicable |
| UI manager | [PR #329](https://github.com/UnknownAlienHuman/eliot-research/pull/329) | ER-47/ER-48 and the UI-owned documents; do not edit backend shared contracts in parallel |
| Staging/release operator | [production-readiness-plan.md](production-readiness-plan.md) | S94–S97 only after implementation identities and local gates exist |

The audit closure marker and complete handoff are in
[`BACKEND-AUDIT-PREPARATION-COMPLETE.md`](../../.github/audits/2026-10-08/BACKEND-AUDIT-PREPARATION-COMPLETE.md).

## 2. Current dependency-ready implementation wave

One manager owns one worktree and one bounded checkpoint at a time.

| Manager lane | Start | Result before downstream work |
|---|---|---|
| A | [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209) | Shared first-cause/citation outcome vocabulary aligned across TypeScript and SQL |
| B | [#321](https://github.com/UnknownAlienHuman/eliot-research/pull/321) → [#331](https://github.com/UnknownAlienHuman/eliot-research/pull/331) | Common bounded reader fixed, callers migrated, weaker private readers deleted |
| C | [#322](https://github.com/UnknownAlienHuman/eliot-research/pull/322) + [#323](https://github.com/UnknownAlienHuman/eliot-research/pull/323) | Ordered direct lanes and collision-free compound identity preserved for #242 |
| D | [#324](https://github.com/UnknownAlienHuman/eliot-research/pull/324) → [#320](https://github.com/UnknownAlienHuman/eliot-research/pull/320) | Decoder compatibility and scoped provider prefilter ready for the #242 integrator |
| E | [#332](https://github.com/UnknownAlienHuman/eliot-research/pull/332) | Ledger event read bound to the head frontier actually observed |
| F | [#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282) | Real emitted Worker/PWA build budgets available before formatting or UI cutover claims |

Current source-branch state:

```text
#320 reconciled to current main; scoped workspace checks pending
#321 reconciled to current main; scoped workspace checks pending
#322 current-main bounded source patch; focused package checks pending
#323 current-main bounded source patch; focused package checks pending
#328 bounded source repair complete; repository-pinned checks pending; #285 owns expected-set/Golden v2
```

Do not start shared #242 integration before #324/#320/#322/#323 are reconciled in its manager worktree.
Do not let separate managers edit #325/#214/#233 shared branch contracts concurrently.

## 3. Manager launch protocol

Create exactly one worktree for the manager. Subagents do not create additional worktrees; they work
inside that manager-owned tree under disjoint file ownership or remain read-only.

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
Build gate: <TypeScript compile/scoped lint; minimal Clippy for Rust>
Deferred: <focused/full/native/live checks not executed yet>
```

Rules:

1. One manager has one worktree. A manager must finish or hand off before taking another lane.
2. One named integrator owns shared contracts, composition, migrations, manifests, lockfiles and barrels.
3. Never force-push over another manager. Reconcile the refreshed expected head before publication.
4. Code first during assembly: compile and scoped lint; Rust also gets minimal Clippy. Run narrow
   reproductions required by the active PR. Full suites and native acceptance follow assembled product code.
5. Mark every unexecuted gate `PENDING`, never implied `PASS`.
6. A historical branch is evidence, not a tree to merge wholesale.

## 4. Integrator entry point

The integrator uses one dedicated integration worktree and is the only writer for shared surfaces named
by more than one manager.

Integration order for the first wave:

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
3. verify that no unrelated historical branch content entered the tree;
4. run the scoped compiler/lint/Clippy gate required by the changed language;
5. verify the required negative reproduction when the active PR names one;
6. preserve legacy codecs and persisted identities unless the PR contains an explicit migration;
7. publish without rewriting history and read the resulting ref back;
8. record exact SHA, commands, pending tests and downstream release in the PR.

Shared integration is incomplete if it only adds a wrapper while both competing engines/readers/
retry paths remain active.

## 5. Reviewer entry point

A backend implementation PR is reviewable only when its body answers all of these:

```text
Which callers moved?
Which duplicate functions, branches or engines were deleted or retired?
Which legacy bytes/codecs remain readable?
What is the net production LOC and bundle delta?
What is the D1/R2/provider-call delta?
Which authority/currentness checks still run after external I/O?
Which negative, replay, lost-ACK and bound cases were executed?
Which compiler/lint/Clippy/test/native/live gates remain PENDING?
```

Reject these completion claims:

- a policy wrapper over two unchanged execution engines;
- a new generic framework where Cloudflare already owns the primitive;
- a successful provider response treated as evidence, coverage or publication authority;
- a retryable error treated as permission to repeat an unknown paid effect;
- a source-only refactor presented as emitted-size or runtime improvement;
- a model-authored citation, contradiction or completion state treated as canonical.

## 6. Authority and precedence

When documents disagree, use this order:

1. current `origin/main` code and installed schemas;
2. the active implementation PR/passport and accepted predecessor SHAs;
3. this router and the final PR disposition matrix;
4. the owning ER packet and manifest ownership;
5. normative architecture, language/runtime contract and accepted ADRs;
6. dated audits, old launch plans and closed PRs as historical evidence only.

A leaf task may not resolve a shared-contract conflict by inventing a private schema, registry or
compatibility exception.

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
