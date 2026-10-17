# Dependency and authority map

Apply [ADR-0019](../adr/0019-compact-refactoring.md) and the
[current router](backend-entrypoints.md). The existing packages locate responsibilities; they are not a
requirement to preserve every forwarding layer or create a new package per capability.

## Compile-time direction

| Consumer | Dependency boundary |
|---|---|
| Pure domain/policy/retrieval/research decisions | Contracts and pure capability modules; no Cloudflare bindings or network I/O. |
| Promoted Rust decisions | Pure kernel modules behind the existing versioned Wasm adapter; no platform effects. Unpromoted decisions currently execute in TypeScript. |
| Platform/application adapters | Contracts, pure decisions and application ports; own D1/R2/provider effects without duplicating decisions. |
| `apps/eliotr-core` | Binds the concrete adapters, HTTP/MCP, Queue, Workflow and DO entrypoints into the one Worker. |
| `apps/eliotr-web` | Existing `packages/ui`, shared owner API client, Query and Router; no server authority in the browser. |
| `packages/owner-api-client` | Contract DTOs and HTTP/Agents transport; one shared decoding owner. |
| `apps/eliotr-pwa` | Served compatibility until React cutover; no new feature architecture. |

`platform-cloudflare` may implement application ports; domain packages never import it. `eliotr-core`
is the composition root. Actual import edges remain in package manifests and TypeScript project
references; change those together when consolidating a boundary. Optional Drive Exchange and federation
do not become dependencies of the selected owner paths merely because their packages exist.

## State authority

| State family | Authoritative owner | Rebuildable projection |
|---|---|---|
| ERC source identity/revisions | D1 Core | no |
| retained originals/normalized artifacts | R2 Evidence + D1 manifest | no, except governed erasure |
| projects/memberships/scope snapshots | D1 Core | no |
| evidence handle registry | D1 Core + immutable R2 manifest | no; tombstone remains |
| investigations/jobs/receipts/outbox | D1 Core + R2 checkpoints | no |
| Wiki/artifact heads | D1 Core | no |
| Wiki/artifact immutable bodies | R2 Work | no |
| existing narrow exact/lexical projection | D1 Search | yes |
| hybrid/literal relevance projection | AI Search | yes |
| queued delivery | Queue/DLQ | yes; D1 outbox is intent |
| connected presentation state | ResearchSession DO | yes |
| Drive rows/docs | external transport copy | yes after R2 freeze + D1 admission |

Use Cloudflare AI Search or provider-native search. #377 canceled the additional S52 custom index,
managed-target/generation registry and required-set promotion/rollback. Existing source admission,
membership/outbox and canonical evidence remain; projection results are locators, not evidence authority.

## One-writer rules

- One mutable owner per source namespace; generation changes fence stale writers.
- D1 expected-revision CAS owns mutable heads.
- R2 canonical keys are immutable within a complete residency identity.
- Queue consumers never invent work; they deliver a persisted intent.
- A Workflow owns one durable operation, not a global scheduler.
- ResearchSession DO owns the live presentation projection; it neither executes a second research graph
  nor owns an independent transcript or durable result.
