# Live NotebookLM and Material 3 reference protocol

**Status:** normative design-reference contract for ER-47 F1-F4.
**Owner instruction:** build the complete interface autonomously; do not stop for intermediate aesthetic or
usability approval. The owner reviews the finished integrated interface after U5-X and before merge/deploy.
**Reference product:** the current live Google NotebookLM web application opened in an actual browser session.
**Design system:** current official Material 3 and Material 3 Expressive guidance.

This protocol exists because reading design prose or installing shadcn components does not create a good
product. The manager and UI leaves must inspect the real reference product, understand why it works, then build
a distinct Eliot interface that is at least as coherent and more modern, precise and useful for evidence work.

## 1. Mandatory live-browser study — U1-R

Before token selection or product shell design, the manager opens `https://notebooklm.google.com/` in the
available authenticated browser profile. Use Chrome DevTools MCP, Playwright attached to the approved browser,
or another real interactive browser tool. Do not substitute source code, DOM guesses or old screenshots when
the live product is available.

Use a blank or non-sensitive notebook. Do not upload Eliot private material, credentials or customer content.
Screenshots and notes must avoid personal source text and account identifiers.

Inspect at minimum:

1. notebook/library entry and notebook opening;
2. Sources, Chat/Research and Studio composition;
3. source selection, add-source flow and long source titles;
4. question composer, answer hierarchy and citations;
5. citation/source opening and return behavior;
6. Studio artifacts and notes organization;
7. empty, loading, active, degraded and error states;
8. panel collapse/resize behavior, scroll ownership and focus movement;
9. keyboard navigation and visible focus;
10. 1440, 1024, 768 and 390 width behavior where the product supports it;
11. light/dark appearance when available;
12. motion, hover, pressed, selected and disabled states;
13. typography, spacing, shape, iconography, tonal surfaces and primary-action hierarchy.

Record an observation matrix, screenshots, viewport/browser identity and measured geometry. The evidence is a
reference study, not a pixel-copy specification.

## 2. Official Google reference material

Read current official Google sources in addition to the live product:

- NotebookLM three-area redesign: `https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-new-features-december-2024/`
- Material 3: `https://m3.material.io/`
- Material 3 motion and Expressive motion schemes: `https://m3.material.io/styles/motion/overview/how-it-works`

The live product wins over dated screenshots for current behavior. Official Material guidance wins over a
third-party component library's defaults.

## 3. What Eliot keeps from NotebookLM

Preserve the design logic, not the skin:

- one obvious research task at a time;
- stable Sources / Research / Studio mental model;
- fast movement between source, answer and supporting citation;
- calm information density and long-reading comfort;
- clear primary action and restrained secondary controls;
- adaptive panels instead of an operator-console wall;
- progressive disclosure for technical details;
- direct source selection near the question context;
- generous but disciplined spacing and strong typographic hierarchy.

## 4. What Eliot must improve

Eliot must be more modern and more precise than NotebookLM for its product domain:

- Material 3 Expressive character at key moments without decorative noise;
- clearer distinction between selected scope, historical scope, readiness and exact evidence;
- stronger citation/evidence inspector and currentness language;
- better dark, high-contrast, long-Russian and ultrawide behavior;
- no permanent empty Studio/evidence pane;
- no card soup, admin-dashboard chrome or repeated status banners;
- stable geometry during progressive Research updates;
- one scroll owner per pane and no hidden/custom scrollbar tricks;
- honest unknown/degraded/denied states;
- faster initial load and bounded rendering of large source/report collections;
- a recognizable Eliot visual identity rather than a literal Google clone.

## 5. Material 3 / Expressive direction

Use semantic color roles, tonal surfaces, meaningful shape, strong typography and motion tokens. Expressive
motion is for major spatial transitions and hero moments; utilitarian research interactions use restrained
standard motion. Avoid animation on every token or status update.

Required characteristics:

- clear surface-container hierarchy instead of borders around everything;
- large, legible question and reading surfaces;
- selective asymmetric/expressive shape only where it improves hierarchy;
- modern search/app-bar treatment where useful;
- 4 px base and disciplined 8 px rhythm;
- native semantics for ordinary controls;
- coherent local SVG icon family;
- responsive composition without DOM reparenting;
- accessibility and reduced-motion parity from the start.

## 6. U1-D is an internal design gate

The manager produces one recommended coherent direction after U1-R, token work, primitive qualification and
actual browser rendering. It may explore alternatives internally, but removes rejected variants before the
main review branch.

U1-D passes when the manager records:

- direct comparison to the U1-R observation matrix;
- 1440 and 390 light/dark, long RU/EN, useful/loading/degraded states;
- hierarchy, typography, density, spacing, surfaces, actions and pane behavior;
- keyboard/focus/scroll/CSP/accessibility evidence;
- why the result is not generic shadcn/admin and not a NotebookLM pixel copy;
- remaining risks and the chosen fixes.

U1-D does **not** stop the program or ask the owner to approve internal libraries, tokens or screenshots. After
it passes, the manager continues to U1.5 and U2.

## 7. U2-X is an independent internal usability audit

A fresh-context agent or tester who did not implement the screen performs the no-hint journey:

```text
project → add/select source → ask question → open exact citation/evidence
→ save/open supported artifact → diagnose one Connections problem
```

Record wrong turns, backtracking, accidental scope changes, backend terminology and undiscoverable controls.
Fix failures and rerun. U2-X does not require the owner to interrupt the build and does not block C/U work once
its internal acceptance passes.

## 8. Final owner review

The first required owner UI review occurs after U5-X, when the branch contains:

- complete Sources workflow;
- complete Research and exact Evidence workflow;
- complete implemented Studio workflow;
- truthful Connections workflow;
- responsive desktop/tablet/phone composition;
- representative loading/empty/degraded/error states;
- Storybook, Playwright, CSP, accessibility, performance and visual evidence;
- a safe local or non-production review build with no production effects.

The owner reviews the finished product, not partial token sheets or isolated components. No deployment,
production write, cutover, legacy deletion or final merge follows without separate authorization.

## 9. Mandatory anti-pattern rejection

Reject and repair:

- generic admin dashboard or shadcn-demo appearance;
- excessive cards, pills, borders, gradients, glass or shadows;
- tiny type, weak hierarchy or huge decorative whitespace;
- random color/icon/radius choices;
- nested scrollbars or unexplained scroll surfaces;
- jumping labels/panes during updates;
- technical identifiers in primary UI;
- disabled fake product tiles;
- copied Google branding/assets/text;
- hidden reasoning or fabricated confidence;
- a green test suite with visibly poor composition.
