# docs

Start at [START-HERE.md](START-HERE.md) — the single entry point for an agent joining this repository.

| Path | Contents |
|---|---|
| [START-HERE.md](START-HERE.md) | **The entry point.** Current decisions, task selection, bounded implementation and verification timing. |
| [architecture/](architecture/) | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md) — detailed contracts with current service applicability at the top — and [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md), the TypeScript/Rust/SQL boundary. |
| [adr/](adr/) | Architecture decisions. [ADR-0019](adr/0019-compact-refactoring.md) consolidates the compact refactor, #377 cancellations, OWNER_SINGLE and React/Vite. |
| [agent-work/](agent-work/) | Existing capability and contract map, with one-manager/disjoint-file execution. [Packet index](agent-work/README.md), [manifest.json](agent-work/manifest.json), [additive fragments](agent-work/packets/). |
| [implementation/](implementation/) | The compressed implementation view: status registry, gap register, runtime and failure contracts, branch discipline, launch plans, runbooks. [Index](implementation/README.md). |
| [s92/](s92/README.md) | S92 local setup runbook and INPUT draft; delivered scenario source and separately pending acceptance. |
| [design/](design/README.md) | Non-normative UI proposals, interactive prototypes and visual mockups. [Blue workspace v2](design/README.md): research and MCP/client diagnostics. |
| [contracts/](contracts/) | Hand-written contract notes not yet generated. |
| [generated/](generated/) | Generated projections: schemas, reason codes, resource manifests, capacity reports. Never hand-edited. |

Operational fact that ages faster than the document — pricing, quotas, provider limits — belongs in an
external evidence record with a checked-at date, not in the architecture prose.
