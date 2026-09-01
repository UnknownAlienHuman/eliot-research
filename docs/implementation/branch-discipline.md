---
title: "Eliot Research branch discipline"
protocol: "eliotr.branch-discipline.v1"
version: "1.0"
date: 2026-09-01
status: "normative"
---

# Branch discipline

## Rules

1. One agent owns one worktree, one branch, and one task.
2. An agent must not start another task while it owns an open worktree or branch.
3. A completed task is immediately:
   - merged to `main`;
   - explicitly quarantined; or
   - deleted.
4. Quarantine is limited to **5 non-default branches system-wide**.
5. A non-default branch without an open pull request has a **24-hour TTL**.
6. An open pull request protects its head branch from automated deletion.
7. Closing or merging a pull request removes that protection; the branch is then deleted.
8. `main` is never deleted or force-updated by branch-hygiene automation.
9. Evidence belongs in commits, PRs, CI logs, immutable receipts, or named artifacts—not in abandoned
   branch tips.
10. A branch needed for audit must be converted into a tag/release or a committed manifest before the
    branch is removed. Branches are not an archival system.

## Naming

```text
agent/<packet>-<short-task>-YYYYMMDD
docs/<short-task>-YYYYMMDD
fix/<short-task>-YYYYMMDD
quarantine/<reason>-YYYYMMDD
```

No `final`, `v2`, `v3`, `retry`, `strict`, or similar suffix chains are allowed. Replace the branch
through a clean commit or close it; do not create serial abandoned variants.

## Automation

`.github/workflows/branch-hygiene.yml` runs on `main`, hourly, and manually.

It:

- preserves `main`;
- preserves branches with open PRs;
- removes pre-contract legacy branches during bootstrap cleanup;
- removes later branches without an open PR after 24 hours;
- fails if more than five non-default branches remain after cleanup;
- writes the exact deletion plan and result to the GitHub Actions summary.

The automation never treats a branch as evidence that implementation was merged.
