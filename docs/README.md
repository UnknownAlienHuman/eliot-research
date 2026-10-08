# docs

Start at [START-HERE.md](START-HERE.md) — the single repository entry point.

| Path | Contents |
|---|---|
| [START-HERE.md](START-HERE.md) | **The entry point.** Role router, authority order, manager worktrees, build phase and release separation. |
| [architecture/](architecture/) | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md) — the standalone authoritative architecture — and [LANGUAGE_RUNTIME_CONTRACT.md](architecture/LANGUAGE_RUNTIME_CONTRACT.md), the TypeScript/Rust/SQL authority boundary. |
| [adr/](adr/) | Architecture Decision Records. Required for any load-bearing default, new owner, provider selection or contract change. |
| [agent-work/](agent-work/) | Work packets: exact path ownership, required outputs and mandatory negative cases. [Packet index](agent-work/README.md), [manifest.json](agent-work/manifest.json), [additive fragments](agent-work/packets/). |
| [implementation/](implementation/) | Current backend router, status/gaps, runtime/failure contracts, worktree discipline, launch plans and runbooks. Start backend work at [backend-entrypoints.md](implementation/backend-entrypoints.md); [directory index](implementation/README.md). |
| [s92/](s92/README.md) | S92 local setup runbook and INPUT draft; delivered scenario source and separately pending acceptance. |
| [design/](design/README.md) | Non-normative UI proposals, interactive prototypes and visual mockups. The active replacement owner is PR #329, not an old prototype branch. |
| [contracts/](contracts/) | Hand-written contract notes not yet generated. |
| [generated/](generated/) | Generated projections: schemas, reason codes, resource manifests and capacity reports. Never hand-edited. |

Operational facts that age faster than the repository — pricing, quotas and provider limits — belong in
checked-at evidence records, not timeless architecture prose.
