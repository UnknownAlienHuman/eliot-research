# Rust mutation-gate closure plan — 2026-09-10

Baseline: `489e038d68edb3fe2bf92b7ee0b70bfc1a70ab33`  
Owners: ER-40 for canonical/vector code; ER-00 for CI composition.  
Tracking issue: #106.

## Audit finding

The scheduled `rust-deep-verification` mutation job is red on `main`:

- 982 mutants tested in `eliotr-canonical`;
- 648 caught;
- 293 missed;
- 35 unviable;
- 6 timed out.

The surviving set includes canonical JSON escaping and UTF-8 width logic, stable IDs, owner-token tuples and scope-snapshot identity validators. A test suite that permits these mutations is not strong enough to authorize Rust promotion for the affected identity families.

The workflow also runs the `eliotr-test-vectors` mutation command after the canonical command in the same shell step sequence. When the first command fails, the second report is not produced, so one red family hides the state of the next family.

## Required work

1. **Triage every survivor by deterministic family.** Produce a machine-readable inventory with source path, mutation, outcome, family, expected test and disposition: `must-kill`, `equivalent/unviable`, or explicitly time-bounded investigation. Do not maintain a blanket ignored-mutant list.
2. **Kill load-bearing canonical survivors first.** Add shared committed vectors and focused negative/property tests for:
   - string escape parsing and emission, including backslash, control bytes, surrogate handling and Unicode width;
   - canonical key ordering and exact UTF-8 bytes;
   - stable-ID and owner-token separators, lengths, prefixes and digest truncation;
   - every scope-snapshot identity shape/identifier/expression/timestamp validator;
   - error-code and fail-closed paths.
3. **Replace timeout-as-detection with bounded progress.** The six loop/progress mutations must terminate under a test-owned bound and fail deterministically. Increasing the mutation timeout is not a fix.
4. **Run both mutation families independently.** Split `eliotr-canonical` and `eliotr-test-vectors` into separate jobs or always-run steps with an aggregate terminal gate so both reports are retained even if one fails.
5. **Define a promotion gate, not a vanity percentage.** No affected identity family may be promoted while a load-bearing survivor can alter accepted bytes, IDs, validators, error codes or termination. Any equivalent mutant needs a reviewed path-specific explanation. A global caught ratio may be reported, but it cannot excuse a surviving load-bearing mutation.
6. **Retain exact-head receipts.** Upload machine-readable mutation reports and a short summary for the exact PR head. The reports must identify toolchain and `cargo-mutants` versions and be reproducible from the frozen lock/toolchain.
7. **Keep ordinary CI bounded.** Decide explicitly which fast mutation sentinel set runs on pull requests and which exhaustive set remains scheduled/manual. A PR-changing canonical identity code must run the relevant sentinel set before merge.
8. Update ER-40, Launch 09, the gap register and implementation-status evidence in the same accepted checkpoint. Do not claim `LIVE_QUALIFIED` or Rust authority promotion.

## Acceptance criteria

- Every load-bearing survivor listed in #106 is killed or has a reviewed, reproducible equivalence proof tied to the exact source line and mutation.
- Escape handling, UTF-8 width, stable IDs, owner-token tuples and scope-snapshot validators cannot be removed, inverted or replaced with unconditional success without a test failure.
- All former timeout mutations finish within an explicit test-owned bound; the mutation report contains zero timeouts.
- Both `eliotr-canonical` and `eliotr-test-vectors` produce retained reports on every deep-verification run, including when either family is red.
- The PR gate runs a bounded sentinel mutation set whenever affected canonical paths change; the exhaustive scheduled gate remains green on the accepted exact head.
- `cargo test`, nextest, Clippy, formatting, deny, Wasm parity, coverage, fuzz and Miri remain green; no threshold is weakened to obtain a pass.
- No canonical bytes, stored identity, schema version or active TypeScript/Rust owner changes without a separate compatibility and promotion checkpoint.
- Exact-head GitHub CI and `rust-deep-verification` are green before this plan is marked complete.
