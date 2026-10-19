# Implementation

The [product manifesto](docs/architecture/ELIOT_RESEARCH.md) defines why Eliot Research exists and what must
remain true. Keep it in the lead developer's context; do not copy it into each task.

| Question | Read |
|---|---|
| What should change, and what should disappear? | [Implementation plan](docs/implementation/backend-entrypoints.md) |
| How are sources stored, indexed and cited? | [Source lifecycle](docs/implementation/source-lifecycle.md) |
| How does an ordinary answer work? | [Ordinary answer](docs/implementation/research-full-answer-v1.md) |
| How does explicit deep research work? | [Deep research](docs/implementation/deep-research.md) |
| How do Wiki and Inbox proposals, acceptance and edits work? | [Wiki and Inbox](docs/implementation/wiki-inbox.md) |
| Which existing code owns behavior/data? | [Code map](docs/implementation/dependency-map.md) |
| Which storage/effect/access details matter? | [Runtime notes](docs/implementation/runtime-contract.md) |
| What may be reused from donors? | [Donor register](docs/implementation/donors.md) |
| Which other current note is relevant? | [Reference index](docs/implementation/README.md) |

Select one complete outcome, inspect its real callers, implement the smallest replacement and remove its
predecessor. These links are navigation, not approvals or a requirement to read historical files.
[AGENTS.md](AGENTS.md) owns coordination/check timing; [START-HERE](docs/START-HERE.md) explains context use.
