# docs

Start at [START-HERE.md](START-HERE.md) — the single entry point for an agent joining this repository.

| Path | Contents |
|---|---|
| [START-HERE.md](START-HERE.md) | **The entry point.** Read order, authority map, how to claim work, gates, branch discipline. |
| [architecture/](architecture/) | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md) — the standalone authoritative architecture and implementation master for this service — and [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md), the TypeScript/Rust authority boundary. |
| [adr/](adr/) | Architecture Decision Records. Required for any load-bearing default, new owner, provider selection or contract change. |
| [agent-work/](agent-work/) | Work packets: who owns which path, what each packet must deliver, and its mandatory negative case. [Packet index](agent-work/README.md), [manifest.json](agent-work/manifest.json), [additive fragments](agent-work/packets/). |
| [implementation/](implementation/) | The compressed implementation view: status registry, gap register, runtime and failure contracts, branch discipline, launch plans, runbooks. [Index](implementation/README.md). |
| [contracts/](contracts/) | Hand-written contract notes not yet generated. |
| [generated/](generated/) | Generated projections: schemas, reason codes, resource manifests, capacity reports. Never hand-edited. |

Operational fact that ages faster than the document — pricing, quotas, provider limits — belongs in an
external evidence record with a checked-at date, not in the architecture prose.
