# S18 — Remove blind spots in the existing launch:code check

Baseline: `a2aca127`; finding F21. Do not introduce another gate or readiness registry.

## 1. Problem

`check-launch-code.mjs` searches for unavailable(...) and disabled_slices. It does not fully account for partial_slices or conditional disabledFederationApi/denied(...) paths. Its blocker count is not an inventory of every incomplete operation.

## 2. Required change

Align existing capabilities, implementation registry, and launch checking with the mandatory operations of the selected release profile. Check actual composition behavior rather than helper names.

## 3. Documentation and exact search anchors

[Production-readiness plan, section 0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md); [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md).

```sh
git grep -n -F '### Mechanical release rule' -- docs/implementation/production-readiness-plan.md
git grep -n -F 'partial_slices' -- apps/eliotr-core/src/composition-root.ts
git grep -n -F 'launchCodeBlockers' -- scripts
```

## 4. Implementation approach

Derive missing/partial operations and configuration requirements from existing declarations. Test absent and complete federation configuration as fixtures; absence of a production secret in Git is not evidence that the deployed secret is missing. Distinguish code-complete, configured, and live-qualified. Partial functionality is neither total failure nor complete implementation. Do not make unselected legacy Drive OAuth mandatory for gemini-mcp. Renaming unavailable/denied helpers must not change the verdict.

## 5. Acceptance criteria

- [ ] Negative fixtures detect partial WIKI/FEDERATION and missing mandatory handlers.
- [ ] Renaming a helper cannot alter readiness results.
- [ ] A complete test composition passes code checking without requiring live receipts that cannot exist before staging.
- [ ] Unselected integrations do not become mandatory.
- [ ] Reuse the existing command and registry; record tests and exact SHA without creating another status system.
