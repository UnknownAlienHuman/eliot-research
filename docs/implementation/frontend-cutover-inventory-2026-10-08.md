# Historical frontend cutover inventory — 2026-10-08

This inventory mapped the old Astro/PWA build and deployment graph before the current React/client work. Its U6/U7
assignments and ER ownership are historical.

The still-relevant conclusions are owned by [frontend cutover](frontend-platform-migration.md) and
[release/schema transitions](production-readiness-plan.md): the real Vite output must be wired into the one Worker
artifact; a Vite build beside the unchanged legacy deploy is not cutover; rollback preserves code/assets but does not
roll back D1/R2.

The original path inventory remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/216c67fce241697144fce7cbc8ddb6383e43cacb/docs/implementation/frontend-cutover-inventory-2026-10-08.md).
