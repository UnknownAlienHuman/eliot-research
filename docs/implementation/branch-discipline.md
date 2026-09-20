---
title: "Eliot Research branch discipline"
protocol: "eliotr.branch-discipline.v2"
version: "2.0"
date: 2026-09-19
status: "normative"
---

# Branch discipline

## Owner-directed implementation

The owner's S27 instruction supersedes the former branch ceiling, dated launch reservations, and
age-based deletion procedure. Work directly on `main`; do not create implementation branches or
additional local worktrees. One agent holds one checkpoint at a time. Claim exact paths and base SHA
in the existing theme PR, test the change, publish without rewriting history, and record its acceptance.
Preserve concurrent main changes; do not force an implementation update over them.

Existing planning and salvage PRs remain specifications/evidence, not permission to merge stale trees.
An open theme is not automatically unfinished in every detail: compare each checkpoint against main.
Keep a theme open until all of its mandatory code acceptance is met; live acceptance stays separate.

## Cleanup authority

There is no numeric quota, expiry, or named/dated exception list. Branch age, count, and a closed PR
are not evidence of integration. In particular, closed-but-unmerged work must survive.

Automated cleanup must establish all of the following:

1. The configured default branch is still the repository's actual default branch.
2. The candidate is neither the default nor a protected branch and has no open same-repository PR.
3. The exact candidate head is an ancestor of the observed default-branch head. A squash/rebase merge
   without this ancestry is conservatively preserved for explicit operator review.
4. Immediately before deletion, repeat default/integration, head, protection and open-PR observations.
   Any changed head, new PR or protection cancels that candidate.
5. Delete only the named ref under an explicit expected-SHA lease. REST DELETE has no such precondition
   and is not used. Confirm absence before recording a successful deletion; do not blindly retry an
   unknown outcome or a recreated branch.

The lease is limited to deletion of the exact candidate; it is not permission to rewrite `main` or
force-update another branch. GitHub protection remains enforced by the server. PR metadata and Git refs
are separate resources: PR protection is an observation immediately before deletion, not an atomic
cross-resource lock. A branch-head race after observation is rejected by the Git server's exact lease.

## Automation and evidence

`.github/workflows/branch-hygiene.yml` runs on main, hourly, and manually. The planner, executable API
rechecks, and real local Git lease behavior are covered by `node scripts/test-branch-hygiene.mjs`.
The job reports confirmed deletions and preserved/skipped work; branch count is informational only.
It does not replace data/security/runtime checks or qualify product launch. No implementation branch
or worktree is created by the cleanup job.

Archive explicitly required non-integrated evidence before an operator-directed removal. Never infer
that a branch is disposable merely because its PR was closed or its commit is old.
