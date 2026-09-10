# Launch 09 — Rust deterministic authority M2–M7

Status: queued draft, unclaimed. M1 already exists and is not reimplemented. Work can proceed by stable
family alongside the other themes; final promotion uses the latest integrated family's TS vectors.
Owners ER-00/01/02/03 and the affected capability packets; ER-24 owns Wasm/control-plane composition.
Read `docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md`, current Cargo workspace, toolchain/coverage gates,
shared vectors, and the exact pure domain family being migrated. TypeScript permanently owns Cloudflare
I/O, transport, PWA and setup; SQL remains the D1 schema owner. No Rust network/filesystem/provider code.

## Small sequential checkpoints

- [ ] K1 / M2a. Implement bounded canonical JSON in a pure crate: exact map ordering, duplicate/unknown
  fields, Unicode, number and byte/resource limits. Match existing canonical bytes before adding IDs.
- [ ] K2 / M2b. Implement stable IDs, SHA-256 rules and generation-token validation, one identity family
  at a time. Run existing owner-cutover/residency/receipt/operation/handle vectors through TS/native/Wasm.
- [ ] K3 / M3. Move source lifecycle/owner, scope algebra, policy/disclosure/residency/retention and
  qualification decisions one family per checkpoint. Inputs include explicit time and observed state;
  no implicit clock, randomness, environment or runtime handles.
- [ ] K4 / M4. Move admission, projection ceilings, evidence/coverage/citation invariants, erasure,
  federation and research/claim dispositions one family at a time after their current TS behavior is
  integrated. Do not freeze or duplicate obsolete code from a queued theme branch.
- [ ] K5 / M5. Implement the versioned canonical-byte ABI with bounded allocation, typed errors and
  exact identity/output binding. Test invalid UTF-8, overflows, forged lengths, allocation failures,
  unknown versions and malformed results at the actual Wasm boundary.
- [ ] K6 / M6. Run shadow comparisons with content-free mismatch receipts. No duplicate external effects;
  divergence fails closed. Measure bundle/startup/memory/p50/p95 CPU and define per-family rollback.
- [ ] K7 / M7. Promote one family after parity/observation evidence, make Rust the sole authority for
  that decision, and remove superseded TS authority. Transport validation may reject earlier but never
  strengthen or replace a promoted Rust outcome. Update status registry with the actual owner.
- [ ] K8. Run complete native/Wasm/Workers user-loop regressions with promoted code; cover local
  source->evidence/research/publication/federation and rollback. Record any unexecuted live observation.

K3/K4 are umbrella lists, NOT single agent tasks: split each named state family into one crate-focused
change with its own tests and promotion record. One agent, one active worktree, one bounded task;
<10k LOC per crate and existing source-file budgets. No permanent dual authority or new language.

## Completion

Require pinned `cargo fmt`, Clippy -D warnings, nextest/doctests, deny, coverage, default/self-test Wasm,
shared differential vectors, fuzz/property/mutation cases and applicable deep-verification jobs. Require
full TypeScript/Workers CI, migration/local-boot tests and performance budgets after every promotion.
Keep draft until all production-critical K1–K8 families pass; do not claim M2–M7 complete because one
canonical helper compiles. Local parity and real platform qualification remain distinct; no partial
deployment and no first production release with superseded TS authority still active.
