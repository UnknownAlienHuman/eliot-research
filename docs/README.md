# Documentation

[START-HERE](START-HERE.md) explains what belongs in the developer's context.

| Document | Job |
|---|---|
| [Product manifesto](architecture/ELIOT_RESEARCH.md) | Persistent context: why the product exists, what it does, requirements and principles |
| [Implementation entry](../IMPLEMENTATION.md) | Navigation to concrete work, existing code and technical details |
| [Implementation plan](implementation/backend-entrypoints.md) | What to change, where, how, what to borrow and what to remove |
| [Working rules](../AGENTS.md) | Coordination, verification timing and document discipline |

## Reference collections — read selectively

| Directory | Use |
|---|---|
| [architecture/](architecture/) | The manifesto; the existing [language reference](architecture/LANGUAGE_RUNTIME_CONTRACT.md) is a technical implementation note, not additional persistent context |
| [implementation/](implementation/README.md) | Current technical notes and dated source/operating records; the index distinguishes their roles |
| [adr/](adr/) | Reasons for past decisions; current scope is not the sum of every historical ADR |
| [agent-work/](agent-work/README.md) | UI guidance and historical capability maps, not path locks or a mandatory work queue |
| [design/](design/README.md) | UI references and proposals, not additional backend requirements |
| [contracts/](contracts/) | Notes for existing interfaces; read with their current callers |
| [generated/](generated/) | Generated projections, not another manually maintained authority |
| [s92/](s92/README.md) | Historical setup/scenario material; not the default implementation programme |

Put file paths, algorithms, donors, migration mechanics, commands and checked-at operational facts in
implementation notes. Put product purpose and enduring principles in the manifesto. Do not duplicate
one into the other, manufacture additional status records, or turn historical evidence into prerequisites.
