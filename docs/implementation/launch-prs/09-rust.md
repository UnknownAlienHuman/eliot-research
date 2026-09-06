# Launch 09 / #97 — Complete deterministic Rust authority, family by family

Follow execution-contract.md. Code baseline f94bd7a. Read LANGUAGE_RUNTIME_CONTRACT v1.0 §§3–10,
ELIOT_RESEARCH §§2–7/13/15 for the selected family and §19 negatives, ER-40, current toolchain/Cargo
policy and shared vectors. ER-40 owns existing canonical/test-vectors/Wasm/fuzz paths; ER-00 owns
workspace/toolchain/CI, ER-01 schemas, owning domain packets define semantics, ER-24 Worker integration.

## Existing code and exact target

Reuse `crates/eliotr-canonical/src/{canonical_json,sha256,generation,stable_id,residency_key}.rs`,
`crates/eliotr-test-vectors/`, `crates/eliotr-kernel-wasm/`, `scripts/check-rust-{vectors,wasm}.mjs`,
current shared fixtures and the actual TS reference functions. M1 and narrow M2 shadow primitives exist;
they are not complete product authority. Canonical-body currently admits safe integers, not arbitrary
floats/exponent syntax. Unsupported family inputs require reviewed versioned semantics, not widened
parsing or changed stored identities to hide mismatches.

New pure crates follow language §5.2, not one Rust file for each TS file. Pure core has no network,
filesystem/environment/clock/randomness/process/Cloudflare handles. Time/state/policy/entropy are explicit
inputs. TS remains platform I/O/crypto/transport; SQL remains migrations/constraints. Checkpoints K3/K4
must be claimed by the listed subfamily, never as one giant rewrite.

## Ordered local checkpoints

### K1 — Uncovered canonical/identity family parity (start with ER-44 owner token)

Files: existing canonical and test-vector crates; actual ER-44 initializer/reference stays read-only unless
an independently justified bug fix is approved. Inventory current family coverage; add initial namespace-
owner token fixtures from its normative preimage and actual implementation, not two copied goldens.
Run identical valid/invalid inputs in TypeScript, native Rust and compiled Wasm.
Tests: key order, Unicode/UTF-16 order, prototype-shaped allowed keys, duplicate/unknown schema keys,
wrong generation, zero/max/max+1 and invalid UTF-8. PASS: byte output, SHA-256, stable ID and typed error
agree for every admitted input; malformed input is rejected before unbounded allocation. No active
owner switch, new stored hashes or parser scope expansion from this checkpoint.

### K2 — Remaining M2 identity/serialization families (after K1)

One family per claim: source/cutover/residency; operation/admission/projection receipt; scope/evidence/
manifest/publication/federation identities, using current actual TS behavior and accepted schemas.
Reuse helpers; register each family's schema/generation/resource ceiling and parity driver. Add property
and metamorphic tests in addition to committed examples. Unknown keys are a family-schema decision,
not blanket rejection by generic JSON parsing.
PASS: canonical bytes/hash/ID/error parity across all three runtimes, including conflicting replay and
max+1. Known TS bugs must be independently resolved/versioned rather than mechanically preserved as truth;
no retrospective change to existing immutable identity without explicit compatibility/migration review.
Remaining families stay visibly unchecked until their own corpus passes.

### K3 — M3 state, scope and policy (after relevant K2 families)

Claim ONE: K3.owner lifecycle/cutover; K3.scope algebra/snapshot; K3.policy usage/disclosure/taint;
K3.residency retention/keys; K3.qualification assurance/precision. Target crates are the exact language
§5.2 state-machines/scope/policy/residency/qualification families, with owning ER-02/03/29/30 review.
Move only pure decisions; pass observed D1/R2 facts as versioned inputs. No platform effects in Rust.
Tests per subfamily: full legal/illegal transitions, stale generation/CAS, deny/purge/expiry, cross-domain
reuse, partial/unknown inputs and 0/limit+1. PASS: result, transition, receipt/error and limitation semantics
match accepted reference byte-for-byte; rejected input cannot request an effect or strengthen assurance.

### K4 — M4 evidence/coverage/domain dispositions (after relevant K3)

Claim ONE: K4.evidence exact resolution invariants; K4.coverage denominator/absence; K4.projection/admission;
K4.erasure exact closure; K4.federation fence/candidate mapping; K4.research freeze/audit/completion.
Use corresponding evidence/coverage/projection-core/erasure-core/federation-core/research-core crates.
Feed final integrated TS behavior from #90–#96, not outdated planning tips. Keep the nine-value enum.
Tests: wrong revision/map/span/hash, sampled/unknown absence, subset purge/held location, stronger peer
completion, post-freeze additions, forged verifier and grade confusion. PASS: exact results/errors/
receipts/dispositions agree; forbidden §19 counts 0, no implicit I/O or tenth disposition. A later TS
semantics change reopens that family's parity gate rather than silently diverging.

### K5 — M5 bounded ABI and differential shadow (after each family's K2–K4)

K5a: ER-40 Wasm adapter and ER-24 TS bridge use language §6 canonical UTF-8 operation envelope, explicit
schema/version/digests/context, bounded allocation and typed errors. Only the six initial named exports
are admitted; additional exports need a contract revision/scoped ADR. No mutable JS graph or runtime
handle crosses the boundary. Test invalid UTF-8/length, overflow, allocation failure, unsupported version,
malformed result and unbound input/output hashes at the actual Wasm boundary.
K5b: compare the SAME deterministic inputs in real TS/native/Wasm; persist content-free mismatch receipts,
retain TS authority during shadow and prevent duplicate provider/model effects. PASS: exact byte/result/
error/transition/receipt/disposition equality, divergence blocks mutation/promotion, rollback exists and
round trips/cost do not increase. Record compressed size, startup, Wasm memory and p50/p95 CPU baseline.
Do not label shadow as M6 or a CI-only embedded self-test as a product ABI.

### K6 — M6 promote one family (after its K5 and accepted runtime/budgets)

ER-24 composition + owning family registry. Require native/Wasm/differential/Workers tests, coverage,
explicit version/generation and rollback before changing the active owner. Rust result is sole authority;
TS may reject malformed oversized transport earlier but may not independently override/strengthen it.
Test both old/new deployment configurations and stale/incompatible ABI; count effects and compare actual
user-loop outcomes on local Worker/D1/R2. PASS: one declared owner per promoted family, no silent fallback
to a more permissive decision and no increased external round trips. Hold production until later real
platform qualification; local source promotion is not a LIVE_QUALIFIED receipt.

### K7 — M7 remove superseded TS authority (after K6)

Remove only the replaced production decision path after every language §10.3 prerequisite is recorded.
Keep historical/differential fixtures as explicit verification references, not a callable permanent
second production owner. Test no TS decision can be selected through error/fallback branches; preserve
compatibility and rollback via reviewed generation/build, not two authorities racing each other.
PASS: all prerequisites and tests remain passing with TS production code removed, exact current registry
names Rust, bundle/startup budgets hold and rollback preserves schemas/owner/purge state.

### K8 — Complete promoted product/regression and probe (after all critical K6/K7 families)

Run source -> scope -> evidence/research -> publication/federation and erasure/restore against promoted
code in the actual Worker, plus shared L1 browser loops. Re-run state/property/fuzz/mutation negatives and
per-family rollback. Register rust-runtime suite in O1 conformance runner with wrong-build/ABI/receipt
failures. PASS: every production-critical family has one promoted owner and retained parity/runtime/
performance/rollback evidence; remaining noncritical TS I/O is not rewritten to improve a Rust percentage.

## Commands and numerical acceptance

Use pinned `pnpm rust:check` (fmt, Clippy -D warnings, nextest/doctests, deny, Wasm, coverage) and the full
shared repository/strict Worker/local smoke/CI commands. Run applicable pinned scheduled Miri, fuzz,
property, mutation and public-crate semver checks before promotion; unavailable tooling is a missing gate,
not a pass. Default deterministic-core line coverage >=90%; lower requires a documented approved exception.
Compressed Worker <=4 MiB; PWA <=600 KiB gzip; startup <=400 ms; bounded Wasm/first-party memory budget.
Record p50/p95 improvement OR documented correctness benefit; no additional platform calls. Pure crates
forbid unsafe code; narrowly necessary ABI unsafe code stays isolated/reviewed, never domain logic.

## Cloudflare gate after #96 O7

Verify actual compiled/deployed Wasm/build/ABI/family generations and run current parity probes, user loops,
budget/startup/memory/CPU measurements and per-family rollback. Retain real receipts; local shadow/native
tests are not deployed observations. Follow cloudflare-handoff.md #97. No partial deployment, permanent
dual authority, forced fixture agreement or unreviewed canonical contract change is permitted.
