# S88 — Explicit product ABI and actual Worker shadow

Baseline a2aca127; ER-40/24/00. Begin with a ready canonical identity family. Existing Cargo workspace has three crates and CI self-tests, not all future product functions. Keep the existing TypeScript Worker.

## 1. Problem

Embedded vectors do not prove runtime marshalling, bounded memory or effect isolation. The original six exports also need an explicit scoped contract addition for the required policy and structural projection operations, not an arbitrary dispatcher.

## 2. Required change

One strict canonical byte envelope and one TS/Wasm adapter. Preserve the six existing product names/semantics, explicitly revise the existing language contract for exactly two additional exports, then implement the closed mapping below. No additional Cloudflare service or Rust RPC engine.

## 3. Documentation and real commands

[Language §§6.1–6.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), Cargo.toml, root package.json and canonical/test-vectors/kernel-wasm lib.rs.

```sh
git grep -n -F 'Additional exports require a contract revision or a scoped ADR.' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
pnpm rust:vectors
pnpm rust:boundaries
pnpm rust:wasm
```

Add **NEW** apps/eliotr-core/test/kernel-wasm-bridge.test.ts; after implementing the compiled bridge invoke `pnpm --dir apps/eliotr-core exec vitest run test/kernel-wasm-bridge.test.ts`. Final Rust aggregate is `pnpm rust:check`, not nonexistent rust:check-contracts. The existing rust:wasm build/check script must be updated within this task for the admitted exports/glue where its old CI-only assumptions differ; preserving its self-tests does not mean rejecting valid new contract exports. No dummy script aliases or --passWithNoTests.

## 4. Four checkpoints

### 88.1 — Explicit contract revision

Revise the existing contract as allowed by §6.3; preserve legacy byte identities. New names are exactly eliotr_evaluate_policy_v1 and eliotr_transform_projection_v1. Update strict operation schemas and ABI fixtures together; never claim the unchanged six-export contract already permitted the extension.

| Export | Closed operation family |
|---|---|
| eliotr_canonicalize_v1 | S78 canonical/identity bytes |
| eliotr_validate_transition_v1 | S79 owner, S85 W1/publication, S86 erasure, S87 fence/admissibility with separate strict operation payloads |
| eliotr_resolve_scope_v1 | S80 scope normalization/algebra/currentness |
| eliotr_qualify_bundle_v1 | S82 normalized source/bundle qualification |
| eliotr_validate_evidence_resolution_v1 | S84 exact evidence invariants |
| eliotr_map_completion_disposition_v1 | S84/S85/S87 existing outcomes, never stronger mappings |
| eliotr_evaluate_policy_v1 — added | S81 policy/residency/budget decision, no model/network I/O |
| eliotr_transform_projection_v1 — added | S83 pure byte/map/item transformation, no managed indexing |

Reuse the contract's protocol/operation/version/schema/input-digest/observed-time/policy-reference envelope; unknown versions/operations/schema fail. No function loading from untrusted names. Generated memory plumbing is not another domain API.

### 88.2 — Bounded transport

Selected implementation remains a wasm-bindgen byte-array shell (&[u8]→Vec<u8>), matching pinned crate/CLI and generated glue initialized from the imported precompiled Module. No workers-rs rewrite or runtime latest-tool download. Validate input byte bounds before marshalling, bounded decode/schema/version/digest after receipt, output bounds/digest before acceptance. Request/D1/R2 objects, callbacks and mutable JS graphs do not cross the domain ABI; pointer plumbing remains generated glue. Wire glue/build output into the existing Worker build, not a second deployment.

### 88.3 — One actual runtime operation

The new core test sends runtime canonical input to compiled Wasm and compares independent literal fixtures plus native Rust. Wrong UTF-8/version/operation/digest, max/max+1, truncation/trap and repeated-call cleanup must be tested. The old embedded-vector export is insufficient. Only after this passes, add another ready operation through the same ABI.

### 88.4 — Differential shadow

TS and Rust receive the same verified observations. Only the current authoritative path performs external/model/DB effects once; a mismatch/trap prevents affected authority settlement and gives content-free diagnosis, not a permissive fallback. Retain no global private-byte cache or independent domain clock/policy lookup. Measure the same input under both paths. Production owner switching/removal belongs to S89.

## 5. Acceptance criteria

- [ ] Existing contract explicitly covers the eight mapped exports with closed operations, compatible legacy identities and rejected unknown variants.
- [ ] Real workerd calls compiled Wasm on runtime bytes through the shipped glue; independent/native fixtures and typed errors agree.
- [ ] Invalid/trap/oversized/repeated calls neither leak input nor corrupt the next operation; temporary allocations are released and bounded.
- [ ] Shadow produces one set of effects and cannot publish a mismatch or quietly use a different authority.
- [ ] Actual vectors/boundaries/wasm/bridge tests and final rust:check pass with recorded checkpoint SHAs, artifact/glue size, startup/heap and per-family CPU. Tests are not declared run merely because this assignment now contains valid command names.
