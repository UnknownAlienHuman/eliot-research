# Frontend autonomous manager runbook

**Status:** frontend delivery and acceptance guidance for the owner-authorized compact refactor programme.
**Owner authorization:** continue scoped implementation through the completed integrated interface and U5-X.
**Reference contract:** `frontend-notebooklm-material-reference.md`.
**UI operating procedure:** `frontend-material-agent-playbook.md`.
**Publication boundary:** prepare the integrated build/deploy bridge and rollback artifact within the
authorized refactor before FINAL-UI. Actual production deploy, account mutation, cutover and final merge
require the owner's authorization for those actions; reuse it if already given. Ordinary code retirement
after cutover/rollback obligations is part of the authorized refactor.

Use the existing manager checkout/worktree. The manager assigns exact allowed paths and acceptance criteria for
each task. Parallel tasks may proceed only on disjoint paths; the manager serializes shared composition roots,
manifests, routes, barrels, fixtures, SQL, Worker and CI files. Do not create another scheduler, claim registry,
branch or worktree for process compliance. Routine task completion never requires another owner prompt.

### Execution clarification — 2026-10-11

The current programme authority is [ADR-0019](../adr/0019-compact-refactoring.md) and the current router in
`docs/implementation/backend-entrypoints.md`. Historical ER-47/48 claims and ER-49 ancestry checks are
optional audit records only; they are not task prerequisites, active assignments or completion gates. Ordinary
in-scope repairs follow the manager's exact-path envelope and need no new Issue or auditor approval.

Execution eligibility is not verified acceptance. Withdrawing a prerequisite does not execute tests, repair a
product defect or accept FINAL-UI. Required checks still need actual evidence. Reuse accepted early gates and
unchanged evidence; do not restart U1-R/U1-D/U2-X solely because the manager resumed or main changed.

## 1. Continuous authorized program

Use `backend-entrypoints.md` for the active implementation order. The owner-web delivery map retains the UI
quality milestones: U1-R/U1-D visual direction, U2-X usability, U5-X integrated acceptance, FINAL-UI owner
review and separately authorized U6 cutover. Historical C/U checkpoint labels are descriptive references,
not claim IDs, task prerequisites or an assignment protocol.

The manager may run independent work concurrently only when exact paths are disjoint. Shared files and
integration points are serialized by the manager.

The manager does not stop at U1-D or U2-X. Those are internal quality gates. It fixes defects and continues.
The first owner UI review is after U5-X, with the complete interface and evidence package.

## 2. Mandatory tool and source sequence

For rendered UI work, follow the applicable method in `frontend-material-agent-playbook.md`. Use approved official
sources and live NotebookLM U1-R evidence before token or shell decisions. Use the accepted `@eliotr/ui` catalog
and Storybook docs, implement the needed state, then inspect it in Chrome and run relevant Storybook/Playwright,
accessibility, visual and CSP checks. Google Design MCP may inform token/icon/font proposals. Random design
galleries, public dashboard templates and undocumented component props are not inputs.

## 3. Required design-reference behavior

Before choosing product tokens or shell composition, execute U1-R from
`frontend-notebooklm-material-reference.md`:

- open the current live NotebookLM in the available authenticated browser;
- inspect actual Sources, Chat/Research, citations and Studio behavior;
- inspect current official Material 3 / Material 3 Expressive guidance;
- record a private-data-free observation matrix and screenshots;
- build Eliot in the same design discipline but with a distinct, more modern identity;
- treat generic shadcn/admin output as a failed result.

The manager uses rendered browser inspection at assembled UI acceptance. Types, DOM snapshots and isolated
component stories cannot establish visual quality.

## 4. Operating loop

Repeat until U5-X is accepted:

1. refresh the implementation router, relevant contracts and manager authorization;
2. select the highest-value ready task without asking the owner;
3. issue a bounded task envelope with exact paths, inputs, commands, acceptance evidence and stop rules;
4. inspect source, diff and actual rendered output;
5. during implementation repair scoped compiler/lint failures; after assembly repair applicable test, peer, CSP,
   accessibility, responsive, visual, browser and performance failures;
6. publish coherent changes and concise evidence;
7. immediately select the next ready task;
8. update the existing task only for material progress, hard blockers and final review readiness.

Each assigned task is implemented in the manager's checkout rather than returned as a plan. A failing check is
work to repair; a pending cross-owner handoff does not stop independent implementation, verification or
review-package preparation.

During the code phase use scoped compile/lint first. Do not run tests or browser checks after every edit; run
applicable suites and UI acceptance after assembly at their actual boundary. Reference unchanged source/evidence
instead of duplicating hash inventories. Do not create JSON claims or ancestry receipts. Existing UI product,
security, accessibility, rendered-quality and release checks remain.

Maintain the existing #335 status for material results. A denied comment edit is a reporting limitation, not
a development stop; retain the result in the existing handoff or one explicitly superseding status. Historical
PR cleanup is a separate operator lane, not a prerequisite for UI delivery. A posted instruction alone does
not prove that the local manager received it or resumed.

## 5. Default decisions

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

A reversible default may change only with recorded evidence that it fails acceptance.

## 6. Task envelope

```text
Task: <short name>
Objective: <one bounded result>
Allowed paths: <exact paths>
Read: <relevant contract/source>
Inputs: <required current source/evidence>
Reference observations: <applicable U1-R items>
Required implementation: <finite list>
Acceptance: <observable behavior and evidence>
Mandatory negative: <named failure>
Rendered inspection: <states, viewports, themes, content lengths>
Commands: <exact scoped commands>
Done when: <acceptance evidence is recorded>
Stop only if: <hard blocker classes>
Forbidden: <ownership/authority/unsafe shortcuts>
```

## 7. Review passes

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

- during implementation, scoped type/lint; after assembly, applicable unit/Storybook/Playwright/CSP/a11y/performance checks;
- no console errors, unhandled rejection or unexpected request;
- exact build, bundle, browser, fixture and visual evidence;
- `git diff --check` and no unrelated cleanup.

## 8. Internal gates

### U1-D

Manager-only design acceptance after live NotebookLM study and actual rendered comparison. Select one coherent
direction, remove rejected alternatives, document rationale and continue automatically to U1.5.

### U2-X

A fresh-context tester who did not build the screen performs the no-hint primary journey. The manager fixes all
material confusion and reruns until accepted, then continues to C/U feature wiring.

Neither gate asks the owner to approve partial work.

## 9. Two-failure recovery

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
Count materially different failed attempts, not status observations. A third check is not an automatic
Goal=BLOCKED condition. Record diagnosis in the existing work record and execute the different approach.

## 10. Cross-owner handoffs

When work crosses an existing owner boundary, give that owner the exact files, interface change, acceptance
evidence and shared-file coordination needed. Continue independent ready work while the handoff is pending. Do
not ask the owner to restate recorded architecture, silently edit another owner's paths, or invent a missing
contract. Preserve mutation identity/readback and disclose material UI limitations. A newly reproduced failure
still needs a repair.

## 11. Hard stops

Apply a stop to the affected action or acceptance, not automatically to every workstream. Mark the whole
program BLOCKED only when no authorized independent implementation, verification or integration work can
proceed and the exact unresolved external decision/capability is identified. Resolve superseded audit prose
through current owner instructions and contracts; a new unrelated main SHA is not a semantic conflict.

Escalate only for:

- contradictory or missing authoritative contract that changes product truth;
- required path outside authorization with no named owner able to accept the handoff;
- proposed weakening of CSP, authorization, privacy, exact evidence, currentness or replay;
- unavailable authenticated NotebookLM/browser access after tooling recovery attempts;
- production deployment, Cloudflare/provider/account mutation or budget spend without existing authorization;
- irreversible migration/data deletion, cutover, release or final merge without existing authorization;
- moving-main conflict that semantically invalidates accepted work;
- FINAL-UI owner review after U5-X.

Not hard stops: compiler/lint/test failure, peer conflict inside the approved toolchain, a failed primitive or
splitter candidate, layout/a11y/CSP defects, optional MCP failure, regenerable screenshots, a blocked task with
another independent task ready, or an in-scope refactor needed to fix root cause.

## 12. Final review package

After U5-X, provide one finished review build containing Sources, Research, Evidence, Studio and Connections.
Include:

```text
exact source/build identity and manager authorization
completed UI areas and dependencies
live NotebookLM / Material reference matrix
changed paths by task
commands and exit statuses
mandatory negative evidence
Storybook/Playwright/CSP/a11y/performance/visual evidence
1440/1024/768/390, light/dark, long RU/EN
useful/loading/empty/degraded/error states
safe local/non-production review instructions
known limitations and PENDING staging/live/release gates
```

Ask the owner to review the complete product once, with the prepared bridge and rollback included. Actual
deploy, final implementation merge and cutover need their action authorization. Replaced legacy code may be
removed within the authorized refactor after cutover and rollback obligations are satisfied.

## 13. Ready-to-use launch instruction

```text
Act as the Eliot owner-web manager in the existing manager checkout. Read START-HERE, AGENTS, ADR-0019, the
current implementation router, the Material UI agent playbook, this runbook, the NotebookLM/Material reference
protocol and affected owner API contracts.

Execute F1-F4 continuously through U5-X. Open the current live NotebookLM in the available authenticated browser
and study it before choosing tokens or shell composition. Use current official Material 3 / M3 Expressive
principles. Build a distinct Eliot interface that is more modern, precise and coherent, not a generic shadcn
admin dashboard and not a pixel copy.

Do not stop at U1-D or U2-X and do not ask whether to continue. Treat them as internal gates, repair failures and
advance automatically. Use exact path scopes; parallelize only disjoint work and serialize shared files. After
two failed approaches, record the failure and change strategy. Stop only for a
genuine authority/security/ownership blocker, unavailable required browser access, unauthorized production or
irreversible action, or the final complete-interface review after U5-X.
```
