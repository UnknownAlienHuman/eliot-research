# Rust kernel ABI versioning

The pure-kernel TypeScript↔Rust/Wasm ABI is versioned canonical UTF-8 bytes in, canonical
bytes or typed errors out (AGENTS.md). This document defines that version: what it covers,
the compatibility rules, and how to bump it.

## 1. What the version covers

Two independent counters, defined once in `crates/eliotr-canonical/src/abi_version.rs`
(the single source of truth):

| Counter | Constant | Current | Covers |
|---|---|---|---|
| ABI version (semver) | `KERNEL_ABI_VERSION` | `1.0.0` | The *operation contract*: export names, result/error shapes, envelope field semantics, version-check rules |
| Schema generation (`u32`) | `KERNEL_SCHEMA_GENERATION` | `1` | The *data layout* generation: canonical byte layouts, vector frame formats, fixture encodings |

The semver version answers "can this consumer talk to this kernel at all". The generation
answers "do we interpret the same bytes the same way". They are separate because a new
operation can be added (minor bump) without changing any byte layout, and a layout fix can
ship (generation bump) without changing the operation surface.

The version does **not** cover: crate-internal APIs (only the boundary), the TypeScript
authority's own versioning, D1 migration numbering, or the PWA/Worker release version.

## 2. Compatibility rules

### 2.1 ABI version (semver)

- `major` must be **equal**. Any difference is an incompatible contract: fail closed
  (`ELIOTR_ABI_VERSION_MAJOR_MISMATCH`).
- Consumer `minor` must be **≤ kernel `minor`**. A consumer built against a newer minor
  speaks a contract the kernel does not implement: fail closed
  (`ELIOTR_ABI_VERSION_CONSUMER_NEWER`). An older-minor consumer is accepted: minor bumps
  are backwards-compatible by construction.
- `patch` is ignored. Patch bumps are compatible fixes with no observable change.

### 2.2 Schema generation

Must match **exactly** (`ELIOTR_ABI_SCHEMA_GENERATION_MISMATCH` otherwise). There is no
"older generation is fine": generation N bytes decoded with generation M rules is silent
corruption, so the check is strict equality.

### 2.3 Version-string parsing

`AbiVersion::parse` accepts only canonical `major.minor.patch`: exactly three
dot-separated ASCII-digit parts, no leading zeros (a lone `0` is fine), no whitespace, no
`v` prefix, no pre-release or build metadata, each part fitting in `u32`. Anything else is
`ELIOTR_ABI_VERSION_MALFORMED` — fail closed, never guess.

## 3. The boundary stamp

`crates/eliotr-kernel-wasm` exposes two always-present exports (not feature-gated; they are
metadata, not product operations):

```text
eliotr_kernel_abi_version_v1() -> u32   # packed: major << 16 | minor << 8 | patch
eliotr_kernel_schema_generation_v1() -> u32
```

The `_v1` suffix names the *stamp query protocol*, not the ABI version value. A TypeScript
consumer reads both stamps before invoking any operation, decodes the packed version, and
runs the same compatibility rules (see §5). `scripts/check-rust-wasm.mjs --mode default`
asserts these two stamps are present and that no other `eliotr_` export leaks.

## 4. The runtime gate

Every kernel operation must call `check_envelope(operation_version, schema_generation)`
before touching payload bytes. It parses the consumer's `operation_version`, applies §2.1,
then §2.2. The first failure wins; all failures are typed `AbiVersionError` values with
stable codes and carry no input bytes. This matches
`docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md` §6.2, which requires every operation
envelope to carry `operation_version` and `schema_generation`.

Cross-crate consistency is enforced by tests, not by convention:

- `eliotr-kernel-wasm` unit tests assert the Wasm stamps equal the canonical constants
  (drift guard: the stamp can never silently disagree with the source of truth).
- `eliotr-test-vectors/tests/kernel_abi_generation.rs` asserts
  `VECTOR_SCHEMA_GENERATION == KERNEL_SCHEMA_GENERATION` (the fixture corpus and the
  kernel share one generation counter).

## 5. TypeScript consumer pattern

```ts
const abiPacked = wasm.exports.eliotr_kernel_abi_version_v1();
const generation = wasm.exports.eliotr_kernel_schema_generation_v1();
const major = (abiPacked >>> 16) & 0xff_ffff;
const minor = (abiPacked >>> 8) & 0xff;
if (major !== EXPECTED_ABI_MAJOR) throw new Error("ELIOTR_ABI_VERSION_MAJOR_MISMATCH");
if (EXPECTED_ABI_MINOR > minor) throw new Error("ELIOTR_ABI_VERSION_CONSUMER_NEWER"); // kernel older than the consumer expects
if (generation !== EXPECTED_SCHEMA_GENERATION) {
  throw new Error("ELIOTR_ABI_SCHEMA_GENERATION_MISMATCH");
}
// only now invoke kernel operations, stamping operation_version/schema_generation
// into every envelope
```

The `EXPECTED_*` constants live next to the TS Wasm loader and are bumped in the same
commit as any kernel version bump (see §6).

## 6. Bump procedure

1. Decide the bump kind:
   - **major**: removed or renamed an export, changed a result/error shape, changed these
     version semantics. Requires a contract revision or scoped ADR
     (LANGUAGE_RUNTIME_CONTRACT.md §6.3).
   - **minor**: added an export, added an error code, widened an input domain without
     changing existing behavior.
   - **patch**: compatible fix, no observable change.
   - **generation**: changed any canonical byte layout or fixture encoding. Generation
     bumps are independent of semver bumps and always require re-verifying the embedded
     vector corpus (`cargo test -p eliotr-test-vectors`).
2. Update `KERNEL_ABI_VERSION` / `KERNEL_ABI_VERSION_{MAJOR,MINOR,PATCH}` /
   `KERNEL_SCHEMA_GENERATION` in `crates/eliotr-canonical/src/abi_version.rs`.
   `KERNEL_ABI_VERSION_PACKED` derives automatically.
3. If the stamp query protocol itself ever changes (new stamp exports), add `_v2`
   exports alongside `_v1`; never rename the existing ones in place.
4. Run the full Cargo gate: `cargo test --workspace` and `cargo build`.
5. Rebuild the Wasm artifact and run
   `node scripts/check-rust-wasm.mjs --mode default` and `--mode self-test`.
6. Bump the TS `EXPECTED_*` constants in the same commit.
7. Record the bump and its reason in the PR body.

## 7. Deliberately out of scope

- Full envelope struct parsing (YAML/JSON envelope → typed fields): that belongs to the
  first real product operation export, not to the version module. `check_envelope` takes
  the already-extracted version fields.
- `protocol`/`operation` envelope field validation: per-operation concern.
- Crate-internal API versioning: only the kernel boundary is versioned.
- Automatic TS binding generation from the Rust version: the packed stamp plus the
  manual consumer pattern (§5) is the mechanism; codegen is future work.
- Backwards-compatibility shims for old generations: the policy is fail-closed, not
  adaptation. Old consumers upgrade; the kernel never downgrades its interpretation.
