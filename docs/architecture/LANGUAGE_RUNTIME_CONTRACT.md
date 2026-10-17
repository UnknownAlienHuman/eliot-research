---
title: "Eliot Research language and runtime contract"
protocol: "eliotr.language-runtime.v1"
version: "1.1"
date: 2026-10-17
status: "normative"
authority: "normative for language ownership, runtime boundaries, testing, and migration in this repository"
facts_checked: 2026-09-01
decision: "TypeScript Cloudflare control plane + Rust deterministic kernel + SQL authority migrations"
---

# Eliot Research language and runtime contract

The 2026-10-17 revision applies [ADR-0019](../adr/0019-compact-refactoring.md): capability families are
modules before crates, migration proceeds through a real caller one operation at a time, and Rust ports
do not block the owner product selected in #377. This changes implementation direction, not wire ABI
versions or historical platform facts. At baseline `4e53d5e2`, the three Rust crates have no Worker
product ABI caller; TypeScript still executes the unpromoted product decisions.

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

[ADR-0016](../adr/0016-react-cloudflare-owner-ui.md) and
[ADR-0017](../adr/0017-owner-web-browser-runtime-and-tooling.md) select the existing React/Vite owner web.
Astro is frozen served compatibility until cutover. TypeScript retains browser composition; no backend
authority, extra service or independent authentication implementation moves into the browser.

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
  Static Assets / React owner-web routing (PWA compatibility until cutover)
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
| React owner web | TypeScript | Browser application; no backend authority; Astro compatibility retires at cutover |
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

### 5.2 Capability modules and actual crates

The existing workspace has `eliotr-canonical`, `eliotr-kernel-wasm` and `eliotr-test-vectors`. Extend
coherent modules in these crates first. The former 17-name target tree described capability families;
it is not a requirement to create 17 crates or complete them before the product can ship.

| Capability family | Implementation boundary |
|---|---|
| Canonical bytes, digests, stable identity | Existing pure canonical kernel and its internal modules |
| State, scope, policy, residency, qualification | Pure modules added only for a selected operation |
| Evidence, coverage, research, erasure, federation decisions | Pure modules selected by an actual consumer; effects stay outside |
| Projection/coordinate algorithms | Bounded pure transforms; no second parser or index runtime |
| Wasm entrypoint | Existing `eliotr-kernel-wasm`, one versioned adapter to selected pure operations |
| Shared vectors | Existing `eliotr-test-vectors`; parity checked after the operation is assembled |
| Offline bundle verification | Add an executable only when a selected product path needs it |

A new crate must justify a concrete dependency, build or public-interface boundary in its PR. A function,
work packet or line-count warning is not such a boundary. Do not mirror TypeScript packages mechanically.

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

Those cases are acceptance work after implementation assembly. Prefer row-local constraints, unique/FK
constraints and atomic CAS predicates; do not encode a duplicate domain engine in JSON-heavy views and
triggers. Pure preflight can move to its kernel owner, but the final concurrency predicate stays in the
transaction. Source cleanup never implies resetting deployed D1 or applying canceled S52 migrations.

## 8. Test and verification contract

During the current code phase, compile/lint the affected source and run minimal Clippy for changed Rust.
Tests and the broader acceptance gates below run after the functionality is assembled, before authority
promotion or release as applicable. They are not a test-writing or full-suite prerequisite to every edit.
Existing CI remains in place; unexecuted checks remain pending.

### 8.1 Rust gates

Assembled Rust authority promotion must pass, as applicable:

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
integrated owner-web Playwright tests
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

Migration vocabulary and order:

```text
M0  adopt this contract and freeze language-boundary drift
M1  create Cargo workspace, toolchain, CI, and shared test-vector crate
M2–M4  select one needed canonical/domain/disposition operation and implement it
M5     expose that operation through Wasm and its real Worker caller; check assembled parity
M6     promote that operation after runtime/byte/budget acceptance
M7     remove that operation's superseded TypeScript decision
       repeat for the next operation only when the product needs it
```

M2–M4 are capability families, not prerequisites requiring every family to be ported before M5.
Foundation/vector-only work does not complete a product slice. Existing pure code stays useful without
being advertised as active Worker authority; no migration family is a release prerequisite by default.

### 10.1 Freeze rule

Until a Rust capability is promoted:

- bug fixes and platform integration may continue in TypeScript;
- new domain fields or invariants must be added to versioned fixtures;
- new domain semantics must name the pure capability module and its current/target owner;
- no new large TypeScript domain package is allowed;
- no direct one-file-for-one-file Rust rewrite is allowed.

The N1 native coordinate-map contract is one such migration debt: its deterministic table-cell
mapping and source/content identity semantics currently execute in the TypeScript R2/D1 adapter,
with the pure projection capability family as its future Rust target (`eliotr-projection-core` was a
provisional crate name, not an instruction to create it). This checkpoint adds versioned
fixtures and strict wire validation but does not claim Rust/Wasm parity or promote a new authority.

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

The bounded task/PR identifies the current and target decision owner, real caller, effect boundary and
assembled acceptance. It needs no additional claim JSON, prerequisite commit or registry entry merely to
start implementation. Update runtime status when an operation actually changes owner.

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
