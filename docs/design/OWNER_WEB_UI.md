# Eliot owner web UI

Selected design and interaction specification for the React/Vite owner workspace. Product purpose comes from the
[manifesto](../architecture/ELIOT_RESEARCH.md); implementation/cutover comes from the
[current plan](../implementation/backend-entrypoints.md) and [frontend cutover](../implementation/frontend-platform-migration.md).
The [UI guide](../agent-work/frontend-material-agent-playbook.md) explains how to apply this design.

## Product character

Eliot is a professional source-grounded research workspace. It is calm, legible for long reading, dense enough for
serious work without becoming an operator console, explicit about uncertainty and evidence, stable during progressive
updates, and coherent in English and Russian.

“Modern” means hierarchy, typography, spacing, exact states, restrained motion and a recognizable product identity.
It does not mean glass panels, gradients everywhere, card/pill soup, tiny type, hero whitespace or copied Google
chrome.

## Information architecture

Permanent destinations:

1. **Sources** — projects, source selection, import, reading, versions and readiness.
2. **Research** — question, selected scope, public progress, report and citations.
3. **Studio** — saved reports, Wiki pages and Inbox proposals.
4. **Connections** — owner/session, model/transport, external-agent and safe diagnostic state.

Corpus Lens/Atlas belongs within Sources. Evidence is contextual to a citation/claim, not a permanent empty
destination. Unsupported future products do not appear as disabled tiles.

## Workspace composition

At wide widths, Research may use three coordinated panes:

```text
Sources (280–360 px) | Research/document/report (flexible, min ~560 px) | Context/evidence (340–420 px)
```

Sources and Context may collapse. Empty Context collapses or shows one compact instruction. Each pane has one vertical
scroll owner; generic cards never scroll. Headers align and nested scrolling is avoided. Opening evidence replaces
Context content without reparenting live feature roots.

At medium widths, supporting content becomes a drawer/sheet. At phone widths, one primary task is shown per
route/sheet with explicit Back behavior. The desktop grid is never squeezed into miniature columns. Probe 1440, 1024,
768, 390 and catastrophic 320 overflow.

Destination/project/source/run/report IDs may be URL references when Back/Forward/deep links are product behavior.
They are never authorization. Prompts, excerpts, citations, tokens, secrets and unsaved text do not enter URLs.

## Visual system

Use semantic roles, never feature palettes:

```text
primary / on-primary / primary-container / on-primary-container
secondary / tertiary
surface / surface-dim / surface-bright
surface-container-lowest / low / default / high / highest
on-surface / on-surface-variant
outline / outline-variant
error / on-error / error-container
inverse-surface / inverse-on-surface
```

`primary` means action, focus or selection—not truth, evidence support, readiness or success. Status always has text
and, where useful, icon/shape/time/source; it is never color-only.

Create hierarchy with typography, spacing and tonal surfaces before borders, shadows or cards. Ordinary lists/articles
use spacing/dividers; shadows belong to temporary overlays. Limit ordinary visual nesting to two container levels.

Use a 4 px base and principal 8 px rhythm. Small controls generally use 8–12 px radii; cards/dialogs 16–24 px; pill
shape is selective. Feature code consumes committed semantic tokens rather than raw color/radius/z-index/spacing
systems.

Reading text is roughly 16–18 px with 1.55–1.75 line height and 65–80 character measure. Use a readable sans stack
with verified Cyrillic and fallback behavior. Technical IDs wrap under diagnostics and never widen the reading
surface.

Use one local SVG icon family; no icon font, emoji, remote CDN or mixed packs. Motion explains spatial/state change:
approximately 120–220 ms for local feedback, no token-by-token animation, no resize overshoot, full reduced-motion
parity.

## Components and layout primitives

Native HTML is first choice for buttons, inputs, checkboxes, links, headings, lists, details and forms. One external
composite primitive family may be used where verified focus/ARIA/positioning behavior is needed. Do not wrap all native
controls or mix libraries component-by-component.

`@eliotr/ui` adds only components/patterns consumed by current screens. It may own buttons/fields, navigation,
dialog/drawer/menu/popover, progress/skeleton/status, surfaces, pane contracts, safe Markdown and the current product
patterns. Later select/combobox/table/virtualization/resizing appears only after a measured caller need and
qualification.

Pane/list scrolling uses native overflow/platform scrollbars. No hidden/custom scrollbar, wheel interception or
synthetic physics. Tables/code/excerpts may have named local horizontal scroll. Pagination precedes virtualization;
virtualization must preserve focus, selection, set semantics, accessibility and deterministic tests.

## Sources

Sources answers:

- Which project is active?
- Which sources are selected for the next question?
- Which document/revision is open?
- Is it stored/readable/search-ready/current?
- What action is available now?

Capture, conversion, admission, readable state and search readiness stay distinct. Rows prioritize title/type,
selection, actionable state and freshness; IDs/generations/receipt details are secondary. Large collections use
bounded continuation before virtualization.

## Research

The question is the primary action. Scope and mode are adjacent and understandable without architecture knowledge.
Ordinary and deep work are visibly distinct.

Public progress may show accepted/queued, preparing, retrieving/reading, generating, saving, waiting/degraded,
budget-stopped, cancelled or failed state plus provisional public text. It never displays hidden chain-of-thought,
private scratchpads, raw prompts/provider frames or model-authored citation authority. Progressive output does not move
unrelated headers, labels or panes. Disconnect is presentation loss, not cancellation or permission to repeat work.

## Report and evidence

A saved report opens useful Markdown, origin/limitations and compact citations without replaying its executor.
Incremental body loading is allowed when bounded and identity-safe.

Citation markers are stable accessible controls. Selection highlights the relevant claim and opens the exact retained
source revision/range with useful context and availability/currentness. Source availability, exact excerpt matching
and semantic support remain separate. Missing coordinates never invent page numbers.

Source/report/Wiki markup is untrusted. One audited SafeMarkdown pipeline owns it: raw HTML disabled or strictly
sanitized, scripts/styles/event attributes impossible, URL schemes validated, external links safe, typed citations
not parsed from arbitrary links, code/table overflow contained. No unaudited `innerHTML`.

## Studio, Wiki and Inbox

Studio shows implemented saved-report, Wiki and Inbox operations only. A report is usable without an acceptance badge.
Inbox clearly presents proposal source/target/head and the owner decisions: accept unchanged, edit-and-apply, reject.
Direct owner Wiki edits bypass proposal ceremony and create one full expected-head revision.

A model may prepare text; only the owner applies a Wiki change. Do not label generated prose “verified” merely because
it passed a workflow, review receipt or publication state.

## Connections

Separate:

1. Worker/API availability;
2. owner session validity;
3. project/source permission;
4. model/provider configuration;
5. external transport/client observation;
6. connected-agent task/result state;
7. active research execution.

Health is not an agent connection. Configuration is not proof of a provider/Google action. Historical observation is
timestamped history, not current presence. Primary copy gives understandable status/action; technical traces stay
behind bounded disclosure.

## State and copy

`Unknown` is valid. Sampled no-hit is not absence. Search results are not corpus completeness. Workflow completion is
not truth, report acceptance or Wiki publication. Disabled controls explain a real prerequisite only when useful.
Avoid backend class names/enums/acronyms and repeated warnings in primary UI. Never show secrets, raw provider errors,
unbounded stacks or fabricated confidence.

Use typed localization once product copy warrants it. Test long Russian/English, plural/date/number formatting and
30–50% expansion. Protocol values remain untranslated.

## Browser lifecycle and privacy

Protected source/report/evidence bytes are not persisted in browser storage. On `pagehide`, synchronously apply a
non-private mask, close the lifecycle epoch, abort reads, pause polling and remove protected views. A persisted
`pageshow` remains masked until identity/health/currentness reconciliation.

Sign-out, principal change, revoke and purge clear protected state. Deployment-generation change alone preserves the
same owner's permitted draft/last read with stale indication. Late responses cannot restore cleared state. No root
service worker or private offline cache.

## Accessibility and responsive behavior

Target WCAG 2.2 AA:

- full keyboard operation, visible focus and logical focus return;
- semantic landmarks/headings and accessible names/relationships;
- verified contrast and status not dependent on color/position/motion;
- 44 px primary touch targets where practical;
- 200% zoom/reflow without clipping;
- restrained live announcements;
- reduced-motion parity;
- accessible composite/pane/virtual-list behavior when used.

Keyboard, touch, screen-reader relationships and pixel geometry are tested separately. Breakpoints change
composition through React/layout contracts, never DOM-parent assumptions.

## Acceptance

For a changed journey, inspect the real rendered application with representative useful/loading/empty/stale/denied/
offline/degraded/error states at desktop and phone, light/dark, long RU/EN and applicable reduced-motion/high-contrast.
Check keyboard/focus/Back, scroll ownership, console/network/CSP, safe content and private-data lifecycle. Use
deterministic stories for state coverage and integrated browser checks for cross-component contracts.

A story, token sheet, screenshot, DOM snapshot or green unit suite alone is not acceptance. Visual baseline changes
are reviewed, never auto-accepted. The owner reviews the finished integrated interface; internal reversible choices do
not require checkpoint approval.

## Prohibited patterns

- direct feature transport/database/authority logic;
- multiple routers, clients, design systems or composite families;
- generic shadcn/admin appearance;
- cards/borders/shadows/pills as the main hierarchy;
- feature-local palettes and arbitrary visual literals;
- selector/MutationObserver product state or breakpoint reparenting;
- nested generic scrolling/custom decorative scrollbars;
- hidden persistent private-data caches or root service worker;
- technical IDs/raw errors in primary UI;
- permanent empty panes and fake unsupported actions;
- hidden reasoning, fabricated coordinates/confidence/completeness;
- unused generic components built to appear complete;
- copied NotebookLM branding/assets/text.
