# S88 — Product ABI, explicit operation coverage, and differential shadow

Baseline `a2aca127`; ER-40/24/00. Begin with an accepted canonical identity family, not completion of every pure-kernel family. Current `Cargo.toml` has three crates; `eliotr-kernel-wasm`'s CI self-tests are not product exports. Work in current main, preserving the existing TypeScript Worker.

## 1. Problem

Embedded vectors do not prove runtime marshalling or effect isolation. The earlier task also required every mandatory pure family while permitting only six initial export names, without explicitly assigning policy evaluation and structural projection to a product interface. That decision must be resolved before implementation, not improvised as an arbitrary dispatcher.

## 2. Required change

Implement one canonical byte envelope and one TypeScript-to-Wasm adapter. Preserve the six initial exports. First make the scoped, backward-compatible language-contract amendment below for two additional pure-operation exports, then implement its strict mapping. The task does not authorize new Cloudflare services or unlimited dynamic exports.

## 3. Documentation and exact entry points

[Language contract §§6.1–6.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), [current workspace](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/Cargo.toml), `crates/eliotr-canonical/src/lib.rs`, `crates/eliotr-test-vectors/src/lib.rs`, `crates/eliotr-kernel-wasm/src/lib.rs`.

```sh
git grep -n -F '### 6.3 Initial exports' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
git grep -n -F 'Additional exports require a contract revision or a scoped ADR.' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Ordered implementation checkpoints

### 88.1 — Close the operation contract first

Make the explicit scoped contract revision allowed by §6.3; retain all existing export semantics and legacy byte identities. The only new names selected by this assignment are `eliotr_evaluate_policy_v1` and `eliotr_transform_projection_v1`. Do not deploy them while pretending the old six-export contract already allowed them. Update the existing ABI fixtures and documentation together; no separate protocol registry.

| Export | Admitted operation family |
|---|---|
| eliotr_canonicalize_v1 | S78 canonical/identity byte operations |
| eliotr_validate_transition_v1 | S79 ownership, S85 W1/publication, S86 erasure closure, S87 fence/admissibility; separate strict operation schemas |
| eliotr_resolve_scope_v1 | S80 normalization/algebra/currentness |
| eliotr_qualify_bundle_v1 | S82 source/bundle qualification |
| eliotr_validate_evidence_resolution_v1 | S84 exact evidence invariants |
| eliotr_map_completion_disposition_v1 | S84/S85/S87 completion mappings without stronger outcomes |
| eliotr_evaluate_policy_v1 (added) | S81 policy/residency/budget admission; no Gateway I/O |
| eliotr_transform_projection_v1 (added) | S83 structural byte/map/item transformation; no managed indexing/inference |

The fixed mapping reuses the language contract's protocol/operation/version/schema/input digest/observed time/policy-reference envelope. Each operation has one strict payload/result schema. Unknown operation/schema/version is rejected; code cannot load arbitrary functions by name. Generated memory/glue exports are implementation details, not extra domain operations.

### 88.2 — Implement the bounded transport

Use the selected wasm-bindgen byte-array shell (`&[u8]` to `Vec<u8>`) with matching pinned crate/CLI and glue initialized from the imported precompiled Module in the existing TS Worker. Do not migrate the Worker to workers-rs or fetch latest tooling at runtime. Validate wire byte length before allocation/marshalling, then bounded schema/version/digest at the decoded boundary and output bounds/digest before acceptance. Domain callers pass bytes, not Request/D1/R2 objects, callbacks, or mutable JS graphs. Compiler-generated pointer handling stays inside glue.

### 88.3 — Prove an actual call before more families

Start with one existing canonical identity operation. A core Workers test supplies runtime bytes and invokes the compiled module, checking the result against independent fixture bytes and native Rust. Add malformed UTF-8, wrong operation/version/digest, size max/max+1, truncated result, trap and repeated-call memory cases. Retain CI self-tests, but do not count them as this integration test.

### 88.4 — Shadow without double effects

Evaluate TS and Rust against the same verified observations. Only one authoritative path may perform network/model/DB effects. A mismatch/trap blocks the affected authority operation, records a safe code and invalidates unsafe instance state; it does not trigger a permissive TS fallback. Add the next ready family through the same strict transport. No global private-byte cache, RPC service, or independent kernel clock/policy lookup.

Run `pnpm rust:check-contracts`, `pnpm rust:wasm`, applicable existing Rust gates, and the new focused bridge regression from `apps/eliotr-core` using its real Workers Vitest configuration. Measure the same input family under TS and Wasm; S89 owns production promotion/removal.

## 5. Acceptance criteria

- [ ] The contract change and operation fixture explicitly cover all required pure families; the old six exports remain compatible and unknown mappings fail.
- [ ] Actual workerd invokes compiled Wasm on runtime input, matching TS/native results and typed errors. A test that only calls an embedded-vector export cannot pass this requirement.
- [ ] Invalid sizes/schema/digests/traps neither leak private input nor corrupt a following operation; memory is bounded and temporary allocations are released.
- [ ] Shadow causes one set of external effects, never two. Mismatch cannot publish accepted output or invoke a hidden alternative authority path.
- [ ] Record each checkpoint's implementation SHA, commands/results, compressed Wasm+glue size, startup/heap and per-family CPU measurements. No runtime-promotion or live qualification is claimed before its own test.
