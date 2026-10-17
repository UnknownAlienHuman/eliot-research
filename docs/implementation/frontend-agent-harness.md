# Frontend agent harness — UI evidence contracts

**Authority:** [ADR-0019](../adr/0019-compact-refactoring.md), the [owner execution map](../agent-work/frontend-owner-execution-map.md),
the [Material UI playbook](../agent-work/frontend-material-agent-playbook.md), and the relevant client/product contracts.
**Manager and implementation workflow:** [root instructions](../../AGENTS.md) and [START-HERE](../START-HERE.md).
**Browser tooling:** `scripts/ui-owner/verify.mjs`, exposed by `packages/ui/package.json` scripts.

This document records UI-specific acceptance boundaries. It does not define another scheduler, component framework,
registry or task gate. Old ER-49 claims/checkers are historical audits. Root instructions define exact-path
assignment, scoped compile/lint, and assembled verification timing.

## Component and token boundaries

`@eliotr/ui` owns shared tokens, primitives and patterns; product features own behavior. Use native HTML semantics
for ordinary controls and one qualified external composite primitive family. Reuse an existing shared role before
adding one; do not promote a feature-only abstraction or install unreviewed remote registry code. CSS/token sources
are authoritative. Keep semantic light/dark/high-contrast roles, and do not add arbitrary visual literals or
feature-authored inline styles. Source lint does not prove dependency CSP behavior: qualification uses actual
browser output and preserves CSP.

## Story and scenario contracts

Stories and fixtures cover only states relevant to the slice: interaction/focus, selected/disabled/loading,
empty/validation/error, offline/denied/stale/unknown/degraded, long RU/EN, narrow layout, themes and reduced
motion. Fixtures are deterministic and private-data-free; they make no owner API, Worker binding, analytics,
provider or font-CDN request. Storybook does not load the Cloudflare plugin by default.

Scenarios describe typed product state, not DOM markup. Include session/deployment generation, scope and
readiness, canonical run status, citations/evidence and allowed actions when relevant. Deployment renewal
alone preserves the owner's draft and last known read. On `pagehide`, [ADR-0017 §5](../adr/0017-owner-web-browser-runtime-and-tooling.md)
requires synchronous masking/epoch closure, read abort, and removal of protected Query, report, evidence and
source-byte views; only safe route IDs, permitted non-sensitive drafts, theme and validated pane geometry remain.
Sign-out, principal change, revoke or purge clears affected protected state. Impossible authority states are
adversarial fixtures, not product states.

For research views, keep scope, evidence and answer legible. Where the slice supports it, show available evidence
and warnings distinctly from the answer and make no-results/low-evidence states explicit. The server resolves
citation handles to exact immutable evidence; model-authored IDs or quotes never define evidence identity.

## Live reference, visual direction and usability

U1-R uses the current live NotebookLM in an authenticated browser and the official Material guidance, following
the [reference protocol](../agent-work/frontend-notebooklm-material-reference.md). Do not upload Eliot private
material or expose account identifiers. Record only private-data-free observations and accepted artifacts.

U1-D compares one canonical Eliot composition against those observations at 1440/390, light/dark, long RU/EN,
and useful/loading/degraded states. It must read as Eliot, not generic admin/shadcn and not a NotebookLM copy.
U2-X is a fresh-context no-hint journey through project, source, question, exact evidence, supported artifact
and Connections recovery. Repair material confusion and continue; these internal reviews do not interrupt the
authorized programme. FINAL-UI reviews the complete U5-X interface once.

## Evidence layers

`@eliotr/ui` stories cover component interaction and accessibility. Fixture-app checks cover routes, keyboard,
focus, responsive composition, scroll, SafeMarkdown, protected-state clearing, console/CSP and unexpected
requests. Local Vite/workerd runs require `CLOUDFLARE_ENV=test`, `remoteBindings:false` and a preflight proving
there are no production/effectful bindings. Provider and AI states remain fixtures unless an independently
authorized non-production profile applies. Preview and staging receipts identify each binding's disposition;
staging/external-provider behavior is serialized and authorized separately. No evidence layer stands in for
another.

Keep existing browser verification behavior and commands in `packages/ui/package.json` and
`scripts/ui-owner/verify.mjs` (`browser`, `a11y`, `visual`, `csp`, `receipt`). Browser receipts identify source,
build, browser, fixture inputs and pending native/staging/live limitations. Baselines require review; they do not
auto-accept. Screenshots and receipts exclude source/evidence text, prompts, credentials, cookies and provider
payloads. Mark unavailable native, Preview, staging or live acceptance `PENDING`.

## Local Explorer

The Local Explorer is available only after binding preflight. It uses the expected local Worker/origin and
owned fixture identities, reads bounded exact post-state and traces, removes only its own fixtures, and never
discovers or mutates remote resources. Automated acceptance uses explicit API operations; a screenshot is not
proof of state.

## Final owner review

Present the assembled U5-X product and its applicable behavioral, accessibility, visual, CSP, lifecycle,
binding and performance evidence. Include exact build/environment identity, changed paths, commands and pending
acceptance. Preserve privacy and safe-local/non-production review. The integrated build/deploy bridge and
rollback preparation belong to the authorized refactor; deployment, account mutation and cutover follow the
applicable existing authorization.
