# ELIOT Research

**Pluggable external research federation for ELIOT Memory OS.**

> **Status: active implementation; not production-ready.** The authoritative standalone contract is
> [Eliot Research Cloud 29.1](docs/architecture/ELIOT_RESEARCH.md), and the language boundary is governed
> by [eliotr.language-runtime.v1](docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md). Several authority
> paths are implemented and pass deterministic CI, but mandatory product routes and real Cloudflare,
> Google, provider, recovery and workload qualification remain open. See the
> [machine-readable implementation status](docs/implementation/implementation-status.json),
> [gap register](docs/implementation/gap-register.md), and
> [production readiness plan](docs/implementation/production-readiness-plan.md).

---

## What this is

A cloud-hosted evidence library and controlled research system: sources with revisions, a corpus lens,
an evidence-linked research wiki, and governed investigations with explicit coverage accounting.

Four user-facing surfaces:

```text
LIBRARY    sources, originals, revisions, web snapshots, exports, repositories
LENS       exact, lexical and semantic retrieval; structure; source cards; project atlas
WIKI       versioned research wiki with evidence, hypotheses and stated limitations
RESEARCH   investigations, deep research, comparisons, fact checks, audits and reports
```

It serves three genuinely different products that one retrieval pipeline cannot cover:

| Product | Question it answers |
|---|---|
| **Orientation** | What is in this corpus, how is it connected, where should I read next? |
| **Precision** | Give me the exact fragment, number, table, row, page, event or handle. |
| **Materialization** | Assemble an investigation, audit, wiki page or report of practical size. |

## What this is not

- **Not a second Memory OS.** It does not own cognitive inheritance, epistemic position, task
  authority, canonical decisions or procedures.
- **Not an authority.** Every intelligent result crosses the boundary as an evidence bundle or as
  synthesis marked candidate. Nothing promotes itself to truth in ELIOT.
- **Not required.** ELIOT works without it. An absent or degraded federation narrows declared coverage
  and is reported as a gap.
- **Not a heavy-preprocessing host.** Document engines, OCR, layout analysis and code analyzers stay
  outside this runtime; it consumes a versioned normalized bundle instead.

## Ownership split

```text
ELIOT Research     acquires, parses, indexes, retrieves, investigates and publishes
ELIOT Memory OS    interprets research in the context of the active task and system state
                   and decides what enters cognitive inheritance, position and policy
ELIOT Search       prepares and retrieves local data, separately and independently
```

The federation is asynchronous and durable: jobs expose progress, cancellation, partial results,
source coverage and a terminal disposition. There is no reverse authority channel — this service never
requests ELIOT agents, never mutates ELIOT state, never shares its database or provider credentials,
and never receives task authority.

## Design commitments

**Managed where managed is better.** Runtime, static assets, access, metadata database, object storage,
queues, durable coordination, workflows, managed retrieval, embeddings, reranking, conversion, browser
capture and model gateways are used as products. No self-built vector database, embedding runtime,
ranking engine, crawler platform, workflow server or agent framework.

**First-party where nothing managed exists.** Source identity and revisions, evidence handles, project
and scope algebra, qualification and readiness, exact and high-recall guarantees, corpus lens
semantics, investigation and protocol model, hypothesis and evidence ledgers, controlled distillation,
coverage receipts, wiki contract, artifact compiler, federation, disclosure and budget policy.

**Hybrid runtime by responsibility.** TypeScript owns the fast-moving Cloudflare control plane, product
transports, PWA and deployment integration. Rust owns the pure deterministic kernel and native
verification tools. SQL owns D1 schema, constraints and executable transaction fixtures. Language
percentage is not an architectural objective, and permanent duplicate TypeScript/Rust authority is
forbidden.

**One owner per state family.** Original bytes, source identity, normalized artifacts, projects,
evidence handle mapping, investigations, wiki heads, jobs and receipts, erasure cases and the purge
ledger each have exactly one owner. Anything needed to reconstruct evidence, a wiki page, an
investigation, erasure history or an artifact may never exist only in an index, a queue, a live
session or a transport copy.

**Immutable does not mean legally undeletable.** Ordinary mutation creates a new revision. Deletion
happens only through a dedicated, fenced erasure process with a non-revealing purge ledger entry and a
terminal handle state. Maintenance jobs, agents and the ordinary owner API have no hard-delete
capability. Content addressing is scoped by erasure and retention domain, because identical bytes may
simultaneously belong to a source that must be kept and a source that must be deleted.

**Retrieval is not proof.** A managed relevance engine finds relevant material. Completeness and
absence require a declared, frozen, recheckable denominator. Every material statement resolves to an
evidence handle against a pinned revision, and a model may never mint a citation identifier.

**Injection safety is executable, not prose.** Source content enters a model only inside a typed
untrusted-data envelope carrying taint and an effect ceiling. Research generation receives read-only
tools; side-effect-capable tools are absent from the surface, not merely discouraged. Every
membership-changing transformation records whether untrusted structure changed the selection.

## Repository layout

```text
apps/
  eliotr-core/            the single deployable Worker application
  eliotr-pwa/             owner-facing progressive web app

packages/
  contracts/              versioned wire and domain types, incl. the ELIOT federation contract
  domain/                 transitional TypeScript domain implementation
  policy/                 transitional TypeScript policy implementation
  platform-cloudflare/    thin adapters over managed platform primitives
  retrieval/              lanes, query products, evidence handle resolution
  research/               investigations, protocols, hypotheses, coverage, artifact compilation
  interfaces/             owner API, private agent surface, federation endpoint
  google-drive-exchange/  bounded external-client transport — class Experiment, has an expiry
  testkit/                shared fixtures, fakes and assertion helpers

crates/                    target Rust deterministic-kernel workspace; introduced by migration M1+

infra/
  d1/                     metadata schema migrations and named query registry
  r2/                     object storage layout, storage and erasure domains, retention
  ai-search/              managed retrieval instance profiles and capacity plan
  workflows/              durable workflow stage definitions

docs/
  architecture/  adr/  contracts/  generated/  implementation/

tests/
  golden-corpus/          versioned real-document corpus
  fixtures/               recorded deterministic fixtures
```

A package or crate is not a service. Everything deploys as one Worker application plus static assets;
the Rust kernel is embedded as Wasm or used by offline native verification tools.

## Delivery order

Vertical slices, each producing a working user loop before the next layer of research machinery.

| Slice | Delivers |
|---|---|
| **0** | Platform skeleton, resource profile, access, federation fixtures, one real write and readback |
| **1** | Evidence-grade retrieval and grounded chat: sources, revisions, normalization, qualification, evidence handles, exact and semantic lanes |
| **2** | Minimum wiki and ELIOT federation: statement labels, evidence map, agent surface, ranged reads, draft inbox |
| **3** | Corpus lens: source cards, document maps, project atlas, multi-project scopes, readiness and coverage |
| **4** | Controlled investigation: protocols, question graph, hypothesis cards, source portfolio, branches, coverage receipts |
| **5** | Distillation, audits and the artifact compiler |
| **6** | Hardening; optional replacement of the external client transport |
| **7** | Specialist profiles: code intelligence, scholarly metadata, conversation episodes, structured data |

A slice is not complete until a real round trip through the real platform has executed. A passing type
check is not a deployment gate. The ordered closure criteria are maintained in the
[production readiness plan](docs/implementation/production-readiness-plan.md).

## Continuous integration

Pull-request CI is enabled. It installs the frozen pnpm graph and runs contract fixtures, package
boundaries, source budgets, work-packet validation, D1 authority fixtures, lint, strict TypeScript,
unit and Workers-runtime tests, PWA build, generated Cloudflare binding types and a Wrangler deployment
dry-run. Branch hygiene runs independently on `main`.

Rust gates become mandatory when migration M1 introduces the Cargo workspace. No green local or CI gate
is represented as live Cloudflare, Google, provider, recovery or workload qualification.

## License

MIT. See [LICENSE](LICENSE).

The repository is public under the MIT license. Contracts and implementation status remain explicitly
versioned while the product is not production-ready.
