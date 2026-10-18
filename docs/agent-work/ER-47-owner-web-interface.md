# ER-47: React owner interface reference

Historical file map, not a task or ownership lock. Current work follows [the plan](../implementation/backend-entrypoints.md),
[UI delivery map](frontend-owner-execution-map.md) and [root rules](../../AGENTS.md).
Frontend claims and their ancestry checker have been removed; create no replacements.

## Owned paths

- `apps/eliotr-web/**`
- `packages/ui/**`
- `tests/ui-owner/**`
- `scripts/ui-owner/**`

These entries keep the remaining historical packet index consistent, not exclusive development permission.
Use one React/Vite presentation and canonical owner client; no direct feature fetch or copied wire decoders.
The [cutover contract](../implementation/frontend-platform-migration.md) owns the integrated build,
standalone Inbox, inert service worker, private-data lifecycle and rollback. Change selected stream contracts
with real server/client callers rather than creating an unrelated realtime layer.

Use existing [Material guidance](frontend-material-agent-playbook.md) and [UI design](../design/OWNER_WEB_UI.md)
for visual work. The initial JavaScript reference is 600 KiB gzip; measure the actual build using
[the performance guidance](../implementation/frontend-performance-acceptance.md), not source-line counts.
Compile/lint during implementation; final product/browser review follows assembly. Do not claim acceptance
from a fixture screen or keep legacy source for obsolete tests or a rollback artifact.
