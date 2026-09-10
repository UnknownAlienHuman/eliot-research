---
title: "Eliot Research language and runtime contract"
protocol: "eliotr.language-runtime.v1"
version: "1.0"
date: 2026-09-01
status: "normative"
authority: "normative for language ownership, runtime boundaries, testing, and migration in this repository"
facts_checked: 2026-09-01
decision: "TypeScript Cloudflare control plane + Rust deterministic kernel + SQL authority migrations"
---

# Eliot Research language and runtime contract

## 0. Binding decision

Eliot Research uses a deliberately hybrid stack:

```text
TypeScript
  owns the Cloudflare control plane, runtime composition, product transports,
  browser application, and deployment/provisioning integration.

Rust
  owns pure deterministic domain decisions, canonicalization, algorithms,
  invariant evaluation, native verification tools, and the portable Wasm kernel.

SQL
  owns D1 schema, constraints, indexes, migration history, and executable
  transaction/rollback fixtures.
```

This decision is permanent until superseded by a later normative ADR. It is not a temporary compromise
and it is not a license to implement the same authority twice.

The priority order is:

1. fastest safe adoption of current Cloudflare platform capabilities;
2. correctness, testability, reproducibility, and reviewability;
3. runtime performance and resource efficiency;
4. source-language percentage or aesthetic uniformity.

A GitHub Linguist percentage is not an architectural goal. Language ownership is determined by the
responsibility boundaries below.

## 1. Platform facts behind the decision

As checked on 2026-09-01:

- Cloudflare Workers provides first-class support for JavaScript, TypeScript, Python, and Rust.
- TypeScript runtime and binding types are generated from `workerd` and the active Wrangler
  compatibility date, flags, and bindings.
- Rust Workers use `workers-rs`, compile to `wasm32-unknown-unknown`, and rely on generated JavaScript
  plumbing through `wasm-bindgen`.
- AI Search is documented and exposed as a Worker binding with JavaScript/TypeScript examples and
  binding types.
- Workflows documentation and templates are TypeScript-first.
- Cloudflare's supported Vitest integration runs TypeScript/JavaScript tests inside the Workers
  runtime with local binding access and per-test isolation.

Authoritative references:

- https://developers.cloudflare.com/workers/languages/
- https://developers.cloudflare.com/workers/languages/typescript/
- https://developers.cloudflare.com/workers/languages/rust/
- https://developers.cloudflare.com/ai-search/api/search/workers-binding/
- https://developers.cloudflare.com/workflows/get-started/guide/
- https://developers.cloudflare.com/workers/testing/vitest-integration/

These facts may change. The ownership rules below are intentionally resilient: Cloudflare-specific
integration stays at the TypeScript boundary until a measured migration proves that a Rust binding is
equally current, testable, and operationally simpler.

## 2. One deployable Worker remains authoritative

The topology in `ELIOT_RESEARCH.md` remains unchanged:

```text
one eliotr-core Worker
  HTTP owner API
  federation API
  private MCP
  Queue consumer
  scheduled handlers
  ResearchSession Durable Object
  ResearchWorkflow
  Static Assets / PWA routing
```

The hybrid stack does not create a service mesh, a second backend, or a second authority plane.

Rust code is embedded as a Wasm module or executed as an offline native tool. It does not introduce:

- a Rust microservice;
- Cloud Run;
- a second Worker solely to host domain logic;
- a second D1/R2 authority;
- network RPC between TypeScript and Rust;
- a second mutable source owner.

## 3. Language ownership matrix

| Capability | Owning language | Binding rule |
|---|---|---|
| Worker entrypoint and request routing | TypeScript | Permanent platform boundary |
| Cloudflare Access and JWKS lifecycle | TypeScript | Native Web Crypto, Fetch, headers, cache |
| D1 queries and transaction orchestration | TypeScript + SQL | SQL carries constraints; TS owns bindings |
| R2 streaming, multipart, range, conditional writes | TypeScript | Native Web Streams and R2 binding |
| Queue producer, consumer, ACK, retry, DLQ | TypeScript | Native Queue event lifecycle |
| Scheduled handlers | TypeScript | Native Worker event |
| Durable Objects and WebSockets | TypeScript | Native class/binding lifecycle |
| Cloudflare Workflows | TypeScript | Native/current Workflow API |
| AI Search | TypeScript | Native/current AI Search binding |
| Workers AI and AI Gateway | TypeScript | Fastest model/option support |
| Analytics Engine and observability sinks | TypeScript | Native bindings |
| MCP transport and JSON-RPC framing | TypeScript | HTTP/Access/stream boundary |
| Google Workspace and gcloud orchestration | TypeScript | Official CLI/Node ecosystem boundary |
| PWA | TypeScript | Browser application; no authority |
| Provisioning and Wrangler automation | TypeScript/Node | Tracks Cloudflare resource schema quickly |
| Canonical serialization rules | Rust | Pure deterministic kernel |
| Stable IDs and content-derived digests | Rust | Pure deterministic kernel |
| Domain state machines | Rust | Exhaustive enums and transition proofs |
| Scope algebra | Rust | Pure deterministic evaluator |
| Policy, residency, disclosure invariants | Rust | No platform I/O |
| Qualification and admission decisions | Rust | Deterministic decision function |
| Evidence and coverage disposition logic | Rust | No provider/platform authority |
| Structural projection algorithms | Rust | Byte/range transforms only |
| Erasure/federation/research logical invariants | Rust | Effects remain in TypeScript adapters |
| Normalized Bundle verifier CLI | Rust native | Offline verification and preprocessing gate |
| Corpus/load/benchmark tools | Rust native | Native parallelism outside Workers |
| D1 schema and migrations | SQL | Versioned, executable, append-only history |
| Heavy OCR/PDF/ML preprocessing | External tool, Python allowed | Never part of the Worker authority runtime |

## 4. TypeScript control-plane contract

TypeScript owns integration with fast-moving Cloudflare products.

### 4.1 Allowed responsibilities

TypeScript may:

- authenticate and authorize a request;
- perform strict structural wire decoding and byte-limit checks before allocating Wasm memory;
- read and write D1 through prepared statements;
- stream data to and from R2;
- produce and consume Queue messages;
- start and resume Workflows;
- coordinate Durable Objects and WebSockets;
- call AI Search, Workers AI, AI Gateway, Google, and qualified external providers;
- persist Intent, Attempt, Receipt, Readback, and Reconciliation records;
- map typed kernel results to HTTP/MCP/product responses;
- emit content-free metrics;
- provide the PWA and provisioning tools.

### 4.2 Forbidden responsibilities

Once a capability has a promoted Rust implementation, TypeScript must not independently decide:

- whether a domain state transition is valid;
- whether two canonical bodies are equivalent;
- whether a scope expression resolves to an allowed immutable set;
- whether an admission, evidence, coverage, erasure, federation, or completion disposition is valid;
- whether unsupported precision may be claimed;
- whether a canonical ID or digest is correct.

TypeScript may reject malformed or oversized input earlier. It may never strengthen a Rust result.

### 4.3 Cloudflare update policy

The Cloudflare boundary must remain current:

- `compatibility_date` is reviewed at least monthly;
- Wrangler and generated binding types are updated through a tested PR, not ad hoc;
- new stable Cloudflare capabilities may be integrated in TypeScript immediately;
- Rust support is not a prerequisite for using a needed Cloudflare product;
- experimental compatibility flags require a named test and rollback note;
- provisioning code must fail closed on unknown load-bearing resource fields;
- `wrangler types` and `wrangler deploy --dry-run` are release gates.

## 5. Rust deterministic-kernel contract

Rust owns decisions that must be exact, exhaustive, portable, and heavily testable.

### 5.1 Pure-core rule

Core crates must not depend on:

- `worker`, `worker-sys`, `web-sys`, or Cloudflare binding types;
- network clients;
- filesystem authority;
- environment variables;
- system clock reads;
- random-number generation;
- process execution;
- global mutable state.

Time, randomness, generations, policy snapshots, and observed platform state are explicit input data.

A valid kernel function resembles:

```text
canonical bytes + versioned context
→ deterministic typed result or deterministic typed error
```

It does not perform effects.

### 5.2 Target crate layout

The target workspace is:

```text
crates/
  eliotr-canonical
  eliotr-contract-core
  eliotr-identities
  eliotr-state-machines
  eliotr-scope
  eliotr-policy
  eliotr-residency
  eliotr-qualification
  eliotr-evidence
  eliotr-coverage
  eliotr-projection-core
  eliotr-erasure-core
  eliotr-federation-core
  eliotr-research-core
  eliotr-kernel-wasm
  eliotr-bundle-cli
  eliotr-test-vectors
```

Crates remain micro-modular. A crate owns one coherent authority or algorithmic family; it does not mirror
the current TypeScript file tree mechanically.

### 5.3 Safety policy

Pure crates use:

```rust
#![forbid(unsafe_code)]
```

They also deny, unless a crate documents a narrow exception:

```text
clippy::unwrap_used
clippy::expect_used
clippy::panic
clippy::todo
clippy::unimplemented
```

Any required unsafe code is isolated in a small adapter crate, reviewed separately, and never mixed with
domain logic.

## 6. TypeScript ↔ Rust/Wasm ABI

The ABI is deliberately small and versioned.

### 6.1 Data boundary

Allowed:

```text
UTF-8 canonical bytes in
→ deterministic operation
→ UTF-8 canonical bytes or typed error out
```

Forbidden:

- passing D1, R2, Queue, Workflow, Durable Object, Fetcher, Request, or Response handles into Rust;
- passing arbitrary mutable JavaScript object graphs;
- Rust fetching its own policy, clock, owner generation, or source revision;
- callbacks from Rust that perform authority mutations;
- hidden platform state inside Wasm globals.

### 6.2 Operation envelope

Every exported operation carries:

```yaml
protocol:
operation:
operation_version:
schema_generation:
input_sha256:
explicit_observed_time:
explicit_policy_or_generation_refs:
payload:
```

Every successful result carries:

```yaml
protocol:
operation:
operation_version:
schema_generation:
output_sha256:
payload:
```

Every failure carries a stable typed code and cannot contain source text, credentials, or stack traces in
the product response.

### 6.3 Initial exports

The first admissible Wasm exports are:

```text
eliotr_canonicalize_v1
eliotr_validate_transition_v1
eliotr_resolve_scope_v1
eliotr_qualify_bundle_v1
eliotr_validate_evidence_resolution_v1
eliotr_map_completion_disposition_v1
```

Additional exports require a contract revision or a scoped ADR.

## 7. SQL authority contract

D1 migrations remain SQL even when decision logic moves to Rust.

Rules:

- migrations are append-only after merge;
- constraints must encode identity, generation, digest, and terminal-state invariants where SQLite can
  enforce them;
- TypeScript performs bindings and transaction orchestration;
- Rust may generate or verify canonical values but does not own a live D1 connection;
- every authority transaction has an executable SQLite fixture;
- a change-count or provider acknowledgement is not readback proof;
- rollback, stale-CAS, lost-ACK, duplicate, and conflicting-replay cases are mandatory.

## 8. Test and verification contract

### 8.1 Rust gates

Every Rust change must pass, as applicable:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo nextest run --workspace --all-features
cargo test --doc --workspace
cargo deny check
cargo build --workspace --target wasm32-unknown-unknown --release
```

Coverage-bearing core crates additionally pass branch-aware `cargo llvm-cov`. The default promotion
threshold is 90% line coverage for deterministic core crates; lower thresholds require a documented
exception.

Scheduled or pre-release gates include:

```text
Miri for pure crates
cargo-fuzz corpora
property tests
mutation testing on critical state machines
cargo-semver-checks for public crates
```

### 8.2 TypeScript/Cloudflare gates

The platform boundary must pass:

```text
strict TypeScript project references
type-aware ESLint
Vitest inside workerd through the Cloudflare plugin
D1/R2/Queue/DO isolated integration tests
Cloudflare integration harness for production builds
wrangler types
wrangler deploy --dry-run
compressed bundle budget
startup budget
PWA Playwright tests
```

A native Rust test cannot replace a Workers runtime test.

### 8.3 Differential conformance

During migration, one fixture corpus runs against:

```text
existing TypeScript reference
native Rust
compiled Rust/Wasm
```

Promotion requires equality of:

- canonical output bytes;
- SHA-256;
- stable ID;
- typed result;
- typed error code;
- state transition;
- receipt identity;
- coverage/completion disposition.

A mismatch fails closed and blocks authority mutation. Production does not silently choose whichever
implementation returned first.

## 9. Performance and bundle rules

Rust is selected for correctness first and performance second.

No capability moves into Wasm solely to increase the repository's Rust percentage.

Before production promotion, the Rust/Wasm path must prove:

- no regression beyond the internal compressed Worker budget;
- no regression beyond the startup budget;
- bounded Wasm memory;
- equal behavior under native and Wasm execution;
- measured p50/p95 CPU improvement or a documented correctness benefit;
- no increased number of platform round trips.

If Wasm makes a non-critical operation slower, larger, or less maintainable, the operation may remain
TypeScript unless it owns a critical invariant that requires the Rust proof surface.

## 10. Migration from the current TypeScript implementation

The current TypeScript implementation is a transitional executable specification, not disposable code
and not the final owner of domain authority.

Migration order:

```text
M0  adopt this contract and freeze language-boundary drift
M1  create Cargo workspace, toolchain, CI, and shared test-vector crate
M2  move canonical JSON, digests, stable IDs, and generation tokens
M3  move state machines, scope algebra, policy, residency, and qualification
M4  move evidence, coverage, erasure, federation, and research dispositions
M5  compile the kernel to Wasm and run differential shadow mode
M6  promote Rust results to authority one capability at a time
M7  remove the superseded TypeScript domain implementation
```

### 10.1 Freeze rule

Until a Rust capability is promoted:

- bug fixes and platform integration may continue in TypeScript;
- new domain fields or invariants must be added to versioned fixtures;
- new domain semantics must name the target Rust crate;
- no new large TypeScript domain package is allowed;
- no direct one-file-for-one-file Rust rewrite is allowed.

### 10.2 Shadow-mode rule

Shadow execution:

- performs no duplicate external effect;
- does not pay for a model/provider call twice;
- compares only deterministic inputs and outputs;
- records a content-free mismatch receipt;
- blocks authority promotion on mismatch;
- has a bounded rollback switch.

### 10.3 Removal rule

A TypeScript domain implementation is removed only after:

- native Rust tests pass;
- Wasm tests pass;
- differential fixtures pass byte-for-byte;
- Cloudflare runtime tests pass;
- bundle/startup budgets pass;
- the implementation-status registry names the Rust owner;
- rollback instructions exist.

Permanent dual authority is prohibited.

## 11. Python and other languages

Python is not part of the production Worker topology.

Python may be used only for a qualified external preprocessing capability whose ecosystem provides a
clear advantage, such as OCR, layout extraction, or specialized ML. Its output enters ERC only through
the same Normalized Bundle admission and verification path as any other external provider.

Any additional production language requires a normative ADR proving:

- a capability unavailable or materially inferior in the current stack;
- a bounded authority boundary;
- dependency and security ownership;
- CI, deployment, rollback, and observability;
- no second mutable authority.

## 12. Agent rules

Agents must read this file before:

- creating a crate;
- adding a Cloudflare binding;
- adding domain semantics to TypeScript;
- introducing another language;
- changing the TypeScript↔Wasm ABI;
- moving a capability from shadow to authority.

A work packet must state:

```text
language owner
platform owner
authority owner
test owner
migration phase
live gate
```

A PR that violates the language ownership matrix is rejected even if it compiles.

## 13. Acceptance criteria for this contract

This contract is considered adopted when:

- it is linked from `AGENTS.md` and `IMPLEMENTATION.md`;
- branch and CI rules prevent agents from silently bypassing it;
- the first Rust workspace PR adds no Cloudflare binding to pure crates;
- the existing TypeScript Worker remains deployable throughout migration;
- every promoted Rust capability has differential fixtures;
- no live qualification is inferred from local Wasm or mock execution.

## 14. Supersession

A future decision may move a Cloudflare integration from TypeScript to Rust only when all of the
following are demonstrated on the then-current platform:

1. official or equivalently maintained Rust binding coverage;
2. no lag for required Cloudflare features;
3. equal or better workerd-level testing;
4. smaller or equal operational surface;
5. acceptable bundle/startup/memory measurements;
6. an exact rollback path.

Until then, TypeScript remains the Cloudflare control plane and Rust remains the deterministic kernel.
