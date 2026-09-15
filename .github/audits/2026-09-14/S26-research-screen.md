# S26 — One understandable Research screen: sources → question → answer → citation

Baseline: `a2aca127`; finding F19. Scope: the Research view, not a rewrite of the entire PWA.

## 1. Problem

Recent work, configuration, and technical status appear before the question input. The main action falls below the first screen, forcing users to learn internal architecture before doing research.

## 2. Required change

Reorganize the existing Research view: compact source selection on the left, question/answer in the center, and exact citation details on selection on the right. Make question input and the primary action immediately available. Move configuration, schema, and proof-expiry details to existing Connections/details views.

## 3. Documentation and exact search anchors

[Architecture, sections 0 and 7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F 'Chat is an interface to an Investigation.' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'apps/eliotr-pwa' -- AGENTS.md
```

## 4. Implementation approach

Rearrange and reuse existing panels in main.ts, the Research panel, and CSS. Do not modify the backend, introduce a UI framework, or simulate missing functionality. Make Recent work a compact history. Put technical state behind details. For a blocked run, show a clear reason and actionable next step, not a decorative READY label. Preserve stable data attributes, keyboard navigation, and accessible labels.

## 5. Acceptance criteria

- [ ] At 1440×900, the question input, selected scope, and primary button are visible without scrolling.
- [ ] On narrow screens, sources/citations become accessible collapsible panels without covering the input.
- [ ] Selecting a citation opens exact evidence, not a source-free tooltip.
- [ ] No new external services/frameworks or duplicate forms; existing API operations are reused.
- [ ] A real browser scenario covers project selection → question → answer → citation and a blocked state. Attach screenshots, exact SHA, and test results.
