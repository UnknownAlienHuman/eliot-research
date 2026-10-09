# Frontend agent harness — executable evidence contract

**Product owner:** ER-47
**Client input:** ER-48
**Leaf scheduler:** ER-49
**Root integration:** bounded ER-00 handoffs
**Autonomous manager:** [frontend-autonomous-manager-runbook.md](../agent-work/frontend-autonomous-manager-runbook.md)
**Material UI procedure:** [frontend-material-agent-playbook.md](../agent-work/frontend-material-agent-playbook.md)
**Status:** target specification; no harness tool or test is implemented by this documentation PR.

The harness lets a constrained agent discover one permitted component/state, reproduce it, render it and
publish bounded evidence. It is not a second frontend framework, generic design-management platform, workflow
engine or screenshot factory. Repository files and CLI remain authoritative; MCP is optional convenience.

## 1. Entry conditions

A UI leaf starts only when:

1. the owner lifted the implementation stop for its exact checkpoint or an autonomous tranche containing it;
2. the ER-47 manager context is authorized under branch discipline;
3. before ER-49, no other frontend leaf is active;
4. after ER-49, a claim was committed before source work and history-aware validation passes;
5. package/build work has the required B-U root-registration receipt;
6. predecessor checkpoint commits and manager/external-gate approval references are named;
7. the manager confirms the evidence is substantively accepted—ER-49 checks structure/ancestry, not truth.

A claim, package-local build, screenshot or green component test is not completion evidence.

## Exact agent tool order

The harness implements the commands and MCP sequence defined by the Material UI agent playbook. UI leaves must
query Storybook manifests/docs before component use, use Google Design MCP for U1.2 proposals, inspect actual
rendering through Chrome, and run scoped Playwright interaction/a11y/visual checks. Repository files and CLI are
the fallback when optional MCP transport fails; no second catalog or random design search is created.

## 2. Repository shape

```text
packages/ui/
  src/{tokens,primitives,patterns,content}/
  stories/
  registry/
  catalog/
  design-literals.json

apps/eliotr-web/
  src/{app,routes,features,query}/
  fixtures/scenarios/

tests/ui-owner/
  components/
  flows/
  visual/
  visual-direction/
  accessibility/
  fixtures/
  receipts/

scripts/ui-owner/
  build-catalog.mjs
  check-design-system.mjs
  check-stories.mjs
  check-binding-safety.mjs
  check-screenshots.mjs
  collect-browser-evidence.mjs
  seed-local-explorer.mjs
  print-review-receipt.mjs
```

Exact names may change in U1. Boundaries do not:

- product source owns behavior;
- catalog/registry describes accepted consumption;
- scenarios describe product state, never DOM markup;
- tests execute behavior;
- receipts bind results to source/build/environment;
- ER-49 owns static scheduling validation, not product acceptance;
- ER-00 owns root registration/CI, not component contracts.

Only components needed by an accepted slice enter the catalog.

## 3. Component catalog and primitive policy

Every shared component/pattern has one deterministic entry:

```text
component ID and import path
experimental | approved | deprecated
native semantic or external primitive family + exact version
owner and real consumers
implemented variants/sizes only
accessibility and CSP contract
allowed content/slots
tokens consumed
stable stories/scenarios
known limitations
replacement/deprecation target
```

The catalog fails when an approved component lacks a stable story, names unknown variants/tokens, duplicates a
product role, exports a shared-looking feature primitive, uses deprecated/unapproved foundation, or has no real
consumer/U1 role.

Use native HTML semantics first for buttons, inputs, checkboxes, headings, links and ordinary disclosure when
they satisfy product behavior. “One primitive family” means one external composite foundation for dialogs,
menus, popovers, comboboxes and similar behavior—not wrapping every native element or mixing libraries per
component.

The private shadcn-compatible registry contains reviewed source-owned items. Public registry search is research
only; agents never install arbitrary remote items directly into product paths.

## 4. Token and authored-style gate

`token-roles.json` records deterministic light/dark/high-contrast semantic values. CSS/token source is
authoritative, not screenshots.

Reject unapproved:

- raw color literals;
- Tailwind arbitrary color/spacing/radius/shadow/z-index/font/animation values;
- application-authored inline visual styles;
- hard-coded motion durations/easings;
- raw SVG fill/stroke outside icon/token components;
- direct third-party primitive imports from features;
- global feature selectors or specificity escalation;
- `dangerouslySetInnerHTML` outside audited SafeMarkdown;
- generic `overflow:auto` outside named scroll contracts.

`design-literals.json` is a small reviewed allowlist for mathematical layout relations with path, reason, owner
and expiry/review condition. It is not an escape hatch.

Source lint does not prove dependency CSP behavior. Primitive, popper, pane and Markdown candidates are
accepted only after actual browser output records style elements/attributes, CSP violations, narrow policy and
fallback/rejection decision.

## 5. Story and scenario contracts

Stable CSF stories cover only applicable states:

```text
default / focus-visible / pressed
selected / disabled / loading
empty / validation / server error
offline / denied / stale / unknown / degraded
long RU / long EN / narrow container
light / dark / reduced motion
keyboard and screen-reader relationships
```

Do not multiply every primitive by every state, viewport, theme and browser. Hover-only pixels are usually an
interaction assertion, not a durable baseline.

Story fixtures are deterministic/private-data-free and make no owner API, Cloudflare binding, external font,
analytics or provider request. Storybook does not load the Cloudflare plugin by default.

A product scenario describes typed state:

```text
scenario/version
session and deployment generation
project/source catalog and selected scope
readiness/currentness
run stages/status
report manifest/sections/citations
evidence excerpt/coordinates/verification
connection observations
allowed actions
expected protected-data clearing events
```

Canonical families are added only as slices need them: empty project, shared source, uncertain import,
not-search-ready selection, sampled no-hit, waiting/degraded/failed/completed run, 40-section lazy report,
coordinate quality variants, late response after revoke/purge/generation, Studio states, server-ready without
client observation, measured large list and long RU/EN.

Fixtures pass through strict client/view-model decoders where practical. Impossible authority states are
adversarial and labeled.

## 6. Live NotebookLM reference U1-R and visual-direction gate U1-D

Tokens and isolated components do not define a product. First, U1-R opens the current live NotebookLM in an
authenticated browser and records the reference matrix required by
`../agent-work/frontend-notebooklm-material-reference.md`. Then the manager creates one canonical Eliot
composition story and bounded visual-direction set using deterministic fixture data.

Required review states:

```text
1440 wide desktop + 390 phone
light + dark
long Russian + long English
Sources / question-first Research / contextual evidence
loading, useful content and one degraded state
```

The owner-visible review decides:

- typography and reading measure;
- information density and whitespace;
- surface hierarchy/elevation;
- navigation and pane proportions;
- primary action hierarchy;
- token/primitive visual language;
- whether the product looks like Eliot rather than generic shadcn/admin or a copied NotebookLM skin.

A green visual regression, token swatches, individual attractive components, generic shadcn output or a
NotebookLM pixel copy cannot pass U1-D. The manager records an internal decision, removes rejected alternatives
and continues. Later shell-level changes require a new internal comparison rather than silent baseline
replacement.

## 7. Evidence layers

### A — component

Stories run interaction, accessibility and CSP assertions without Worker startup.

### B — fixture app

Playwright verifies routes, Back, keyboard, focus, responsive composition, scroll ownership, SafeMarkdown,
protected-state clearing, console/CSP failures, unexpected requests and bounded canonical screenshots.

### C — local Vite/workerd

Run only after:

```text
B-U receipt accepted
CLOUDFLARE_ENV=test
remoteBindings:false
normalized input/output contain no remote/production/effectful binding
```

Exercise same-origin API/SPA separation, headers, restart and supported local D1/R2/Queue/DO/Workflow behavior.
Workers AI/AI Search/provider states remain fixtures unless a separately authorized non-production profile is
selected.

### D — safe Worker Preview

Only supported isolated/read paths. Receipt classifies every binding as preview-isolated, dedicated
non-production, shared read-only or unavailable. Any production/effectful binding fails preflight.

### E — serialized staging

Queue-consumer, deployed Workflow retry/resume, Access/OAuth and external-provider behavior. Separately
authorized, budgeted and tied to exact candidate build.

No layer is mislabeled as another.

## 8. Visual evidence

Each approved baseline entry records:

```text
story/route/scenario and why pixels matter
source commit and build digest
browser revision and OS/container
viewport/device scale and locale/timezone
theme/contrast/reduced-motion
font digest
fixture clock/random seed
reviewed masks
baseline digest and approval reference
```

Coverage is layered:

1. stories own state variants;
2. a small app set owns 1440/1024/768/390 geometry;
3. major surfaces get representative light/dark/long-content evidence;
4. keyboard/high-contrast/reduced-motion/Firefox/WebKit/most errors are functional/a11y unless pixels are
   load-bearing;
5. integrated screenshots prove only cross-component contracts.

Rules:

- one pinned Chromium environment owns canonical pixels;
- fonts are ready; caret/clocks/random IDs/animation are controlled;
- masks are narrow and reviewed;
- baseline updates require explicit review and cannot replace U1-D approval;
- image count/bytes are budgeted;
- a new baseline names replaced image or justifies coverage growth.

## 9. Independent usability audit and final owner review

U2-X uses a fresh-context tester who did not implement the screen. The tester completes project, source,
question, exact citation/evidence, supported artifact and Connections recovery without hints. Record wrong
turns, backtracking, accidental scope changes, undiscoverable controls and backend terminology. The manager
fixes failures and reruns the audit, then continues automatically through U3-U5.

The final owner UI review occurs after U5-X on the complete integrated review build. It is not replaced by
Playwright, screenshots or the independent audit, but it no longer interrupts the program at U1-D or U2-X.

## 10. Review receipt

The bounded JSON/Markdown receipt includes:

```text
claim/checkpoint and structurally validated predecessor refs
commit/dirty state/lockfile
exact dependency/browser versions
build/output-config digests
environment and binding disposition
commands and exit statuses
stories/components/scenarios exercised
U1-D manager decision or fresh-context U2-X internal audit reference when applicable
screenshots/diffs and visual-budget delta
accessibility/CSP findings
console errors/unhandled rejections
unexpected failed requests
scroll/focus/keyboard/touch results
design/catalog changes
PENDING native/staging/live gates
```

It excludes source/evidence text, prompts, credentials, cookies and provider payloads. Receipt presence does
not prove its claims; review validates semantic truth.

## 11. Local Explorer

After binding preflight, the helper verifies origin, Worker identity, environment and binding disposition;
seeds bounded D1/R2/DO/Workflow fixtures; reads exact post-state/traces; removes only owned fixture identities;
and never discovers/mutates remote resources. Automated acceptance uses explicit API operations, not Explorer
screenshots.

## 12. Agent workflow

The manager repeats this workflow across every dependency-ready checkpoint in the authorized tranche. A leaf
completion automatically returns control to the manager; it is not a prompt to ask the owner what to do next.
Routine failures are repaired locally. After two failed approaches, the manager records a failure audit and
selects a different approach.

1. **Claim:** commit claim, pass ER-49 history validation, then edit source.
2. **Orient:** read exact checkpoint, affected catalog/story/scenario and client/DTO contract.
3. **Reproduce:** choose smallest failing story/scenario.
4. **Constrain:** declare one affected token/component/pattern and exact paths.
5. **Implement:** reuse approved UI/client boundaries; no direct fetch/global event/design literal.
6. **Inspect:** render actual states; inspect layout/accessibility/CSP.
7. **Verify:** run scoped type/lint/component/flow/design/CSP/visual and applicable C–E layers.
8. **Compare:** review pixels, budget, console/network/focus/scroll.
9. **Internal gate:** complete U1-D or U2-X evidence when required and continue automatically after repair.
10. **Receipt:** publish exact evidence and PENDING gates.
11. **Handoff:** move claim to `HANDED_OFF`; completion remains accepted commit/evidence.
12. **Advance:** select the next dependency-ready checkpoint in the same tranche; stop only at its named human
    gate or a hard authority/security/ownership blocker.

“Looks good,” DOM snapshot, mocked story or claim file is not acceptance.

## 13. CI and merge policy

U1 introduces scoped commands after B-U. ER-00 adds stable commands to root CI only after runtime, flakiness
and artifact size are measured.

Shared UI blockers:

- ER-49 claim/history validation;
- B-U/root registration where applicable;
- typecheck/scoped lint;
- catalog/registry consistency;
- design-literal/primitive-family gate;
- component interaction/a11y/CSP;
- U1-R live reference and U1-D internal acceptance before shell assembly;
- affected fixture flows and fresh-context U2-X audit;
- bounded visual review;
- no unexpected console/network failure;
- exact receipt.

Integrated features add local workerd and strongest supported Preview/staging layer. Full owner browser and
repository/release acceptance remain ordered assembly gates.

## 14. U1 harness exit

Before U2:

- ER-49 checker and one valid prior ER-47 claim are proven, or sequential mode remains explicit;
- B-U registration/exact tool tuple are accepted;
- minimum catalog/private registry builds deterministically;
- native-first policy and one external composite family are locked after a11y/CSP comparison;
- design gate catches seeded violations;
- deterministic Playwright baseline/receipt works;
- screenshot count/bytes are bounded;
- fixture app/SafeMarkdown makes no production request;
- binding preflight catches unsafe config;
- Local Explorer works only after preflight;
- U1-R evidence exists and U1-D canonical direction has manager-recorded internal acceptance;
- MCP-disabled workflow remains usable;
- package/browser versions, runtime/flakiness and limitations are recorded.

No tool, test, package install, browser result, aesthetic acceptance or runtime qualification is claimed by
this document.
