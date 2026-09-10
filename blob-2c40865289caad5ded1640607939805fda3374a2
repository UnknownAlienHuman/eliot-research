# Launch 09 — Rust deterministic authority M2–M7

Status: eligible local task, unclaimed. Refresh current main and read `agent-start.md` here before
coding. M1 and narrow M2 shadow primitives already exist; neither is reimplemented. Work proceeds by
stable family alongside independent themes; final promotion consumes the latest integrated TS vectors.
Owners ER-00/01/02/03 and affected capability packets; ER-24 owns Wasm/control-plane composition.
Read `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`, current Cargo workspace, toolchain/coverage gates,
shared vectors and the exact pure domain family being migrated. TypeScript permanently owns Cloudflare
I/O, transport, PWA and setup; SQL owns D1 schema. Pure Rust has no network/filesystem/provider access.

## Existing M2 scope and first task

`crates/eliotr-canonical/src` already contains canonical_json, sha256, generation, stable_id and
residency_key modules. `crates/eliotr-test-vectors` already exercises canonical-body, owner-cutover,
residency, stable-ID, ingest and projection identity vectors. Do not duplicate these implementations.
The canonical-body family supports safe integers, not arbitrary floating-point/exponent JSON. Existing
shadow helpers are not complete product parity, a promoted kernel or full M2–M7 acceptance.

First audit the current families and add the missing ER-44 initial namespace-owner identity parity.
Use the normative preimage and actual initializer/reference function. Test identical valid, invalid and
bounded max+1 inputs through TypeScript, native Rust and compiled Wasm. A mismatch must fail, not cause
stored identity changes or a relaxed validator. Claim one family and exact owned paths before coding.

## Small sequential checkpoints

- [ ] K1 / M2a. Audit/reuse bounded canonical JSON. Complete uncovered product families only after
  identifying their actual schema/numeric domain. Preserve exact UTF-16 key ordering, Unicode, duplicate/
  unknown-field rules and byte/resource limits. Unknown fields are a schema rule, not blanket JSON rejection.
- [ ] K2 / M2b. Reuse existing SHA-256/stable-ID/generation primitives; finish current per-family parity,
  including ER-44 initialization and any uncovered owner/receipt/operation/handle identity. Consume real
  current TS behavior and explicit limits, not two copied golden implementations.
- [ ] K3 / M3. Move source lifecycle/owner, scope algebra, policy/disclosure/residency/retention and
  qualification decisions one family per checkpoint. Inputs contain explicit time and observed state;
  no implicit clock, randomness, environment or runtime handles.
- [ ] K4 / M4. Move admission, projection ceilings, evidence/coverage/citation invariants, erasure,
  federation and research/claim dispositions one family at a time after current TS behavior is integrated.
  Do not freeze or duplicate obsolete code from a queued theme branch.
- [ ] K5 / M5. Implement versioned canonical-byte ABI with bounded allocation, typed errors and exact
  identity/output binding. Test malformed UTF-8, overflow, forged lengths, allocation failures, unknown
  versions and malformed results at the actual Wasm boundary.
- [ ] K6 / M6. Run shadow comparisons with content-free mismatch receipts. No duplicate external effects;
  divergence fails closed. Measure bundle/startup/memory/p50/p95 CPU and define per-family rollback.
- [ ] K7 / M7. Promote one family after parity/observation acceptance, make Rust the sole authority and
  remove superseded TS authority. Transport validation may reject earlier but not strengthen/replace the
  promoted Rust outcome. Update implementation state with the actual owner.
- [ ] K8. Run complete native/Wasm/Workers user-loop and rollback regressions with promoted code:
  source -> evidence/research/publication/federation. Record any unexecuted live observation.

K3/K4 are umbrella lists, not single agent tasks. Split each named family into a bounded crate-focused
change with its own tests/promotion record. One task/worktree/branch per agent, existing source budgets
and less than 10k source lines per crate. Shared manifests, vector-driver/ABI exports and Worker composition
are serialized through their owning integrator; no new language or permanent dual authority.

## Completion

Require pinned fmt, Clippy -D warnings, nextest/doctests, deny, coverage, default/self-test Wasm, shared
vectors, fuzz/property/mutation cases and applicable deep-verification jobs. Require full TS/Workers CI,
migration/local-boot tests and performance budgets after promotion. Keep draft until all production-
critical K1–K8 families pass; a compiling canonical helper does not finish M2–M7. Local parity and real
platform qualification remain separate. Follow `cloudflare-handoff.md`; no partial deployment or first
production release with superseded TS authority still active.
