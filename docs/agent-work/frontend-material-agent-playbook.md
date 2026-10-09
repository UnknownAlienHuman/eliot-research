# Material UI agent playbook — exact operating procedure

**Status:** normative one-stop procedure for ER-47 UI managers and leaves.
**Applies to:** U1-R, U1.2-U1.5, U2, U3-U5 presentation work and every rendered-product review.
**Owner instruction:** implement F1-F4 continuously through U5-X; do not request intermediate aesthetic
approval. The owner reviews one finished integrated interface at FINAL-UI.
**Product reference:** current live Google NotebookLM in an actual browser.
**Design reference:** current official Material 3 and Material 3 Expressive.

This is the first document a UI agent reads after its exact checkpoint. It turns “make it Material” into a
finite workflow with approved sources, exact tools, repository paths, mandatory artifacts and rejection rules.
Do not replace it with random web search, a design-gallery tour, a shadcn demo or personal taste.

## 0. The first ten minutes

For every UI checkpoint:

1. Read the exact row in `frontend-owner-execution-map.md`.
2. Read only the relevant sections of this playbook and the exact product/client contract.
3. Check `@eliotr/ui` catalog and Storybook before creating a component.
4. Confirm the required browser/design tools are available or record the allowed fallback.
5. Open the smallest deterministic story/scenario that proves the requested state.
6. Implement, render, inspect, test, repair and rerun. Do not return a plan and wait.
7. Publish exact evidence and continue to the next dependency-ready checkpoint.

Before U1-R is accepted, do not choose the product palette, typography, pane proportions or shell composition.
Before U1-D is internally accepted, do not assemble the production shell. Before U2-X passes, do not treat a
clickable fixture UI as understandable product UX.

## 1. Source hierarchy — where the agent is allowed to look

Use sources in this order:

1. Current repository contracts and exact checkpoint.
2. Current live NotebookLM opened in an actual browser.
3. Official Material 3 / Material 3 Expressive documentation.
4. Google Design MCP output for color, fonts and Material Symbols.
5. Accepted Eliot tokens, catalog, Storybook stories and product patterns.
6. Exact current backend/client contracts.
7. Third-party primitive documentation only for the one candidate being qualified.

Approved official references:

| Need | Official source |
|---|---|
| Material 3 root | `https://m3.material.io/` |
| Color roles and role pairing | `https://m3.material.io/styles/color/the-color-system` |
| Typography roles and readability | `https://m3.material.io/styles/typography/applying-type` |
| Canonical adaptive layouts | `https://m3.material.io/foundations/layout/canonical-examples/overview` |
| Components | `https://m3.material.io/components/` |
| Motion physics / standard vs expressive | `https://m3.material.io/styles/motion/overview/how-it-works` |
| Material 3 Expressive design notes | `https://design.google/library/design-notes-material-3-expressive-liam-spradlin` |
| Design MCP overview | `https://developers.google.com/design-mcp/overview` |
| Design MCP tools and endpoint | `https://developers.google.com/design-mcp/reference/mcp` |
| Design MCP Inspector | `https://developers.google.com/design-mcp/inspector_guide` |
| Chrome DevTools MCP setup | `https://developer.chrome.com/docs/devtools/agents/get-started/configuration` |
| Active authenticated Chrome session | `https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session` |
| Storybook AI/MCP | `https://storybook.js.org/docs/ai` |
| Storybook MCP API | `https://storybook.js.org/docs/ai/mcp/api` |
| Playwright visual comparison | `https://playwright.dev/docs/test-snapshots` |
| Playwright accessibility | `https://playwright.dev/docs/accessibility-testing` |
| Playwright codegen | `https://playwright.dev/docs/codegen` |
| shadcn registry MCP | `https://ui.shadcn.com/docs/registry/mcp` |
| shadcn GitHub registry | `https://ui.shadcn.com/docs/registry/github` |

Do not use Dribbble, Behance, ThemeForest, random Tailwind dashboards, third-party “Material” kits, AI design
galleries, Medium posts or Figma community files as visual authority. They may be inspected only for a narrowly
named implementation problem after official sources and repository patterns fail, and they never define Eliot.

The external architecture note that recommended React 19 + Vite + Tailwind + shadcn is an input, not product
authority. Its three-area Sources / Research / Studio concept is retained; its proposed chain-of-thought UI,
mandatory Hono/Agents rewrite and unsupported generators are not.

## 2. Tool bootstrap — exact setup and fallback

Tool installation is not permission to change the production dependency graph. B-U pins repository packages.
The commands below configure agent-side tools or describe the U1.4 setup that the manager must implement with
pinned workspace versions.

### 2.1 Google Design MCP

Public endpoint:

```text
https://design.googleapis.com/mcp
```

Codex configuration:

```bash
codex mcp add google-design --url https://design.googleapis.com/mcp
codex mcp list
```

Direct config alternative:

```toml
[mcp_servers.google-design]
url = "https://design.googleapis.com/mcp"
```

Probe without modifying the repository:

```bash
npx @modelcontextprotocol/inspector https://design.googleapis.com/mcp
```

Required tool sequence for U1.2:

1. `generate_color_scheme` from the approved Eliot key color proposal.
2. `search_fonts` for web with English Latin and Russian Cyrillic support.
3. `describe_font` for every shortlisted family.
4. `search_icons` with at least three semantic tags per icon role.
5. `icons_instructions` before choosing the delivery method.

Design MCP output is a proposal. The agent commits deterministic roles and evidence; it does not generate a new
runtime palette on each load and does not add a remote font or icon CDN.

If Design MCP is unavailable, use the official Material baseline and record the tool as `PENDING`. Do not invent
colors, fonts or icons and do not browse random palettes. Design MCP unavailability alone is not permission to
stop independent engineering work.

### 2.2 Chrome DevTools MCP and live NotebookLM

Codex local server:

```bash
codex mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --autoConnect
codex mcp list
```

On Windows, the stable project configuration is:

```toml
[mcp_servers.chrome-devtools]
command = "cmd"
args = [
  "/c",
  "npx",
  "-y",
  "chrome-devtools-mcp@latest",
  "--autoConnect",
]
env = { SystemRoot = "C:\\Windows", PROGRAMFILES = "C:\\Program Files" }
startup_timeout_ms = 20000
```

For `--autoConnect`:

1. Use current Chrome supporting the feature.
2. Open `chrome://inspect/#remote-debugging`.
3. Enable remote debugging.
4. Keep Chrome open.
5. Approve the explicit Chrome connection dialog.
6. Confirm the controlled-browser banner appears.

Use an empty or non-sensitive NotebookLM notebook. Do not expose unrelated authenticated tabs, credentials,
private source text or customer data. Close private tabs before granting the agent access.

If auto-connect is unstable, start a dedicated Chrome profile and use the documented `--browser-url` or
`--ws-endpoint` connection. Do not repeatedly open fresh browsers and claim the authenticated reference was
studied. After two different connection failures, write a tool failure audit. U1-R is a hard blocker only when
no approved authenticated browser route remains.

### 2.3 Storybook MCP

U1.4 configures Storybook with the exact B-U-pinned versions. Do not run `@latest` against the repository
lockfile. Required configuration:

```ts
// .storybook/main.ts
import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  framework: "@storybook/react-vite",
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-mcp"],
  features: {
    componentsManifest: true,
  },
};

export default config;
```

When Storybook runs on port 6006:

```bash
codex mcp add eliot-storybook --url http://127.0.0.1:6006/mcp
codex mcp list
```

Mandatory first calls for a component leaf:

```text
docs-list
→ docs-show <candidate component>
→ docs-show-story <relevant state when needed>
→ get-storybook-story-instructions before creating/updating stories
→ test-run after implementation
```

Never hallucinate props. If a prop or variant is absent from `docs-show` and accepted stories, it does not exist.
Storybook MCP is a convenience over committed manifests/stories. If MCP fails, use repository files and CLI,
record `PENDING`, and continue; do not create a second component catalog.

### 2.4 Playwright

U1.4 must expose stable repository commands with pinned versions. Target command surface:

```bash
pnpm ui:storybook
pnpm ui:test:stories
pnpm ui:test:browser
pnpm ui:test:visual
pnpm ui:test:a11y
pnpm ui:check:design
pnpm ui:review:receipt
```

Until ER-00 registers root aliases, use the exact package-local commands recorded by U1.4/B-U.

Useful local probes:

```bash
pnpm exec playwright codegen --viewport-size="1440,900" <local-review-url>
pnpm exec playwright codegen --viewport-size="390,844" --color-scheme=dark <local-review-url>
pnpm exec playwright test <exact-spec> --project=chromium
```

Use role/name locators first. Visual baselines use `toHaveScreenshot()` in one pinned Chromium environment.
Never auto-accept changed pixels. A baseline update names the reason, old digest, new digest and reviewer.

Automated accessibility uses `@axe-core/playwright`, but it does not replace manual keyboard, focus order,
zoom/reflow, reduced-motion and screen-reader relationship checks.

For authenticated codegen, use a dedicated test profile or storage state that is gitignored and deleted when no
longer needed. Never commit cookies, IndexedDB, localStorage or NotebookLM account state.

### 2.5 Private shadcn-compatible registry

shadcn is a source donor and registry transport, not the design authority. `@eliotr/ui` owns production code.

The accepted registry contains only reviewed source-owned items, for example:

```text
@eliot/button
@eliot/icon-button
@eliot/text-field
@eliot/source-row
@eliot/research-composer
@eliot/citation-link
@eliot/evidence-inspector
@eliot/workspace-shell
@eliot/material-theme
```

`components.json` points to the Eliot registry, not arbitrary community registries. Agents search and inspect
items before installation. Direct feature imports from public registries are forbidden. A public item is copied
only into an explicit qualification path, reviewed, adapted to tokens/a11y/CSP, then either promoted into
`@eliotr/ui` or deleted.

## 3. U1-R — exact live NotebookLM study

U1-R is product research, not casual browsing. The manager performs it before U1.2.

### Browser procedure

1. Open `https://notebooklm.google.com/` in the approved authenticated Chrome session.
2. Create/open a blank or non-sensitive notebook.
3. Record browser version, viewport, zoom, OS, theme and account-data redaction status.
4. Inspect the notebook/library entry screen.
5. Inspect Sources with empty, populated, selected, long-title and add-source states.
6. Inspect question composer, answer hierarchy, citations and source-scope affordances.
7. Open a citation/source and verify return/focus behavior.
8. Inspect Studio organization and supported artifacts without assuming Eliot supports the same products.
9. Inspect loading, active, empty, degraded and error behavior available without destructive actions.
10. Inspect pane collapse/resize, scroll ownership, sticky regions, focus movement and keyboard traversal.
11. Probe 1440, 1024, 768 and 390 widths where NotebookLM supports them.
12. Inspect light/dark behavior where available.
13. Record what Eliot should retain, reject and improve.

### Required committed receipts

Use ER-47-owned paths:

```text
tests/ui-owner/receipts/u1-r/reference-study.md
tests/ui-owner/receipts/u1-r/observation-matrix.json
tests/ui-owner/receipts/u1-r/screenshot-manifest.json
tests/ui-owner/receipts/u1-r/tooling.json
```

The Markdown study includes:

```text
screen/state
user goal
primary action
information hierarchy
pane model and measured geometry
scroll owner
focus/keyboard behavior
typography roles
surface/color roles
shape/elevation
motion/state treatment
responsive transformation
what Eliot retains
what Eliot improves
what Eliot must not copy
```

The screenshot manifest stores hashes, viewport and redaction metadata. Raw authenticated screenshots remain
private build artifacts unless they are fully redacted, legally appropriate and explicitly accepted for the
repository. Never commit account identifiers or source text.

U1-R fails when the agent uses old screenshots, source-code guesses, a generic component demo or prose-only
Material knowledge instead of the live product.

## 4. Implement Material 3 as code, not decoration

### 4.1 Color

Use semantic roles, never feature palettes:

```text
primary / on-primary / primary-container / on-primary-container
secondary / on-secondary / secondary-container / on-secondary-container
tertiary / on-tertiary / tertiary-container / on-tertiary-container
error / on-error / error-container / on-error-container
surface / surface-dim / surface-bright
surface-container-lowest / low / default / high / highest
on-surface / on-surface-variant
outline / outline-variant
inverse-surface / inverse-on-surface / inverse-primary
```

Pair roles only as Material specifies. `primary` means high-emphasis action/focus/selection, not success,
readiness, evidence support or confidence. Status is never color-only.

Required files:

```text
packages/ui/src/tokens/color.css
packages/ui/src/tokens/color.roles.json
packages/ui/src/tokens/color.contrast.json
packages/ui/src/tokens/ColorRoles.stories.tsx
```

Light, dark and high-contrast values are committed and digest-stable. Feature code contains no raw hex/RGB/HSL,
Tailwind arbitrary color or locally invented status palette.

### 4.2 Typography

Use the Material roles:

```text
display-large / medium / small
headline-large / medium / small
title-large / medium / small
body-large / medium / small
label-large / medium / small
```

Eliot defaults:

- readable non-expressive body face with strong Cyrillic;
- 16-18 px report body and approximately 1.5-1.7 line height;
- about 65-80 characters for long reading;
- display/expressive type only for short high-emphasis moments;
- tabular numerals for changing measurements/status values;
- underlined links with semantic link color;
- no remote font CDN.

Required evidence: English, long Russian, missing-glyph probe, 200% zoom/reflow, font-loading behavior and
fallback metrics. Do not choose a font because it looks good in Latin only.

### 4.3 Surface, elevation and boundaries

Use surface roles and spacing to create hierarchy. Do not draw a border around every group.

```text
page/content background          surface or surface-bright
navigation/secondary region      surface-container
recessive nested region          surface-container-low
high-emphasis temporary region   surface-container-high
menu/dialog/temporary overlay    surface-container-highest
```

Use `outline` for important control boundaries such as text fields. Use `outline-variant` for dividers and
low-emphasis separation. Shadows are for overlays, menus, dialogs and drag previews, not every panel.

Maximum ordinary visual nesting: two container levels. If the agent needs a third card wrapper, it must first
prove why spacing, grouping, divider or typography cannot express the relationship.

### 4.4 Shape

Define one scale:

```text
none / extra-small / small / medium / large / extra-large / full
```

Map shape to function. Inputs/buttons use small/medium; panes/sheets use large; dialogs/hero empty states may use
extra-large; avatars/status dots use full. Do not apply `rounded-3xl` indiscriminately and do not make every
metadata label a pill.

### 4.5 Spacing and density

Use a 4 px base and principal 8 px rhythm. Tokens express semantic use, not hundreds of numbered values:

```text
space-inline-control
space-block-control
space-panel
space-reading
space-section
space-touch-target
```

Source lists may be compact; report reading surfaces breathe; question and evidence flows dominate. Desktop is
not an inflated mobile UI, and mobile is not a squeezed desktop grid.

### 4.6 Motion

Material now distinguishes standard and expressive spring schemes. Eliot uses:

- standard motion for utilitarian research interactions;
- expressive motion only for major spatial transitions, onboarding, Research start/completion and selected
  hero moments;
- spatial tokens for position/size/shape;
- effects tokens for opacity/color;
- no token-by-token streaming animation;
- no spring overshoot on pane resize, tables, status updates or evidence text;
- complete `prefers-reduced-motion` parity.

Motion must explain origin, destination or state change. Decorative continuous motion fails.

### 4.7 Adaptive layout

Start from Material canonical `list-detail` plus `supporting pane` logic:

```text
expanded: Sources | Research/report | contextual Evidence/Studio
medium:   Sources | Research, contextual pane as drawer/sheet
compact:  one primary task per route/sheet with explicit Back behavior
```

Breakpoints change React/CSS composition, not the parent of a mounted feature root. One vertical scroll owner per
pane. Empty context collapses. The phone layout never compresses three desktop columns into tiny panes.

### 4.8 Icons

Use Design MCP `search_icons` and `icons_instructions` for role selection, then commit one source-owned local SVG
family. No icon font, emoji, mixed icon packs, remote CDN or icon without accessible name/context.

### 4.9 Token-to-Tailwind boundary

Tailwind v4 is syntax over committed CSS variables. It does not own the theme.

Target structure:

```text
packages/ui/src/tokens/
  color.css
  typography.css
  spacing.css
  shape.css
  elevation.css
  motion.css
  state.css
  breakpoints.css
  token-roles.json
```

Representative mapping:

```css
:root {
  --md-sys-color-primary: ...;
  --md-sys-color-on-primary: ...;
  --md-sys-color-surface: ...;
  --md-sys-color-surface-container: ...;
  --md-sys-color-on-surface: ...;
  --md-sys-color-outline-variant: ...;
}

@theme inline {
  --color-primary: var(--md-sys-color-primary);
  --color-on-primary: var(--md-sys-color-on-primary);
  --color-surface: var(--md-sys-color-surface);
  --color-surface-container: var(--md-sys-color-surface-container);
  --color-on-surface: var(--md-sys-color-on-surface);
  --color-outline-variant: var(--md-sys-color-outline-variant);
}
```

Exact Tailwind syntax follows the B-U-pinned version. Feature code consumes semantic names only. Arbitrary
values, inline visual styles and feature-local CSS variables fail the design gate unless present in the small
reviewed mathematical-layout allowlist.

## 5. Component implementation algorithm

Before creating or editing a component:

1. Query Storybook `docs-list`.
2. Query `docs-show` for existing candidate components.
3. Inspect relevant stories with `docs-show-story`.
4. Search `packages/ui` catalog/registry.
5. Name the immediate product consumer and exact missing role.
6. Choose native HTML when ordinary semantics are sufficient.
7. For composite behavior, qualify Base UI first; compare React Aria only when the first candidate fails a
   recorded requirement.
8. Implement only consumed variants.
9. Add stories, interaction tests, a11y/CSP checks and catalog metadata.
10. Run `test-run`, then inspect the real story in Chrome.

A component is not accepted without:

```text
stable import and component ID
native/composite foundation and exact version
implemented variants only
semantic tokens consumed
accessible name/relationships/focus contract
keyboard and pointer behavior
CSP result
applicable default/hover/focus/pressed/selected/disabled/loading/error states
long RU/EN and narrow-container evidence when content-bearing
real consumer
known limitations
```

Do not build a generic enterprise kit. U1 foundation is limited to the components required for the shell and U2
journey. A shared component with no immediate consumer is rejected.

## 6. Screen implementation algorithm

For each screen or product pattern, write a small screen brief before JSX:

```text
user goal
one primary action
secondary actions
information hierarchy
source/scope/evidence truth shown
canonical layout pattern
pane and scroll ownership
required states
responsive transformation
keyboard/focus path
what is hidden under progressive disclosure
```

Then:

1. Build the full screen on deterministic fixtures.
2. Use accepted `@eliotr/ui` roles only.
3. Render useful, loading, empty, degraded and error states.
4. Test 1440, 1024, 768, 390 and catastrophic 320 overflow.
5. Test light, dark, high contrast and reduced motion.
6. Test long English and Russian.
7. Inspect console, network, layout, focus and scroll ownership in Chrome.
8. Run Storybook and Playwright checks.
9. Compare to U1-R observation matrix and Material guidance.
10. Reject generic admin/card-soup output and iterate until coherent.

Every state answers:

- Where am I?
- What is selected?
- What is the current scope?
- What is ready/current/unknown/degraded?
- What can I do now?
- Where does the evidence come from?
- How do I recover?

## 7. Mandatory browser self-correction loop

Every visual change uses this loop:

```text
render exact story/route/scenario
→ inspect screenshot and accessibility tree
→ inspect console and network
→ inspect computed layout and scroll owners
→ traverse keyboard/focus/Back behavior
→ run Storybook test-run
→ run scoped Playwright interaction/a11y/visual tests
→ compare with U1-R and committed baseline
→ fix root cause
→ rerun until clean
```

“CSS looks correct,” “tests are green,” “uses Material colors,” DOM snapshot and isolated component polish are
not evidence of product quality.

After two materially different failed approaches, write the required failure audit and change strategy. Examples:

- replace a failing splitter with stable static panes;
- replace a failing composite family instead of mixing libraries;
- reduce a custom control to native semantics;
- remove a container instead of adding a stronger border/shadow;
- correct token mapping instead of adding a feature override;
- split an overgrown product pattern by capability instead of adding another global store/controller.

## 8. Ready-to-dispatch checkpoint envelopes

### U1-R leaf

```text
Open live NotebookLM with approved Chrome access. Execute the full U1-R browser procedure from this playbook.
Write only tests/ui-owner/receipts/u1-r/**. Produce the reference study, observation matrix, screenshot manifest
and tooling receipt. Use no private Eliot/customer data. Do not choose Eliot tokens or implement components.
Mandatory negative: prove old screenshots/component demos were not used as substitute. Stop only when no
approved authenticated browser route remains after two documented recovery approaches.
```

### U1.2 token leaf

```text
Read U1-R receipts and official Material color/typography/motion/layout guidance. Use Google Design MCP in the
required sequence. Implement deterministic light/dark/high-contrast semantic tokens under
packages/ui/src/tokens/** with contrast/Cyrillic/reduced-motion stories and tests. No raw feature literals,
runtime palette generation, remote font/icon CDN or shell composition. Mandatory negative: seeded raw visual
literal fails the design check.
```

### U1.3 primitive leaf

```text
Use Storybook docs/catalog first. Implement one named consumed primitive or one bounded composite qualification
under its exact path. Native semantics first; Base UI first composite candidate; React Aria only as recorded
fallback. Add stories, interactions, keyboard/a11y/CSP evidence and catalog metadata. Mandatory negative:
undocumented prop, second primitive family or failed focus/CSP behavior rejects the candidate.
```

### U1.5/U2 screen leaf

```text
Read the exact screen brief, U1-R matrix, accepted tokens/components and fixture/client contract. Build all named
states, responsive transformations and keyboard/focus behavior. Inspect in Chrome, run Storybook test-run and
scoped Playwright interaction/a11y/visual tests, repair failures and publish exact evidence. No direct fetch,
legacy CSS, random design literal, nested generic scroll area, technical ID in primary UI or fake unsupported
action.
```

## 9. Rejection checklist

Reject the change when any answer is yes:

- Does it look like a generic shadcn sample or admin dashboard?
- Is hierarchy being created mainly with cards, borders, shadows or pills?
- Does feature code contain arbitrary color, radius, spacing, z-index, font size or animation?
- Was a third-party component used without Storybook/catalog inspection and qualification?
- Are there multiple primitive, icon, state, styling or scroll authorities?
- Does a phone layout squeeze desktop panes instead of changing composition?
- Is there more than one vertical scroll owner in a pane?
- Do labels/panes move when progress updates?
- Is `primary` being used to imply truth, readiness or success?
- Is status communicated by color alone?
- Are private IDs, hashes, traces or raw provider errors in the primary UI?
- Is unsupported functionality represented by decorative disabled cards?
- Was a visual baseline auto-accepted?
- Is the screen only tested in a happy state or one viewport?
- Did the agent claim completion without actual browser evidence?

## 10. Required receipt

Every accepted UI checkpoint publishes:

```text
checkpoint, claim and predecessor identities
source commit and dirty-state check
exact dependency, Storybook, browser and OS versions
U1-R observations used
Design MCP calls/output digests when applicable
components/catalog/stories/scenarios changed
viewports/themes/locales/content lengths rendered
commands and exit statuses
mandatory negative result
console/network/CSP/a11y/focus/scroll findings
screenshots and baseline digests
performance/bundle evidence when applicable
known limitations
PENDING native/staging/live/release gates
```

The receipt contains no source/evidence text, prompts, cookies, credentials or provider payloads.

## 11. Manager launch instruction

```text
Act as the Eliot owner-web manager. Read the exact execution-map checkpoint and
frontend-material-agent-playbook.md before any UI action. Use one manager worktree and bounded leaves; no leaf
creates a branch/worktree/shared manifest/barrel/framework.

Execute F1-F4 continuously through U5-X. First establish the React/Vite/Cloudflare foundation, then perform U1-R
by opening the current live NotebookLM in an approved authenticated Chrome session. Use current official
Material 3 / Material 3 Expressive and Google Design MCP. Build one source-owned @eliotr/ui system, not a generic
shadcn/admin dashboard and not a Google pixel copy.

For every component, query Storybook manifests/docs before use. For every screen, render deterministic states in
a real browser, inspect console/network/layout/focus/scroll, run Storybook and Playwright checks, compare to U1-R
and repair failures. Do not ask the owner to choose reversible implementation details or approve U1-D/U2-X.
After two failed approaches, write a failure audit and change strategy.

Stop only for a genuine authority/security/ownership conflict, unavailable required authenticated browser after
recovery attempts, unauthorized production/account/irreversible action, or FINAL-UI after the complete U5-X
review build is ready.
```
