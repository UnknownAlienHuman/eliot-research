# S76 — Make compressed TypeScript methods reviewable

Baseline: `a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Findings F24/OVR-05; owners ER-00/24. Formatting changes must remain separate from behavior changes. S90/#282 owns measured runtime budgets; physical source counts are maintainability observations, not runtime performance.

## 1. Problem

ResearchSession and model-attempt/spend-admission modules contain extremely long single-line methods, obscuring races and diagnostic locations. Counting their physical lines does not measure complexity or deployed size.

## 2. Required change

Install one pinned root development formatter and format existing product TypeScript/JavaScript, starting with ResearchSession and model-attempt/spend-admission. Use Prettier, not a formatting service, MCP server, or background agent. Apply changes in reviewable batches; installing the tool alone is not completion.

## 3. Documentation and exact search anchors

[AGENTS](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md), `## Swarm edit protocol`; [S90](https://github.com/UnknownAlienHuman/eliot-research/pull/282) explicitly revises misleading procedural source budgets. [Official Prettier installation](https://prettier.io/docs/install), rechecked 2026-09-15, specifies an exact local dependency and currently uses 3.9.6.

```sh
git grep -n -F '## Swarm edit protocol' -- AGENTS.md
pnpm add -Dw --save-exact prettier@3.9.6
pnpm exec prettier --check <explicit-product-ts-js-paths>
```

## 4. Implementation approach

Check compatibility with the repository's pinned Node/pnpm before installation. Keep Prettier development-only and use LF with a configuration matching existing style. Exclude immutable contract/vector fixtures, migrations, generated bindings, receipts, source snapshots, and golden bytes from automatic formatting. Do not rewrite normative JSON/document bytes.

Keep tool/lock changes and mechanical formatting distinguishable from bug fixes. Compare literal/template-string and evaluated SQL values, not just formatter exit status. Preserve existing tests. Do not add Husky, a watcher, or formatter exclusions hiding large methods. Do not minify again or manufacture packages to satisfy physical line counts; improve module cohesion only by actual responsibility. S77/#269 concerns shared Unicode validation, not general source-size budgets.

## 5. Acceptance criteria

- [ ] ResearchSession and model-attempt/spend methods are readable; product TS/JS follows one format contract.
- [ ] Literal, SQL, immutable fixture bytes, and runtime decisions are unchanged, with existing tests and semantic-diff review supporting the claim.
- [ ] No large-method ignore workaround, background tooling, or formatting of immutable fixtures is introduced.
- [ ] Source counts remain visible; actual build/runtime limits are measured through S90, not hidden by relocation or minification.
- [ ] Record exact implementation SHA, commands, test results, and the separate tool/lock and mechanical change sets. This assignment contains no implementation or deployment authorization.
