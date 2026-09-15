# S27 — Remove the artificial branch ceiling instead of adding exceptions

Baseline: `a2aca127`. The owner explicitly directed continuation without artificial branch restrictions. Creating or translating the other assignments does not depend on this task being closed. This changes procedural policy, not product security invariants.

## 1. Problem

A five-counted-branch ceiling and a whitelist of nine names dated 20260905 obstruct a series of small PRs. Adding named exceptions would increase administrative complexity rather than solve the cause.

## 2. Required change

Remove the numeric ceiling and dated reserved_open_pr_heads mechanism. Do not automatically remove unmerged work based on branch count or age. Retain safe cleanup of demonstrably integrated branches and explicit operator-directed actions.

## 3. Documentation and exact search anchors

[Branch discipline](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/branch-discipline.md); [AGENTS](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md). Update the superseded procedure explicitly under the owner's direction.

```sh
git grep -n -e max_non_default_branches -e reserved_open_pr_heads -e QUARANTINE_CEILING_EVICTION -- scripts infra/github
git grep -n -F '## Swarm edit protocol' -- AGENTS.md
```

## 4. Implementation approach

Simplify branch-hygiene-lib.mjs, its callers/tests, and configuration: remove the cap, count-based eviction, and dated exceptions without disabling all CI. Before cleanup, establish integration, absence of an open PR, and an unchanged head SHA. A closed-but-unmerged PR is not proof that its work is disposable. Align START-HERE, branch-discipline, and AGENTS with one coherent procedure, not another registry. Preserve the owner's main-only/no-local-worktree implementation rule.

## 5. Acceptance criteria

- [ ] Open-PR count cannot cause a branch-ceiling failure.
- [ ] No replacement numeric quota or named/dated exception list is introduced.
- [ ] Age alone does not delete work; unmerged/open-PR/default/protected branches remain safe.
- [ ] A newly opened PR or changed head cancels cleanup of that candidate.
- [ ] Unit/negative hygiene tests pass; data/security/runtime checks remain intact. This planning PR itself deletes no user branches.
