# docs

| Directory | Contents |
|---|---|
| `architecture/` | [ELIOT_RESEARCH.md](architecture/ELIOT_RESEARCH.md) — the standalone authoritative architecture and implementation master for this service. |
| `adr/` | Architecture Decision Records. Required for any load-bearing default, new owner, provider selection or contract change. |
| `contracts/` | Hand-written contract notes not yet generated. |
| `generated/` | Generated projections: schemas, reason codes, resource manifests, capacity reports. Never hand-edited. |

Operational fact that ages faster than the document — pricing, quotas, provider limits — belongs in an
external evidence record with a checked-at date, not in the architecture prose.
