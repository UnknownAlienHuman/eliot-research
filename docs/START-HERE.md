# Developer context

Keep [the product manifesto](architecture/ELIOT_RESEARCH.md) and [working rules](../AGENTS.md) in the
lead developer's context. The manifesto defines purpose, scope, user requirements and design principles.
It is not a file inventory, migration recipe, implementation status report or code-size budget.

For a concrete task, open [implementation](../IMPLEMENTATION.md), select the relevant section of
[the plan](implementation/backend-entrypoints.md), and read its source and necessary technical notes.
The [code map](implementation/dependency-map.md) explains existing names and responsibilities.
Do not load the whole reference catalogue or reproduce the manifesto in every leaf assignment.

Current user instructions and the manifesto govern scope. Implementation chooses how within that scope;
old audits and plans do not reopen canceled behavior. [ADR-0019](adr/0019-compact-refactoring.md) records
this change in direction, not another task queue. A description of a target is not proof it is implemented.
