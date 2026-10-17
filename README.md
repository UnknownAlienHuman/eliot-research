# ELIOT Research

Cloud-hosted source library, cited answers, research reports and Wiki, with human and agent interfaces.
One Cloudflare Worker plus static owner-web assets; D1/R2 hold canonical records and bytes.

**Status: active implementation, not production-ready.** The source reviewed on 2026-10-17 is
[`4e53d5e2`](https://github.com/UnknownAlienHuman/eliot-research/commit/4e53d5e2296e7f4ed3ed29cef2f049891c5d20c0).
The [delivery record](docs/implementation/backend-delivery-plan.md) retains bounded October 16 live
receipts for questions, saved reports, exact citations, Inbox publication, model settings and MCP.
They do not establish the new owner-profile performance targets or completion of all features.

**Working here?** Start at [docs/START-HERE.md](docs/START-HERE.md) and
[the current tasks](docs/implementation/backend-entrypoints.md). Repository boundaries are in
[AGENTS.md](AGENTS.md).

## Current direction

The owner selected five working paths in [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377):

- project and sources → question → report with citations → reopen;
- project upload to Cloudflare AI Search;
- draft publication through Inbox;
- connected agents;
- task assignment to an agent.

[ADR-0018](docs/adr/0018-owner-single-function-first-profile.md) selects `OWNER_SINGLE`: fast summary
reads, one streamed synthesis for ordinary E0/E1 questions, and explicit deep E2/E3 research.
[ADR-0019](docs/adr/0019-compact-refactoring.md) defines the compact refactor, including the
[rechecked audit findings](.github/audits/2026-10-17/README.md).

The target UI is the existing **React/Vite** app, `@eliotr/ui` and one `owner-api-client`.
**Astro is no longer a target.** Wrangler still serves the legacy `eliotr-pwa` assets at this baseline;
the integrated React build/deploy bridge and browser retirement remain to be completed.

Search uses **Cloudflare AI Search or the model provider's search**. S52's custom index, generation
registry, target manifests and promotion/rollback layer are canceled. Rust migrations and the archived
44-PR program do not block the owner product. Backup/export/restore execution remains deferred; retained
data and erasure obligations remain.

## Product

| Surface | Purpose |
|---|---|
| Library | Sources, original bytes, revisions, project membership and imports |
| Lens | Find and navigate relevant or exact source material |
| Research | Ordinary cited answers, explicit deep investigations, comparisons and reports |
| Wiki / Inbox | Review, publish and reopen versioned research material with its limitations |

Orientation, exact retrieval and report construction need different behavior. A relevance hit is a
locator; an exact citation resolves the admitted revision and bytes. Completeness and absence require
a known scope and honest coverage. A model cannot create citation authority or promote a draft to an
accepted conclusion by claiming success.

ELIOT Research owns its sources, investigations and published artifacts. An optional consuming client,
including ELIOT Memory OS, owns its own task, memory, policy and decisions. There is no shared canonical
database, reverse authority channel or local copy of Eliot Swarm Controller. External agents use the
existing bounded task/MCP interfaces.

## Architecture

- **One application:** `apps/eliotr-core` composes HTTP/MCP, Queue, Scheduled, Workflow and bounded session
  transports. Packages are libraries, not services.
- **Managed infrastructure:** Workers, D1, R2, Queues, Workflows, AI Search, model gateways and conversion
  capabilities are used through their native interfaces. No custom vector database or workflow server.
- **Coherent owners:** source identity, exact evidence, artifacts, Wiki heads, tasks and receipts each use
  their existing writer and lifecycle. UI, indexes and transport caches do not become separate truth stores.
- **Language by responsibility:** TypeScript owns Cloudflare I/O and React; promoted pure Rust operations own
  deterministic decisions; SQL enforces storage constraints and atomic changes. There are three Rust crates
  today and no Worker product ABI caller yet. The former 17-crate target is a capability map, not a quota.
- **Short owner paths:** ordinary reads avoid per-item evidence reopening; evidence is verified on citation
  open. Mutations retain idempotency, spend bounds and atomic expected-state checks.
- **Measured simplification:** reuse existing code and donor primitives, migrate callers, remove duplicates.
  Source-size counters never justify wrapper packages or splitting one capability mechanically.

Detailed semantics remain in [ELIOT_RESEARCH.md](docs/architecture/ELIOT_RESEARCH.md); read its current
applicability table first. [LANGUAGE_RUNTIME_CONTRACT.md](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md)
covers the Rust/TypeScript/SQL boundary. [ADR-0016](docs/adr/0016-react-cloudflare-owner-ui.md) and
[ADR-0017](docs/adr/0017-owner-web-browser-runtime-and-tooling.md) cover React and browser cutover.

## Source layout

| Path | Role |
|---|---|
| `apps/eliotr-core` | Single deployable Worker and composition |
| `apps/eliotr-web` | Target React/Vite owner interface |
| `apps/eliotr-pwa` | Served compatibility UI pending cutover; no new Astro design work |
| `packages/ui`, `packages/owner-api-client` | Shared UI primitives and one browser transport/decoder layer |
| Other `packages/` | Contracts, application capabilities and Cloudflare adapters |
| `crates/` | Existing pure kernel, Wasm adapter and vector support |
| `infra/d1` | Canonical/search schema history; actual deployed ledger governs migration decisions |
| `docs/` | Current decisions, source contracts, operational evidence and bounded tasks |
| `.github/audits/` | Dated source findings and donor snapshots |

## Development and acceptance

Use one manager checkout/worktree and disjoint leaf assignments. Old ER-49 claim JSON and Git ancestry
tools are optional historical audit, not a prerequisite for source edits. During implementation use scoped
compilation/lint and minimal Clippy for changed Rust. Tests and broad product/platform acceptance follow
assembly; a pending check is never a passing result.

The narrow [frontend workflow](.github/workflows/frontend-owner.yml) has push/PR product checks and a
separate manual/advisory provenance job. Other workflows retain their configured triggers; do not infer
their behavior from an old blanket “manual-only” statement. This documentation refactor changes no CI.

Performance goals remain **unverified**: owner lists below 500 ms, first token below 4 seconds, ordinary
answers within 30 seconds on the specified comparison workload. Code compilation, a fixture build, a
provider response or Workflow completion alone does not establish those results or production readiness.

## License

MIT. See [LICENSE](LICENSE).
