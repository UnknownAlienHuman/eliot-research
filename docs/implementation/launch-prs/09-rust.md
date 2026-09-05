# Launch 09 — Rust deterministic authority M2–M7

Status: eligible local family task, unclaimed. Incorporate current main and read agent-start.md,
canonical-alignment.md, LANGUAGE_RUNTIME_CONTRACT v1.0 (2026-09-01), Cargo/toolchain/coverage gates,
shared vectors and the exact owning packet before coding. ER-00/01/02/03 and capability owners retain
pure-family ownership; ER-24 owns Wasm/control-plane composition. No production authority is promoted
by this plan. TypeScript owns platform I/O; SQL owns schema; pure Rust has no runtime/provider access.

## Existing scope and first bounded task

M1 and narrow M2 shadow primitives already exist. Reuse eliotr-canonical canonical_json, sha256,
generation, stable_id and residency_key modules, and the existing canonical-body/owner-cutover/
residency/stable-ID/ingest/projection test-vector drivers. Do not rewrite them. The canonical-body
family supports safe integers, not arbitrary floats/exponent syntax. Helpers are not full product parity.

Audit family coverage, then add missing ER-44 initial namespace-owner token parity from the actual
initializer/reference function and normative preimage. Test identical valid, invalid, Unicode/shape
and max+1 inputs through TypeScript, native Rust and compiled Wasm. A mismatch blocks acceptance;
do not change stored identities or relax validators to obtain agreement. One family/exact-path claim.

## Sequential checkpoints — normative §10 phase names

- [ ] K1 / M2a. Complete uncovered canonical serialization families using their actual schema/numeric
  domain. Preserve exact UTF-16 key ordering, Unicode, duplicate/unknown-field and byte/resource rules.
  Unknown fields are enforced by the family schema, not blanket rejection by generic JSON parsing.
- [ ] K2 / M2b. Finish per-family SHA-256/stable-ID/generation parity, including current owner, receipt,
  operation and handle identities. Use current TS behavior and explicit limits, not two copied goldens.
- [ ] K3 / M3. Move lifecycle/owner, scope, policy/disclosure/residency/retention and qualification
  decisions one family per task. Time and observed state are explicit inputs, never implicit runtime I/O.
- [ ] K4 / M4. Move evidence/coverage/citation, admission/projection, erasure, federation and research
  dispositions against the latest integrated TS semantics. Do not freeze obsolete planning-branch code.
- [ ] K5a / M5. Compile the versioned canonical-byte Wasm ABI with bounded allocation, exact operation/
  schema/digest binding and typed failures. Test UTF-8, forged lengths, overflow, allocation failure,
  unsupported versions and malformed output at the actual Wasm boundary. Runtime handles never cross it.
- [ ] K5b / M5. Run differential shadow comparisons and retain content-free mismatches. No duplicate
  external effects or model billing. Divergence blocks authority promotion. Measure bundle/startup/
  memory/p50/p95 CPU and establish per-family rollback before switching authority.
- [ ] K6 / M6. Promote one family only after byte/result/error/identity/disposition parity and required
  runtime/budget acceptance. Rust becomes the sole decision authority; TS may reject malformed transport
  earlier but must not strengthen/replace the result. Registry and rollback identify the active owner.
- [ ] K7 / M7. Remove the superseded TS authority only after the §10.3 removal prerequisites hold:
  native/Wasm/differential/Workers tests, bundle/startup budgets, explicit Rust owner and rollback.
  Keep historical fixtures or explicit verification references, not a permanent second production owner.
- [ ] K8. Complete native/Wasm/Workers user-loop, performance and rollback regressions with promoted
  code: source -> evidence/research/publication/federation. Identify every unexecuted live observation.

The old task labels incorrectly assigned shadow to M6 and combined promotion/removal in M7. The
canonical phases are M5 Wasm/shadow, M6 promotion, M7 removal; the canonical contract is unchanged.
K3/K4 remain umbrella lists, not single agent tasks. Split by coherent crate/state family under existing
600-line/file and 10k-line/crate budgets. Shared manifests/vector exports/ABI/CI/Worker edits belong to
the integrator. No one-for-one TS rewrite, new language, hidden I/O or permanent dual authority.

## Completion

Run pinned fmt, Clippy -D warnings, nextest/doctests, deny, coverage, default/self-test Wasm, shared
vectors and applicable fuzz/property/Miri/mutation checks. Require strict TS/Workers fixtures, full CI,
local Linux/Windows boot and performance acceptance after promotion. Keep draft until all production-
critical checkpoints pass. A compiling helper does not finish M2–M7.

Follow cloudflare-handoff.md. Local parity is not a real deployment/performance receipt. No partial
Cloudflare development, launch-hold bypass or first production release with superseded TS authority
still active. This task refresh launches no agent and makes no live-qualification claim.
