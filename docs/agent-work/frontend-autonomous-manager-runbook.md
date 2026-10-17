# Frontend autonomous manager runbook

Use [ADR-0019](../adr/0019-compact-refactoring.md), [the implementation router](../implementation/backend-entrypoints.md),
the [owner execution map](frontend-owner-execution-map.md), the [Material UI playbook](frontend-material-agent-playbook.md)
and the [NotebookLM reference protocol](frontend-notebooklm-material-reference.md) as the canonical sources.
This page keeps only the UI-specific acceptance and authorization boundary; root `AGENTS.md` and `START-HERE.md`
govern manager checkout, exact-path assignment, coordination and implementation checks. ER-47/48/49 claims,
ancestry records and checkpoint machinery are historical audit material, not gates for current work.

## Authorized UI progression

Continue the authorized implementation through U5-X without asking whether to proceed. Use U1-R live
NotebookLM/Material observations before token and shell decisions; use U1-D for internal rendered direction and
U2-X for a fresh-context no-hint usability review. Repair failures and continue. Inspect the actual product in a
browser at assembled UI acceptance; stories, types and DOM snapshots alone do not establish rendered quality.
Preserve the execution map's user-visible areas, behavior and acceptance evidence.

Prepare the integrated Vite/Worker build bridge and rollback artifact during the current authorized refactor,
before FINAL-UI. Present one complete U5-X review build for FINAL-UI. Production deployment, account/provider
mutation, cutover and final merge follow the applicable existing authorization; do not repeat a permission
request when that authorization already covers the action. Ordinary in-scope code retirement is part of the
authorized refactor after cutover and rollback obligations are satisfied.

## Review boundary

The review build covers Sources, Research, Evidence, Studio and Connections, with applicable desktop/phone,
light/dark, long RU/EN and useful/loading/empty/degraded/error states. Include actual rendered browser review and
the applicable interaction, accessibility, visual, CSP, lifecycle, binding and performance evidence. Keep
unsupported native, Preview, staging or live checks marked `PENDING`; evidence must describe the exact build and
environment and must not include source/evidence text, prompts, credentials, cookies or provider payloads. Follow
[ADR-0017 §5](../adr/0017-owner-web-browser-runtime-and-tooling.md): `pagehide` masks synchronously, closes the
lifecycle epoch and clears protected read views after aborting reads; deployment renewal alone preserves the
owner's draft and last known read.

Stop only the affected action when a missing/contradictory contract changes product truth, an ownership or
security/privacy/evidence boundary would be weakened, required authenticated browser access is unavailable after
recovery, or a requested external/irreversible action lacks applicable authorization. Continue independent
authorized implementation and integration work while such a handoff is pending.
