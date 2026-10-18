# Implementation

The [product manifesto](docs/architecture/ELIOT_RESEARCH.md) answers why this product exists and what
must remain true. Keep it in the lead developer's context; do not copy it into each task.

| Question | Read |
|---|---|
| What should change, and what should disappear? | [Implementation plan](docs/implementation/backend-entrypoints.md) |
| How should an ordinary source-backed answer work? | [Ordinary answer](docs/implementation/research-full-answer-v1.md) |
| How should explicitly requested deep research work? | [Deep research](docs/implementation/deep-research.md) |
| Which existing code owns the behavior and data? | [Code and responsibility map](docs/implementation/dependency-map.md) |
| Which storage/execution details matter for this change? | [Runtime integration](docs/implementation/runtime-contract.md) |
| What may be reused from Perplexity and other systems? | [Donor register](docs/implementation/donors.md), [Perplexity review](docs/implementation/perplexity-donor.md) |
| Which other technical note is relevant? | [Reference index](docs/implementation/README.md) |

Select one outcome, inspect its callers, implement the smallest complete change and remove its predecessor.
These are navigation links, not a sequence of approvals or a requirement to read every linked document.
[AGENTS.md](AGENTS.md) owns coordination and check timing; [START-HERE](docs/START-HERE.md) explains context use.
