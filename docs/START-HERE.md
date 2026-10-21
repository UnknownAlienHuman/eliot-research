# Developer context

Keep [the product manifesto](architecture/ELIOT_RESEARCH.md) and [working rules](../AGENTS.md) in the
lead developer's context. The manifesto defines purpose, scope, user requirements and design principles.
It is not a file inventory, migration recipe, implementation status report or code-size budget.

For a concrete task, open [implementation](../IMPLEMENTATION.md), select the relevant section of
[the plan](implementation/backend-entrypoints.md), and read its source plus the smallest necessary technical notes.
Use [release and schema transitions](implementation/production-readiness-plan.md) for deployment/data changes,
[local launch](implementation/local-launch.md) for the isolated developer application, and
[toolchain](implementation/toolchain.md) only for the tools the task actually needs.
The [code map](implementation/dependency-map.md) explains current owners and replacement destinations.
Do not load the whole reference catalogue or reproduce the manifesto in every leaf assignment.

Current user instructions and the manifesto govern scope. Implementation chooses how within that scope;
old audits, ER/S documents, launch packets and status registries do not reopen canceled behavior.
[ADR-0019](adr/0019-compact-refactoring.md) records the change in direction, not another task queue.
A target description or green registry check is not proof that the selected user journey works.
