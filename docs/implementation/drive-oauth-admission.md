# Historical Drive Exchange OAuth checkpoint

The initial Google OAuth admission described here belongs to the unselected Drive Exchange programme. It is not a
current launch requirement or instruction to finish owner UI, provisioning, qualification or connector lifecycle.
Use the [implementation plan](backend-entrypoints.md), [security checklist](security-checklist.md) and
[release/schema transitions](production-readiness-plan.md).

Keep the dormant path disabled while caller/deployment/data inventory is incomplete. Do not bypass it with pasted
tokens, raw SQL or unsigned identity claims; equally, do not preserve a large OAuth/proof subsystem solely because it
was implemented and tested. Any real deployed connection, encrypted credential or acknowledged external effect needs
a deliberate authorized retirement/conversion. Otherwise remove the routes, configuration, migrations, tests and
packages with their last selected caller.

A future explicit Google integration must start from current provider documentation and a concrete user action, then
reuse only the necessary verified operation. It must not revive G1–G8, ER ownership or all-connector acceptance by
default.

The original checkpoint remains in
[Git history](https://github.com/UnknownAlienHuman/eliot-research/blob/5dec2fae1a86b2a7cf7bb00703b6976665aab847/docs/implementation/drive-oauth-admission.md).
