# Frontend autonomous manager runbook

**Status:** normative operating contract for the owner-authorized ER-47/ER-48 frontend manager.
**Owner authorization:** execute F1-F4 continuously and present the finished integrated interface after U5-X.
**Reference contract:** `frontend-notebooklm-material-reference.md`.
**Deployment authority:** none. F5, production/account mutation, cutover, legacy deletion and final merge remain
separately authorized actions.

The manager owns one worktree and one implementation branch. Subagents receive small tasks inside that manager
context and create no branches or worktrees. Routine checkpoint completion never requires another owner prompt.

## 1. Continuous authorized program

```text
U1.1a → B-U → U1.1b → U1-R live NotebookLM study
→ U1.2 → U1.3 → U1.4 → U1-D internal design gate → U1.5
→ U2-S / U2-R / U2-T / U2-C → U2-X independent internal usability audit
→ C0 → B-C → C1 → C2 → U3
→ C3 → U4 → U5 → U5-X
→ FINAL-UI owner review
```

C0/C1 work may run in parallel with fixture UI only when ownership and paths are disjoint. Before ER-49, run
one leaf at a time. After ER-49, only dependency-ready disjoint leaves may run.

The manager does not stop at U1-D or U2-X. Those are internal quality gates. It fixes defects and continues.
The first owner UI review is after U5-X, with the complete interface and evidence package.

## 2. Required design-reference behavior

Before choosing product tokens or shell composition, execute U1-R from
`frontend-notebooklm-material-reference.md`:

- open the current live NotebookLM in the available authenticated browser;
- inspect actual Sources, Chat/Research, citations and Studio behavior;
- inspect current official Material 3 / Material 3 Expressive guidance;
- record a private-data-free observation matrix and screenshots;
- build Eliot in the same design discipline but with a distinct, more modern identity;
- treat generic shadcn/admin output as a failed result.

The manager must use rendered browser inspection throughout implementation. Types, DOM snapshots and isolated
component stories cannot establish visual quality.

## 3. Operating loop

Repeat until U5-X is accepted:

1. refresh current main, task comments, contracts and manager authorization;
2. maintain a table of `BLOCKED | READY | ACTIVE | ACCEPTED | INTERNAL_GATE | FINAL_REVIEW`;
3. select the highest-value dependency-ready checkpoint without asking the owner;
4. issue one leaf envelope with exact paths, inputs, commands, success tests, mandatory negative and stop rules;
5. inspect source, diff and actual rendered output;
6. repair compiler, lint, test, peer, CSP, accessibility, responsive, visual, browser and performance failures;
7. publish coherent commits and exact evidence;
8. immediately select the next ready checkpoint;
9. update the task only for meaningful tranche progress, hard blockers and final review readiness.

A leaf performs the task rather than returning a plan and waiting.

## 4. Default decisions

| Concern | Default |
|---|---|
| Product reference | live NotebookLM + official current Material 3 / M3 Expressive |
| Navigation | React Router library mode; no SSR/RSC/full-stack framework mode |
| Remote reads | memory-only TanStack Query with signals and authority epochs |
| Local state | React local state; no speculative global store |
| Styling | Tailwind v4 consuming committed semantic tokens; no MUI/Emotion parallel authority |
| Ordinary controls | native HTML semantics |
| Composite controls | Base UI first; React Aria is one bounded fallback comparison |
| Panes | stable non-resizable layout until splitter passes keyboard/ARIA/touch/CSP/performance |
| Lists | bounded pagination before virtualization |
| Fonts | approved local/system stack with strong Cyrillic; no remote CDN |
| Icons | one source-owned local SVG family |
| U1/U2 data | deterministic private-data-free fixtures |
| Research progress | canonical HTTP polling/readback; strict projection only where accepted |
| Persistence | theme and bounded non-private layout preferences only |
| Service worker | none in React app |
| Cloudflare local | `CLOUDFLARE_ENV=test` and `remoteBindings:false` |
| Test stack | Storybook CSF + Playwright; no competing framework |
| Visual baseline | pinned Chromium, deterministic fixtures, no auto-accept |
| Unsupported product | omit rather than decorative disabled cards |

A reversible default may change only with recorded evidence that it fails the checkpoint.

## 5. Leaf task envelope

```text
Checkpoint: <ID>
Objective: <one bounded result>
Allowed paths: <exact paths>
Read: <only exact packet/checkpoint/contracts/source>
Inputs: <predecessor commits/receipts>
Reference observations: <applicable U1-R items>
Required implementation: <finite list>
Success tests: <finite list>
Mandatory negative: <named failure>
Rendered inspection: <states, viewports, themes, content lengths>
Commands: <exact scoped commands>
Done when: <observable evidence>
Stop only if: <hard blocker classes>
Forbidden: <ownership/authority/unsafe shortcuts>
```

## 6. Review passes

### Authority

- one Worker, owner client, design, state and build authority;
- no legacy renderer/CSS import or direct feature `fetch`;
- no copied decoder, invented endpoint/state or second completion authority;
- no production/remote binding in ordinary development.

### Behavior

- success path executes;
- mandatory negative fails for the exact reason;
- unknown/degraded/denied/failed remain distinct;
- replay, cancellation, late response and lost acknowledgement preserve identity/currentness.

### Rendered product

- compare actual screen to the U1-R NotebookLM/Material observation matrix;
- coherent hierarchy, typography, density, spacing, tonal surfaces, actions, focus and scroll ownership;
- usable long Russian/English, desktop/tablet/phone and light/dark states;
- no generic admin/shadcn look, card soup, nested scrolling or jumping labels;
- improve Eliot-specific scope/evidence/currentness clarity beyond the reference.

### Engineering

- applicable type/lint/unit/Storybook/Playwright/CSP/a11y/performance checks;
- no console errors, unhandled rejection or unexpected request;
- exact build, bundle, browser, fixture and visual evidence;
- `git diff --check` and no unrelated cleanup.

## 7. Internal gates

### U1-D

Manager-only design acceptance after live NotebookLM study and actual rendered comparison. Select one coherent
direction, remove rejected alternatives, document rationale and continue automatically to U1.5.

### U2-X

A fresh-context tester who did not build the screen performs the no-hint primary journey. The manager fixes all
material confusion and reruns until accepted, then continues to C/U feature wiring.

Neither gate asks the owner to approve partial work.

## 8. Two-failure recovery

After two materially different failed approaches to one blocker, write:

```text
blocker
attempt 1 + evidence
attempt 2 + evidence
root-cause hypothesis
boundary involved
alternatives considered
selected different approach
remaining hard blocker
```

Then change approach. Do not add a third CSS override or repeat the same library/configuration strategy.

## 9. Cross-owner handoffs

For B-U, B-C and other named gates, prepare an exact handoff with input commits, shared paths, finite changes,
commands, mandatory negative, rollback condition and downstream checkpoints. Delegate to an authorized
integrator when available and review the result. Continue independent ready work while a handoff is pending.
Do not ask the owner to restate architecture already recorded in the repository.

## 10. Hard stops

Escalate only for:

- contradictory or missing authoritative contract that changes product truth;
- required path outside authorization with no named owner able to accept the handoff;
- proposed weakening of CSP, authorization, privacy, exact evidence, currentness or replay;
- unavailable authenticated NotebookLM/browser access after tooling recovery attempts;
- production deployment, Cloudflare/provider/account mutation or budget spend;
- irreversible migration, deletion, cutover, release or final merge;
- moving-main conflict that semantically invalidates accepted work;
- FINAL-UI owner review after U5-X.

Not hard stops: compiler/lint/test failure, peer conflict inside the approved toolchain, a failed primitive or
splitter candidate, layout/a11y/CSP defects, optional MCP failure, regenerable screenshots, a blocked leaf with
another ready leaf, or an owned-path refactor needed to fix root cause.

## 11. Final review package

After U5-X, provide one finished review build containing Sources, Research, Evidence, Studio and Connections.
Include:

```text
exact base/final commits and manager authorization
checkpoint table and predecessor SHAs
live NotebookLM / Material reference matrix
changed paths by checkpoint
commands and exit statuses
mandatory negative evidence
Storybook/Playwright/CSP/a11y/performance/visual evidence
1440/1024/768/390, light/dark, long RU/EN
useful/loading/empty/degraded/error states
safe local/non-production review instructions
known limitations and PENDING staging/live/release gates
```

Ask the owner to review the complete product once. Do not deploy, merge final implementation, cut over or remove
legacy until separately authorized.

## 12. Ready-to-use launch instruction

```text
Act as the Eliot owner-web manager. Work in one manager worktree and use bounded subagents inside it. Read
START-HERE, AGENTS, this runbook, the NotebookLM/Material reference protocol, execution map, ER-47/ER-48 and the
current contract amendment.

Execute F1-F4 continuously through U5-X. Open the current live NotebookLM in the available authenticated browser
and study it before choosing tokens or shell composition. Use current official Material 3 / M3 Expressive
principles. Build a distinct Eliot interface that is more modern, precise and coherent, not a generic shadcn
admin dashboard and not a pixel copy.

Do not stop at U1-D or U2-X and do not ask whether to continue. Treat them as internal gates, repair failures and
advance automatically. After two failed approaches, write a failure audit and change strategy. Stop only for a
genuine authority/security/ownership blocker, unavailable required browser access, unauthorized production or
irreversible action, or the final complete-interface review after U5-X.
```
