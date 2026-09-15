# S01 — Fix the five package-boundary failures

Priority: P1; first verification-pipeline blocker. Owners: ER-00 and the affected package owners. Parent topic: #96. Audited baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`, 2026-09-14. Consolidated finding: F20.

This is an implementation assignment, not an implemented fix. Merging this document does not complete the task. Implement a bounded change set on current main, without a local worktree; close against the implementing commit and verification results. This task does not authorize deployment or weaker checks.

## 1. Problem

[CI 34838617436](https://github.com/UnknownAlienHuman/eliot-research/actions/runs/34838617436) stops `verify` and `windows-tooling` at package boundaries. Later product tests in `verify` do not execute. The checker matches exact import specifiers; five failures do not establish five dependency cycles.

## 2. Required change

Resolve these exact imports:

- `cloudflare-research/src/artifact-draft-reader.ts` to `cloudflare-artifacts/artifact-draft-reauthorization.js` and `artifact-draft-citations-reauthorization.js`;
- `cloudflare-research/src/research-qualification-prompt.ts` to `@eliotr/retrieval`;
- `cloudflare-research-stages/src/research-coverage-result.ts` and `research-historical-coverage-reader.ts` to `@eliotr/domain`.

Out of scope: general refactoring, higher limits, toolchain upgrades, auth/Workflow redesign, and browser-harness repair.

## 3. Documentation and exact search anchors

[AGENTS.md](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md): `## Dependency direction`.

[Execution contract](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md): `## 3. Implement each checkpoint this way`; `## 4. Commands and test environment`.

```sh
git grep -n -F '## Dependency direction' -- AGENTS.md
git grep -n -F 'PACKAGE_RULES' -- scripts/check-boundaries.mjs
```

## 4. Implementation approach

Capture the five original failures. For each, identify the imported symbol, declared package dependency, export, and permitted dependency direction. Register only the justified specifier when a legitimate export is missing; use an existing lower-level port/module when the dependency is genuinely invalid. Do not allow all `@eliotr/*`, exclude the file from scanning, or add a reverse dependency. Preserve or extend `boundaries:negative`, including a forbidden-direction case and an unknown-subpath case. Change manifests/exports together only when required by the chosen correction.

## 5. Acceptance criteria

- [ ] `pnpm boundaries:check` and `pnpm boundaries:negative` pass on Linux and Windows.
- [ ] All five original failures are resolved with explanations; a deliberately forbidden import still exits non-zero.
- [ ] Affected packages typecheck; public DTOs and runtime behavior are unchanged.
- [ ] CI passes the boundary step. Any subsequent independent failure is reported separately, not called an overall pass.
- [ ] Record exact implementation SHA, commands, exit codes, and before/after evidence. Other mandatory release checks remain applicable.
