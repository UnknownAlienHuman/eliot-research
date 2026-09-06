# Launch 09 — Deterministic Rust authority, family by family (refreshed plan)

Read [execution-contract.md](execution-contract.md) first. Authority: ELIOT_RESEARCH,
LANGUAGE_RUNTIME_CONTRACT v1.0, accepted ADRs. This is a planning document only. It
claims no implementation beyond what current main already contains, and it changes no
product code, toolchain, manifest, lockfile, migration, or CI configuration.

Related packets: [ER-40](../../agent-work/ER-40-rust-canonical-identity-and-serialization.md),
[ER-00](../../agent-work/ER-00-workspace-and-verification-gates.md),
[ER-01](../../agent-work/ER-01-versioned-contracts-and-schemas.md),
[ER-02](../../agent-work/ER-02-core-deterministic-domain-state-machines.md),
[ER-03](../../agent-work/ER-03-policy-disclosure-and-injection-boundary.md).
Status sources: [implementation-status.json](../implementation-status.json),
[gap-register.md](../gap-register.md).

## 1. Historical closure: what #97 was, what main already contains

The obsolete draft `09-rust.md` on `agent/launch-09-rust-20260905` (98 lines, titled
"Launch 09 / #97 — Complete deterministic Rust authority, family by family") is a
superseded planning draft. It must be **closed, not merged**. Its old two-tree diff
touches 47 files and must NOT be applied to current main.

Patch-id verification (`git patch-id --stable`) confirms all five old #97
implementation commits are already present in current main through #99 / #100:

| Old #97 commit | Current main commit | Stable patch-id |
|---|---|---|
| K1 `6ac2287` | `57ae0ec` "Launch 09 K1: ER-44 initial owner-token parity" | `a905b151553d51af009d61c8af1150ee3ddbde48` |
| K2a `ffa1799` | `7ead68a` "Launch 09 K2a: ER-40 scope-snapshot-identity.v1 parity" | `a252945ee0b9acc54526a6ed100f90399e328471` |
| FIX1 `56089de` | `e78cecb` | `4cc5d5f9cecb7c1c0cca141be9fdce7d9d1e5f06` |
| FIX2 `662271c` | `ac1ebfc` | `4e316147f23bc68178a5c02e7000f449edd5d8bd` |
| FIX3 `2041363` | `41338ad` | `f2320fbab10e57d711f3a89e387a0c8ffbe92458` |

Integration path: Wave 1 integration `ea9b88e` (PR #99) carried the K1 content into
main; PR #100 merge `7174f47` carried K2a plus FIX1–FIX3, the line-budget ownership
commit `d1c53ad`, and CI-FIX1–4 (`dbcce3c`, `5b5187b`, `2abe29f`, `8431997`).

The only unique artifact worth preserving from the old branch is its planning intent
(from commit `01f88eecfeae9b61056197d1ee89cbdc9f411863`). This file is that
preservation, refreshed against current main. No code or stale metadata was copied
from #97.

The whole Rust theme is **NOT complete**. K1 and K2a are two narrow shadow-parity
slices. Everything in sections 3–6 below remains open work. This doc-only branch
preserves the plan without reverse changes, force-push, reset, or rebase of main.

## 2. Verified-complete versus open

### 2.1 Complete (IMPLEMENTED_NOT_LIVE only, shadow parity, no promotion)

Two slices only. Both execute the exact committed vector bytes through the
independent TypeScript reference, native Rust, and compiled Rust/Wasm, with no
production call site consuming Rust output.

- [x] **K1 — owner-token parity** (`57ae0ec`, via #99 `ea9b88e`).
  ER-44 initial namespace-owner token parity in TypeScript, native Rust, and Wasm.
  Current paths: `crates/eliotr-canonical/**`, `crates/eliotr-test-vectors/**`
  (including `crates/eliotr-test-vectors/fixtures/owner-token.v1.txt`),
  `crates/eliotr-kernel-wasm/**`. Current gates: `pnpm rust:check` (which runs
  `rust:boundaries`, `rust:vectors`, `rust:fmt`, `rust:clippy`, `rust:test`,
  `rust:deny`, `rust:wasm`, `rust:coverage`) plus `pnpm check:affected` and
  `pnpm check:implementation-status`. State: IMPLEMENTED_NOT_LIVE. No owner
  switch, no stored-hash change, no parser-scope expansion.
- [x] **K2a — scope-snapshot-identity.v1 parity**
  (`7ead68a` + `e78cecb` + `ac1ebfc` + `41338ad` + `d1c53ad` + CI-FIX1–4, via
  #100 `7174f47`). Exact `scopeSnapshotIdentityPayload`,
  `scopeSnapshotDigestPayload`, and `expectedSnapshotIdentity` parity, leaving
  TypeScript authority intact. 67 committed vectors (70 lines, 88,489 bytes) in
  `crates/eliotr-test-vectors/fixtures/scope-snapshot-identity.v1.txt`
  (SHA-256 `840c4e05800af26582cc1bb3e92750d0a18a94dee296f13ca90b85c2edfbfdca`
  at `7174f47`; the `f520fffa…` value still quoted in ER-40 § scope-snapshot
  slice is stale and is not repeated as fixture identity here),
  covering derivation and verification, ordering and escaped-equivalent
  metamorphism, replay versus conflicting replay, digest/ID mismatch on valid-hex
  tamper, foreign owner/scope/generation/policy inputs, zero/max/max+1
  boundaries, malformed UTF-8, escapes, non-canonical numbers, surrogates,
  depth/member/payload ceilings, admitted timestamp shapes, and fail-closed
  derive rejection of caller-supplied `snapshot_id`/`digest` members. State:
  IMPLEMENTED_NOT_LIVE. Scope normalization, algebra, resolution, persistence,
  and publication identity remain TypeScript authority.

### 2.2 Open (everything else)

- [ ] **K2b — remaining M2 identity/serialization parity, one family per claim.**
  The following ER-40 slices are described in the packet but are NOT claimed
  complete by this plan; each needs its own corpus, parity run, and review:
  - [ ] `canonical-body.v1` foundation (bounded canonical JSON for null,
    booleans, strings, safe integers, arrays, objects; ECMAScript UTF-16
    code-unit key order with astral/BMP divergent vector; SHA-256 over exact
    body bytes; `g1_<sha256>` generation tokens). Safe integers only; floats
    and arbitrary product objects remain outside the slice.
  - [ ] `stable-id.v1` generic primitive (36-case corpus; compatibility with the
    admitted TypeScript subset; ceilings below). Not a cutover for any product
    family.
  - [ ] `source.owner-cutover.v1` canonical vectors (9 committed cases; YAML
    fixture digest `b659806e37a4bc60ea67b4416e35212f559213bbadb28618b7edcee686b9277e`).
    Byte/digest parity only; cutover semantics stay in TypeScript.
  - [ ] `object-residency-key.v1` (22 committed vectors; 768 pre-decode bytes per
    identifier, 13,925 serialized-byte ceiling). Serialization only; placement,
    encryption, retention, and erasure stay in TypeScript.
  - [ ] `ingest-identities.v1` (31 committed cases, one complete dependency
    chain). Identity parity for already-admitted strings only.
  - [ ] `projection-identities.v1` (36 committed cases, one complete dependency
    chain). Identity parity for already-admitted strings only.
  - [ ] Any further family named under K2 (source, cutover, residency,
    operation, admission, projection receipt, scope, evidence, manifest,
    publication, federation identities) using current actual TypeScript behavior
    and accepted schemas.
- [ ] **K3 — M3 deterministic domain state machines** (ER-02 total transitions
  from injected data only; ER-03 fixed-order policy evaluation, reference
  firewall, context compiler, output gate, budget governor). No platform effects
  in Rust.
- [ ] **K4 — M4 evidence/coverage/domain dispositions.** Keeps the exact
  nine-value research disposition; no tenth disposition without normative
  review (ER-01 negative boundary).
- [ ] **K5 — M5 bounded ABI and differential shadow** (ER-40 Wasm adapter plus
  ER-24 TypeScript bridge; content-free mismatch receipts; TS authority
  retained during shadow).
- [ ] **K6 — M6 per-family promotion.** One family at a time, with version,
  generation, rollback, and owning-family review. No family is promoted by this
  plan.
- [ ] **K7 — M7 removal of superseded TypeScript authority.** Only after K6
  prerequisites are recorded; fixtures retained as verification references, not
  a second production owner.
- [ ] **K8 — promoted product/regression and probe integration** against
  promoted code in the real Worker plus shared browser loops.

Registry truth: the P1 Rust row of [gap-register.md](../gap-register.md) states
M1 plus narrow M2 shadow exist while M2 parity and M3–M7 remain open, and
[implementation-status.json](../implementation-status.json) contains no Rust
promotion entry. Both statements agree with this plan.

## 3. Dependency-ordered remaining work

Work proceeds family by family, in this order. A later stage never starts for a
family whose earlier stage for that same family is still open.

1. **K2b — per-family identity/serialization parity.** Port one narrowly named,
   product-neutral or already-admitted vector family at a time. Reuse the
   `canonical-body.v1` frame and existing helpers; do not introduce a second
   parser or operation vocabulary per family. Register each family's
   schema, generation, and resource ceiling. Add property and metamorphic tests
   beside the committed examples. Unknown keys are a family-schema decision,
   not blanket generic-JSON rejection. PASS: canonical bytes, hash, ID, and
   typed error agree across TypeScript, native Rust, and compiled Wasm,
   including conflicting replay and max+1; known TypeScript bugs are resolved
   and versioned independently, never mechanically preserved as truth; no
   retrospective change to an existing immutable identity without an explicit
   compatibility and migration review.
2. **K3 — deterministic domain state machines.** Claim exactly one subfamily:
   K3.owner lifecycle/cutover, K3.scope algebra/snapshot, K3.policy
   usage/disclosure/taint, K3.residency retention/keys, or K3.qualification
   assurance/precision, with owning ER-02/ER-03 review. Move pure decisions
   only; observed D1/R2 facts arrive as versioned inputs. PASS: result,
   transition, receipt/error, and limitation semantics match the accepted
   reference byte-for-byte; rejected input cannot request an effect or
   strengthen assurance.
3. **K3 policy/injection boundary (ER-03).** Fixed evaluation order across
   storage, purge/read, task/source, client disclosure, inference disclosure,
   retention/license, and output minimization; taint/effect ceilings and
   selection-integrity lineage hold. Negative: a tool instruction embedded in
   admitted source text cannot alter tools, scope, policy, or output effect.
4. **K4 — evidence/coverage dispositions.** Claim exactly one: K4.evidence exact
   resolution invariants, K4.coverage denominator/absence, K4.projection and
   admission, K4.erasure exact closure, K4.federation fence/candidate mapping,
   or K4.research freeze/audit/completion. Feed final integrated TypeScript
   behavior, not outdated planning notes. PASS: results, errors, receipts, and
   dispositions agree exactly; the nine-value enum is preserved with no tenth
   value; forbidden counts stay zero.
5. **K5 — native plus Wasm differential shadow (ER-40 plus ER-24).** K5a: Wasm
   adapter and TypeScript bridge use the versioned canonical UTF-8 operation
   envelope with explicit schema/version/digests/context, bounded allocation,
   and typed errors; only the admitted named exports exist and additional
   exports need a contract revision or scoped ADR. K5b: compare the same
   deterministic inputs across real TypeScript, native Rust, and Wasm; persist
   content-free mismatch receipts; retain TypeScript authority; prevent
   duplicate provider/model effects. PASS: byte/result/error/transition/
   receipt/disposition equality, divergence blocks mutation and promotion,
   rollback exists, and round trips and cost do not increase. Record compressed
   size, startup, Wasm memory, and p50/p95 CPU baselines. A CI-only embedded
   self-test is not a product ABI.
6. **K6 — controlled per-family Rust promotion.** Requires native, Wasm,
   differential, and Worker tests, coverage, explicit version/generation, and
   rollback before the active owner changes. The Rust result becomes sole
   authority; TypeScript may reject malformed or oversized transport earlier
   but may not independently override or strengthen the promoted result. Both
   old and new deployment configurations are tested, including stale and
   incompatible ABIs. PASS: one declared owner per promoted family, no silent
   fallback to a more permissive decision, no increased external round trips.
7. **K7 — TypeScript removal only after receipts.** Remove only the replaced
   production decision path after every language-contract removal prerequisite
   is recorded. PASS: all prerequisites and tests still pass with the
   superseded TypeScript production path removed; the registry names Rust;
   bundle/startup budgets hold; rollback preserves schemas, owner, and purge
   state.
8. **Gates throughout.** Hardened fuzz, property, Miri, mutation, and semver
   gates run before any promotion; unavailable tooling is a missing gate, not a
   pass. The `fuzz/` directory (with `fuzz_targets/` and `corpus/`) exists for
   this purpose; no new fuzz gate is invented by this plan.

## 4. Ownership and delegation

| Area | Owner | Scope |
|---|---|---|
| Vectors, Wasm shell, fuzz contour, vector/Wasm verification scripts | ER-40 | `crates/eliotr-canonical/**`, `crates/eliotr-test-vectors/**`, `crates/eliotr-kernel-wasm/**`, `fuzz/**`, `scripts/check-er40-line-budget.mjs`, `scripts/check-rust-vectors.mjs`, `scripts/check-rust-vectors-bootstrap.mjs`, `scripts/test-rust-vectors-install.mjs`, `scripts/check-rust-wasm.mjs` |
| Workspace, toolchain, lockfiles, CI composition, integration gates | ER-00 | `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `deny.toml`, `.config/nextest.toml`, `package.json`, CI workflows |
| Schemas and contract fixtures | ER-01 | `packages/contracts/**`, `docs/contracts/**`; strict versioned Zod; unknown load-bearing fields fail |
| Deterministic domain semantics | ER-02 | `packages/domain/src/*`; total transitions from injected data only |
| Policy, disclosure, injection boundary | ER-03 | `packages/policy/**` |
| Worker integration, composition root, routes, runtime | ER-24 | application services and composition; owns the K5b bridge side and K6 composition |
| Family behavior (owner tokens, scope, residency, evidence, projection, federation, research) | Respective family ER owners | TypeScript behavior is the reference until a promotion packet moves one named family |

Rules: one family per claim; one agent, one worktree, one branch, one task.
Shared files (composition root, barrels, manifests, lockfiles, CI, bindings,
schema registry, migration numbers) require the designated integrator; an
unclaimed shared edit is not permission. Permanent duplicate TypeScript/Rust
authority is prohibited; differential shadow is temporary and must converge to
one owner. New pure crates follow the language contract; pure Rust receives
explicit bytes and state and performs no network, filesystem, clock,
randomness, environment, process, or Cloudflare binding access.

## 5. Local acceptance commands

Use exactly these commands from the repository root. Do not invent alternatives.
`pnpm check:affected` runs the full chain including `rust:check`; it is not an
incremental shortcut.

```text
pnpm rust:boundaries
pnpm rust:vectors
pnpm rust:fmt
pnpm rust:clippy
pnpm rust:test
pnpm rust:deny
pnpm rust:wasm
pnpm rust:coverage
pnpm rust:check
pnpm check:affected
pnpm check:implementation-status
```

Command definitions (pinned, from `package.json`):

- `rust:boundaries`: `node scripts/check-rust-boundaries.mjs`
- `rust:vectors`: `node scripts/check-rust-vectors.mjs`
- `rust:fmt`: `cargo fmt --all --check`
- `rust:clippy`: `cargo clippy --workspace --all-targets --all-features --locked -- -D warnings`
- `rust:test`: `cargo nextest run --workspace --all-features --locked && cargo test --doc --workspace --all-features --locked`
- `rust:deny`: `cargo deny check`
- `rust:wasm`: `cargo build --workspace --target wasm32-unknown-unknown --release --locked && node scripts/check-rust-wasm.mjs --mode default && cargo build --package eliotr-kernel-wasm --target wasm32-unknown-unknown --release --features m1-self-test-export --locked && node scripts/check-rust-wasm.mjs --mode self-test`
- `rust:coverage`: `cargo +nightly-2026-08-31 llvm-cov --package eliotr-canonical --package eliotr-test-vectors --all-features --locked --branch --fail-under-lines 90 --text`
- `rust:check`: boundaries, vectors, fmt, clippy, test, deny, wasm, coverage in that order

Toolchain facts: Cargo workspace members are `crates/eliotr-canonical`,
`crates/eliotr-test-vectors`, and `crates/eliotr-kernel-wasm`, with `fuzz`
excluded. `rust-toolchain.toml` pins `1.98.0` with the minimal profile plus
`clippy`, `llvm-tools-preview`, `rustfmt`, and the `wasm32-unknown-unknown`
target. Extra scripts present and owned by ER-40 include
`scripts/check-er40-line-budget.mjs` and
`scripts/check-rust-vectors-bootstrap.mjs`. Vector fixtures live in
`crates/eliotr-test-vectors/fixtures/`: `canonical-body.v1.txt`,
`canonical-utf8.v1.txt`, `ingest-identities.v1.txt`,
`owner-cutover-canonical.v1.txt`, `owner-token.v1.txt`,
`projection-identities.v1.txt`, `residency-key.v1.txt`,
`scope-snapshot-identity.v1.txt`, `stable-id.v1.txt`.

Acceptance constraints for every family claim:

- Negative, replay, parity, and resource-bound coverage: duplicate member
  names, unknown envelope fields, invalid UTF-8, non-canonical numeric forms,
  unsupported numeric ranges, invalid Unicode scalar sequences, malformed
  syntax, excessive nesting, member-count and payload ceilings, digest and ID
  mismatch, conflicting replay, and zero/max/max+1 boundaries. Both
  independent parsers and the compiled Wasm verifier reject the exact negative
  case without logging or returning source content.
- Invalid UTF-8, Unicode edge cases (surrogates, escapes, BMP/astral ordering),
  and canonical-JSON limits (lexicographic key order, no locale or platform
  dependence) are exercised through all three runtimes with identical typed
  errors.
- Stable-ID compatibility invariants: the admitted `prefix + "-" + sha256
  ([prefix, ...parts].join(NUL)).slice(0, 48)` convention with lowercase
  48-hex output; 64-byte ASCII prefix ceiling, 32-part ceiling, 4 KiB per-part
  ceiling, 64 KiB complete-preimage ceiling; empty-part boundary preservation;
  embedded-NUL rejection in the direct parts API; strict complete-ID
  validation on the final hyphen separator while allowing hyphenated prefixes.
- Canonical-body limit: safe integers only. Floats, exponent syntax, arbitrary
  product objects, and widened parsing are out of scope until a reviewed
  versioned-semantics packet admits them.
- No stored identity or hash migration without an explicit compatibility plan:
  a parity checkpoint never changes an existing immutable identity, adds a new
  stored hash, or expands parser scope to hide a mismatch. Later TypeScript
  semantics changes re-open the affected family's parity gate.

## 6. Promotion gates and truthful live status

- No family becomes canonical merely because K1/K2a shadow vectors pass. Each
  family requires its own K2 corpus, K3/K4 semantics parity where applicable,
  K5 differential shadow with mismatch blocking, and a separately reviewed K6
  packet naming the family, observation window, mismatch policy, rollback
  switch, and superseded owner.
- No live Cloudflare qualification is claimed by this plan. All live receipts
  (Cloudflare, Google, provider, recovery, corpus, workload) remain
  NOT_EXECUTED; completed work is IMPLEMENTED_NOT_LIVE at most.
- Local shadow and native test results are not deployed observations. A
  passing `rust:check`, Wasm self-test, or differential run does not imply a
  staging or production receipt.
- TypeScript remains the active product authority for every family except one
  explicitly promoted by a K6 packet and recorded in
  [implementation-status.json](../implementation-status.json). Until then, no
  production mutation consumes Rust output.

## 7. Closure logistics for #97

1. Close the obsolete #97 draft PR without merging. Its 47-file two-tree diff
   is superseded by the patch-id-verified contents already in main.
2. Keep this refreshed plan (`09-rust.md`) as the single forward reference for
   the Rust theme, alongside [README.md](README.md) line 19 which already
   references it.
3. Future family work claims checkpoints from section 3 above on the reserved
   branch discipline, one family per claim, integrating current main without
   force, reset, or rebase, and updating the theme checklist, status registry,
   and gap register in the same change that completes each checkpoint.
4. This branch is doc-only: it creates this plan file and edits nothing else.
