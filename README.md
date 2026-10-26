# Eliot Research

A private research workspace for one owner and connected agents: shared Library, immutable readable sources, exact
passages, budgeted one-time source distillation, cited answers, project knowledge, bounded deep research and MCP — on
Cloudflare.

**Status:** K0/K1 are delivered on `main`, including the duplicate-attachment fix in `d84e8b51`. The active local
K2/K3 work remains unaccepted; current evidence, open gates and deployment boundaries are in the
[delivery map](docs/MAP.md). Legacy `apps/`, `packages/`, `crates/` and `infra/` remain donor/import material until
K10 and are not implementation instructions.

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | execution, acceptance, cost and coordination rules |
| [Architecture](docs/ARCHITECTURE.md) | product, invariants, guarantees and Cloudflare system shape |
| [Map](docs/MAP.md) | contours K0–K10, acceptance classes, budgets and explicit deferrals |
| [Implementation](docs/IMPLEMENTATION.md) | data/API/citation/model/search contracts and dated platform facts |
| [Donors](docs/DONORS.md) | exact reuse pins, paths, licences and boundaries |
| [Eval](eval/README.md) | fixed material and real-product acceptance scripts |

Start with the [reading order](docs/START-HERE.md), then the active [K2](docs/MAP.md#k2--ask) or
[K3](docs/MAP.md#k3--distill) contour. Architecture, Map, Implementation and Donors are the four product authorities;
this page is navigation only.

`pnpm dev` runs the local app; `pnpm check` runs lint, typecheck, focused tests and build. For the running app,
Without the model opt-in, `pnpm eval k3` validates stored K3 hard gates without model calls and fails when required
evidence is missing.
See [eval modes and prerequisites](eval/README.md#runtime) before running a contour eval.

MIT. See [LICENSE](LICENSE).
