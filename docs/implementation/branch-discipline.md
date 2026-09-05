---
title: "Eliot Research branch discipline"
protocol: "eliotr.branch-discipline.v1"
version: "1.1"
date: 2026-09-05
status: "normative"
---

# Branch discipline

## Rules

1. One agent owns one active worktree, one branch, and one task.
2. An agent must not start another implementation task while it owns an active worktree or branch.
3. A completed task is immediately merged to `main`, explicitly quarantined, or deleted.
4. The ordinary ceiling remains **5 counted non-default branches system-wide**.
5. A non-default branch without an open pull request has a **24-hour TTL**.
6. An open pull request protects its head branch from automated deletion.
7. Closing or merging a pull request removes that protection; the branch is then deleted.
8. `main` is never deleted or force-updated by branch-hygiene automation.
9. Evidence belongs in commits, PRs, CI logs, immutable receipts, or named artifacts, not abandoned tips.
10. Archive evidence with a tag/release or committed manifest before removing a branch needed for audit.

## Naming

```text
agent/<packet>-<short-task>-YYYYMMDD
docs/<short-task>-YYYYMMDD
fix/<short-task>-YYYYMMDD
quarantine/<reason>-YYYYMMDD
```

No `final`, `v2`, `v3`, `retry`, `strict`, or similar suffix chains. Replace the branch through a clean
commit or close it; do not create serial abandoned variants.

## Automation

`.github/workflows/branch-hygiene.yml` runs on `main`, hourly, and manually. It preserves main and open
PR heads; deletes pre-contract legacy branches, closed/merged heads, and expired no-PR branches; evicts
excess recent orphan branches; and fails if more than five counted non-default branches remain after
cleanup. It rechecks PR protection and the exact head before deletion, and reloads open PRs before the
final ceiling count. The automation never treats a branch as evidence that implementation was merged.

## Owner-requested launch PR series — 2026-09-05

The owner explicitly requested one PR for each of the nine remaining launch themes. This bounded
exception qualifies the five-branch summary in AGENTS.md; it does not increase ordinary quarantine or
implementation WIP. The exact nine branch names in `infra/github/branch-hygiene.json` are planning
reservations, not additional active worktrees. They are excluded from the ceiling only while their
same-repository PR is open. There is no prefix exemption or exemption for a closed/missing PR.

Only one theme may be actively claimed by one agent at a time. A queued draft contains its plan but
has no active implementation worktree. Keep a theme draft until every mandatory code acceptance item
in its plan is complete; green docs-only CI is not feature completion. Refresh from current main before
implementation and re-run exact-head CI. See `launch-prs/README.md` for ordering and integration rules.
