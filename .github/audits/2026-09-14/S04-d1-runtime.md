# S04 — Test Project/Wiki SQL on D1, not only node:sqlite

Baseline: `a2aca127`; findings F14/F16. This is an independent, bounded regression task, not a migration of the entire test suite.

## 1. Problem

Project updates and Wiki edits have exceeded SQL expression-depth limits on real D1. Passing node:sqlite tests does not establish workerd/D1 compatibility. Local D1 reproduces the limit; detecting it does not require production deployment.

## 2. Required change

Add runtime regressions for the two previously failing operations: updating a project with memberships and saving a Wiki owner edit. Execute the real migration chain and emitted SQL through the existing Workers Vitest configuration.

## 3. Documentation and exact search anchors

[Language contract, section 3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md): `D1 queries and transaction orchestration`.

[Execution contract, section 4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md): `D1/R2/runtime, crypto, transactions`.

```sh
git grep -n -F 'Expression tree too large' -- docs/implementation
git grep -n -F 'D1 queries and transaction orchestration' -- docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md
```

## 4. Implementation approach

Use `apps/eliotr-core/test`, the current project-owner service, and the Wiki edit service. Call the actual services instead of copying their SQL into tests. Prepare minimal valid fixtures with existing helpers; perform insert/update and read back head/receipt/outbox state. Demonstrate rollback on stale CAS. Include a small expression-depth negative to establish that the harness actually uses D1 rather than the more permissive SQLite adapter. Keep pure unit tests fast and do not install another test framework.

## 5. Acceptance criteria

- [ ] Both operations compile and execute under workerd with current migrations.
- [ ] A stale-head rejection preserves previous data with no partial changes or outbox writes.
- [ ] The regression detects D1 expression-depth overflow before deployment.
- [ ] CI executes these tests; node:sqlite success is not reported as D1 acceptance.
- [ ] Attach commands, exact implementation SHA, and before/after results. No cloud deployment is needed for this task.
