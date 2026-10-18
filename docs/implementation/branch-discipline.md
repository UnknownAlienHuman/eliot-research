# Branch discipline

Updated 2026-10-17. One manager uses one existing checkout/worktree and one publication branch/context.
Leaves work on disjoint assigned paths without their own branches/worktrees. The manager serializes shared
files. No claim-only commit, ancestry ceremony or package reservation is required for current development.

Read the remote head before publishing. Preserve concurrent changes and use an expected-head update;
do not force over another writer. A review branch does not authorize deployment, live data changes or secret deletion.
A failed publication lease means inspect the new head before retrying, not overwrite it.

Old prototypes need not be merged or maintained in the product. Git history and existing archived PRs
can retain source without compatibility wrappers, live route registrations or duplicated docs. Keep unique
wanted work before removing its last useful ref; a canceled requirement does not become wanted just because
its PR is unmerged. Do not delete another manager's active checkout or uncommitted work.

Branch deletion is a separate explicit operation. Existing branch-hygiene automation is unchanged by this
documentation pass; its configured safeguards remain in effect until its own reviewed change. Do not start
a branch/worktree purge to satisfy a source-size target or turn archival reconciliation into a coding prerequisite.

[AGENTS.md](../../AGENTS.md) owns implementation/verification procedure;
[the current plan](backend-entrypoints.md) owns selected work. Old Issue/PR bodies are historical where
superseded, not a second queue that must be completed before shipping the owner product.
