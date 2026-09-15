# S89 — Complete per-family M6 promotion and M7 removal

Baseline `a2aca127`; ER-40/24/00. Prerequisites are S88/#280 plus the particular accepted S78–S87 family being switched. This is an aggregate completion task with separate family checkpoints, not one atomic rewrite or permission to promote unverified families together.

## 1. Problem

CI-only Wasm and shadow execution do not satisfy the runtime ownership decision. After promotion there must not be two independent production decisions or silent fallback to more permissive TS behavior.

## 2. Required change

For every mandatory production-critical family, complete M5 evidence, M6 actual caller switching, and M7 removal of superseded TS production decisions. Preserve reference fixtures. Use the existing Launch09 family status record rather than another registry or a global Rust=true flag.

## 3. Documentation and exact search anchors

[Language contract section 10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md); [Launch09 K6/K7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/09-rust.md).
```sh
git grep -n -F 'K6 — controlled per-family Rust promotion.' -- docs/implementation/launch-prs/09-rust.md
```

## 4. Implementation approach

Before each switch, retain exact native/Wasm/Worker/parity/property/mutation results, ABI/family generations, measured size/memory/CPU, and a verified rollback build. Connect Rust output to the actual application caller. TS may reject malformed/oversized transport first, but must not independently override the promoted domain result.

Trap or ABI mismatch fails the affected operation closed. Preserve SQL currentness/CAS and the existing single-effect path. Without proven active-run compatibility, promote only after controlled completion or an established safe pause/drain procedure for affected work; never delete runs. Test supported old-to-new continuation separately under #197/#259. Keep historical readers and canonical bytes compatible.

Prove the promoted path works with the old TS decision disabled, remove that production implementation, and rerun regressions. Update existing registry/gap/Launch09 for the particular family. Missing evidence remains a missing promotion prerequisite, not an inferred pass.

## 5. Acceptance criteria

- [ ] Every mandatory family has one actual runtime decision owner and traceable caller→compiled module→result evidence; CI-only implementations do not count.
- [ ] Promoted callers work without the superseded TS decision; actual caller tests detect a deliberately invalid Rust decision. Fixtures are references, not a second production owner.
- [ ] Wrong ABI/trap/rollback/revoke/purge/replay cannot strengthen authority, alter historical hashes, or repeat paid effects.
- [ ] Applicable deep Rust checks, including #176, and Worker/browser/headless regressions pass alongside measured runtime budgets.
- [ ] Record exact implementation and acceptance SHAs per family. A language percentage or one successful family is not completion of this aggregate task.
