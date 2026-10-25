# Eliot Research

A research workspace for one owner and the agents the owner connects: a shared library, readable sources with exact
passages, automatic distillation of every document, cited answers, project knowledge pages, deep research and an MCP
endpoint for external agents — on Cloudflare.

**Status:** the replacement is specified and its shell is merged; product contours K1+ are not built yet. Code under
`apps/`, `packages/`, `crates/` and `infra/` is the legacy system, kept as donor and data source until K10.

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | How work is done: contours, acceptance, budgets, what not to produce |
| [Architecture](docs/ARCHITECTURE.md) | Product, principles, guarantees, system shape |
| [Map](docs/MAP.md) | Contours K0–K10: what to build, where, acceptance, out of scope, budgets |
| [Implementation](docs/IMPLEMENTATION.md) | Technical contracts: data, ingest, citations, distillation, tools, Ask, search, models, UI |
| [Donors](docs/DONORS.md) | What to reuse per contour, with licences |
| [Eval](eval/README.md) | Fixed material and acceptance scripts |

Next step: [K0 — Shell](docs/MAP.md#k0--shell).

Earlier audits and the review register are preserved at
[`20400288/.github/audits`](https://github.com/UnknownAlienHuman/eliot-research/tree/204002889537de4af1583aa512cbb013cddccfe6/.github/audits);
[issue #380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) explains the earlier failure.

MIT. See [LICENSE](LICENSE).
