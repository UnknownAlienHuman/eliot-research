---
title: "Eliot Research branch discipline"
protocol: "eliotr.branch-discipline.v3"
version: "3.0"
date: 2026-10-08
status: "normative"
---

# Branch and worktree discipline

## Manager-owned implementation

The current execution model is **one worktree per manager**.

A manager owns one bounded checkpoint and one worktree at a time. Subagents do not create additional
worktrees or independent integration branches; they work inside the manager-owned tree under disjoint
path ownership or remain read-only. The manager finishes or explicitly hands off before taking another
lane.

Example:

```bash
git fetch origin --prune
git worktree add ../eliot-research-mgr-<manager> \
  -b manager/<manager>/<pr>-<slug> origin/main
```

Before editing, the manager records the exact base SHA, worktree/branch, checkpoint, owned paths,
shared-file handoff, dependencies and build gates in the active PR.

## Shared integration

One named integrator owns shared contracts, composition roots, public routes, migrations, manifests,
barrels, package/Cargo manifests, lockfiles, generated bindings and CI.

The integrator uses one dedicated integration worktree and:

1. refreshes `origin/main` and the manager head;
2. compares the exact diff and file list;
3. verifies that no stale planning/history tree entered the change;
4. runs the required scoped compiler/lint/Clippy gate and named narrow reproduction;
5. preserves persisted identities and legacy codecs unless an explicit migration exists;
6. publishes without rewriting history;
7. reads the resulting ref back and records the exact SHA and pending gates.

No manager or integrator force-pushes over concurrent work. A mismatched expected head requires refresh
and reconciliation, not overwrite.

## Historical and planning branches

Planning, salvage and audit branches are specifications/evidence. They are not implementation trees to
merge wholesale. Compare every useful delta against current main and current owners.

An open theme is not automatically unfinished in every detail; a closed PR is not automatically
integrated. Preserve source branches when ancestry/equivalence is not proven.

## Cleanup authority

There is no numeric branch quota, expiry or age-based deletion rule. Branch age, count and a closed PR
are not evidence of integration.

Automated cleanup must establish all of the following:

1. the configured default branch is still the repository default;
2. the candidate is neither default nor protected and has no open same-repository PR;
3. the exact candidate head is an ancestor of the observed default-branch head; squash/rebase without
   ancestry is preserved for operator review;
4. immediately before deletion, repeat default/integration, head, protection and open-PR observations;
5. delete only the named ref under an explicit expected-SHA lease;
6. confirm absence before recording success; do not blindly retry an unknown outcome or recreated ref.

The lease permits deletion of only that exact candidate. It never permits rewriting `main` or another
manager branch.

## Verification phase

During product assembly, managers run compilation and scoped lint; Rust also runs minimal Clippy, and
SQL changes run the installed D1 depth/target compiler. Narrow reproductions named by the active PR may
run immediately. Broad unit/browser/native/mutation/live suites follow assembled product code.

Every unexecuted check is reported `PENDING`.

## Automation and evidence

`.github/workflows/branch-hygiene.yml` remains a cleanup aid, not implementation authority. Its planner,
API rechecks and lease behavior are covered by `node scripts/test-branch-hygiene.mjs`.

The job reports confirmed deletions and preserved/skipped work. It does not replace product, security,
data, runtime or release checks.
