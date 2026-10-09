# Eliot owner web UI — normative design and interaction specification

**Status:** normative for the replacement owner workspace defined by
[ADR-0016](../adr/0016-react-cloudflare-owner-ui.md).

**Ownership:** ER-47 for `apps/eliotr-web`, `packages/ui`, and bounded UI tests/scripts.

**Does not apply to:** backend authority, public documentation sites, or isolated `/agent-inbox/` transport
except where it consumes approved non-private visual primitives.

## 1. Product character

Eliot Research is a professional research workspace. It should feel:

- calm rather than decorative;
- highly legible during long reading sessions;
- dense enough for serious work without becoming an operator console;
- contemporary Material 3 with selective expressive emphasis, not a generic admin dashboard;
- explicit about uncertainty, evidence, currentness and recoverable failure;
- consistent in English and Russian;
- stable under progressive updates, long reports and large source lists.

“Beautiful” means stable hierarchy, disciplined spacing, deliberate typography, exact states, coherent motion
and a recognizable product identity. It does not mean glass panels, gradients on every block, excessive pills,
hero whitespace or animation on every event.

A technically consistent collection of shadcn components is not automatically a design. Eliot first studies
the current live NotebookLM and official Material 3 / M3 Expressive in a browser, then builds one distinct
composition language. U1-D is an internal manager gate; the owner reviews the complete U5-X product.

## 2. Information architecture

Permanent destinations:

1. **Sources** — projects, selection, import, reading, versions and readiness.
2. **Research** — question, scope, public execution progress, report and citations.
3. **Studio** — saved reports, Wiki material and supported artifact operations.
4. **Connections** — server, owner authorization, model/transport/client checks and diagnostics.

Corpus Lens/Atlas are capabilities inside Sources. Exact evidence is contextual to a selected claim/citation,
not a permanent empty destination. Studio is a destination, not a permanent third-column dumping ground.

## 3. Workspace composition

At wide desktop widths Research uses three coordinated panes:

```text
┌────────────────┬────────────────────────────────────┬──────────────────┐
│ Sources        │ Research / document / report       │ Context/evidence │
│ 280–360 px     │ min 560 px, flexible               │ 340–420 px       │
└────────────────┴────────────────────────────────────┴──────────────────┘
```

Rules:

- Sources and Context may collapse; center content remains usable.
- Each pane has exactly one vertical scroll owner.
- Headers align and do not create independent nested scroll surfaces.
- Empty Context collapses or shows one compact instruction, not a permanent blank column.
- Opening evidence changes Context content, never parent/ownership of Sources.
- Responsive composition never reparents a live feature root.
- Pane sizes persist only as bounded, schema-versioned, non-private preferences.
- Feature code depends on `@eliotr/ui` pane contracts, not a third-party splitter.

Any splitter must pass exact-version keyboard/ARIA, screen-reader, touch, collapse/focus, remount, responsive,
performance and CSP qualification. Until then resize is not accepted. A stable non-resizable layout is better
than a broken draggable one.

At compact desktop/tablet, Context becomes a bounded drawer/lower sheet and Sources becomes a drawer as
needed. At phone widths destinations are routes/sheets with explicit Back behavior; the desktop grid is not
compressed into miniature columns.

## 4. Navigation and URL model

- Destination, project, source and authorized run/report identities may use validated URL segments when
  Back/Forward and deep links are product behavior.
- IDs in URLs are references, never authorization.
- Prompts, excerpts, evidence handles, receipts, tokens, secrets and unsaved content never enter URLs.
- Back closes the most local context first: evidence → reader/report → destination.
- Navigation never silently changes Research scope/source selection.
- Reload re-reads authorized state; it does not restore protected bytes from browser storage.
- A visible destination change preserves understandable location and focus; it does not simulate a desktop
  window manager.

## 5. Material 3 roles

The design system exposes semantic roles, never feature-specific colors:

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

Status is not color-only. Every meaningful state includes icon/shape, label and, where relevant, observed
time/source.

Examples:

- `Ready · checked 14:32`
- `Waiting for model configuration`
- `Authorization changed`
- `Sampled search · completeness unknown`
- `Complete scope · receipt verified`
- `Client call observed · 12 min ago`
- `Status unavailable`

Primary/blue means action, focus or selection—not truth, evidence support or successful execution.

### Deterministic token sets

Light, dark and high-contrast roles are authored, reviewed and digest-stable. Runtime palette generation is
not visual direction. Material color utilities, when used, run at build/design time and produce committed role
values plus contrast evidence.

### Shape and elevation

- small controls: 8–12 px radius;
- cards/dialogs: 16–24 px;
- primary buttons may use pill shape;
- not every metadata label is a pill;
- nested surfaces reduce radius/elevation instead of stacking floating cards;
- shadows belong to temporary overlays, menus, dialogs and drag previews;
- ordinary lists/articles use tonal surfaces, spacing and dividers.

### Spacing and density

Use a 4 px base and principal 8 px rhythm. Feature code consumes semantic tokens. Ad hoc values and Tailwind
arbitrary-value escapes are prohibited unless reviewed/tokenized.

Density is task-specific: source lists may be compact; reading surfaces breathe; primary question and evidence
flows remain visually dominant. “More whitespace” is not a substitute for hierarchy, and “professional” does
not mean compressing everything into an operator console.

## 6. Typography, icons and localization

Primary UI typeface is an approved variable sans stack with strong Cyrillic support. Start with Inter Variable
or system stack only after glyph/loading verification. No font binary is committed for an experiment.

| Role | Typical use |
|---|---|
| display/title-large | page/workspace title, sparingly |
| title-medium/small | pane and section headings |
| body-large | report/document reading |
| body-medium | ordinary interface copy |
| label-large/medium | controls and navigation |
| label-small | timestamps and secondary metadata |
| code | identifiers, hashes and code only |

Reading measure is about 65–80 characters. Reports/documents use 16–18 px text and 1.55–1.75 line height.
Technical IDs wrap in diagnostics and never widen the reading column.

Use one source-owned SVG icon system. No emoji, Unicode pseudo-icons, icon font, mixed icon packs or external
CDN. Icons never replace accessible names.

English/Russian copy uses a typed message catalog once application copy exceeds U1 shell. Tests cover 30–50%
expansion, plural/date/number formatting and long project/source titles. Protocol values are not translated.

## 7. Component catalog, native semantics and delivery tiers

The catalog below is an allowed vocabulary, not an instruction to implement everything in U1. `@eliotr/ui`
owns a role only when an accepted slice requires it.

Native HTML semantics are the first choice for ordinary button, input, checkbox, link, heading, list, details
and form behavior. An external primitive foundation is used for composite interactions where it adds verified
focus/ARIA/positioning behavior. “One primitive family” means one external composite foundation, not wrapping
all native elements or mixing libraries component-by-component.

### U1 foundation kit

- Button / IconButton
- TextField / SearchField / TextArea
- Checkbox
- Tabs or selected navigation primitive
- Dialog / Drawer foundation
- Menu / Popover / Tooltip only where shell requires them
- Progress / Skeleton
- StatusIndicator
- Surface / Divider
- native Pane scroll contract
- PaneGroup / Pane / PaneHandle abstraction, initially non-resizable if qualification is incomplete
- EmptyState / ErrorState / AccessDeniedState
- SafeMarkdown foundation only when U2 content needs it

Every item receives only variants/states consumed by active slice. Do not build a generic enterprise kit.

### Later primitives, on demand

- Select / Combobox / Radio / Switch
- NavigationRail / NavigationBar
- BottomSheet
- Snackbar
- SplitButton
- DataTable
- VirtualList
- ReadingTableScroll / CodeBlock

### Product patterns, by feature slices

- WorkspaceShell
- ProjectPicker
- SourcesPane / SourceRow / SourceSelection
- ImportFlow / RevisionHistory
- DocumentReader
- ResearchComposer
- PublicExecutionTimeline
- ResearchReport / ReportSection
- CitationLink / ClaimSelection
- EvidenceInspector
- StudioLibrary / WikiEditor shell
- ConnectionSummary / DiagnosticDisclosure
- PermissionChangedBanner
- OfflineBanner / StaleGenerationBanner

A feature reuses accepted patterns or proposes a small addition with stories/tests. Copying a primitive into a
feature is not faster implementation. Unused components added to “finish the design system” are overengineering.

## 8. Scroll contract

`ScrollArea` is a behavior contract, not permission to replace native scrolling.

- Pane/list scrolling uses native CSS overflow and platform scrollbars by default.
- No custom skin, hidden scrollbar, wheel interception or synthetic physics without measured reason.
- Generic cards never receive `overflow:auto`.
- Tables, code and excerpts may have named local horizontal scroll only.
- Virtualization follows measured need and preserves focus, selection, set semantics, screen-reader behavior,
  restoration and deterministic tests.

This prevents legacy nested/unexplained scroll surfaces.

## 9. Sources experience

The default Sources screen answers:

- Which project am I in?
- Which sources are selected for the next question?
- Which document am I reading?
- Is it captured, admitted, current and search-ready?
- What action is available now?

Import, admission, conversion, indexing and evidence readiness remain distinct. A document row prioritizes
title/type, selection, actionable state, freshness/version warning and then details. IDs/generations/receipt
references live under Technical details.

Small lists render normally. Large lists use bounded pagination first. A qualified virtual list appears only
when measured data proves ordinary rendering insufficient.

## 10. Research experience

The first action is the question. Scope/product controls and one primary action are adjacent and understandable
without architecture knowledge.

Public progress may show accepted request, selected scope, retrieval, evidence resolution, allowed model/tool
activity, verification, report materialization, waiting/degraded/budget-stopped/failed state and recovery.

It never displays hidden chain-of-thought, private scratchpads or raw prompts. Compact public rationale may
explain visible evidence/limitations. Running work does not move unrelated headers, labels or pane geometry.
Duplicate/reordered/gapped events never invent completion; polling/readback remains valid baseline.

## 11. Report, citation and safe content

A report opens before every section body is loaded.

- First useful section may load immediately.
- Remaining sections load on explicit open/bounded viewport demand.
- Concurrent reads are limited and deduplicated by exact identity.
- Each section preserves loading/error/authorization/currentness state.
- Citation markers are stable controls with accessible claim context.
- Selecting citation highlights exact claim and opens excerpt, context, revision, coordinate quality and
  verification state.
- Hashes/handles/traces are diagnostic details.
- Missing native coordinates never create page numbers.
- Source availability and semantic support remain separate.
- Full export verifies all manifest sections/citations; viewport visibility is not completeness.
- Exact byte ranges are accepted only when bound to the admitted revision and one strong immutable
  representation validator; transformed/mismatched bytes fail closed.

Source/report/Wiki markup is untrusted. One audited SafeMarkdown pipeline owns it:

- raw HTML disabled by default or explicit allowlist sanitation;
- script/style/event attributes impossible;
- allowed URL schemes validated;
- external links use safe target/rel behavior;
- embedded media/data URLs denied unless separately designed;
- citation controls come from typed data, not parsed arbitrary links;
- code/table overflow stays inside named components.

`dangerouslySetInnerHTML` is forbidden outside audited boundary and requires security review. Primitive/pane/
Markdown output must pass actual production CSP.

## 12. Studio experience

Studio contains only implemented operations, not a wall of disabled generators. Items distinguish draft vs
accepted/published, kind, originating run/scope, current evidence availability and an API-supported action.

“Regenerate section” is not “Edit” unless a versioned command accepts user text and performs copy-on-write,
re-audit and readback. Tiptap or another rich editor is not selected before that command exists.

## 13. Connections experience

Connections separates:

1. Worker/API readiness.
2. Owner session validity.
3. Project permission/grant.
4. Model/provider configuration and qualification.
5. External Google transport configuration.
6. Observed client/agent call.
7. Active Research execution.

Health does not prove agent connection. Configuration does not prove Google action. Historical observation is
timestamped history, not current presence.

First level is understandable status/action; second is safe configuration/observation; third is bounded
code/trace/receipt diagnostics.

## 14. State and copy

- `Unknown` is valid.
- Sampled no-hit is not absence.
- Workflow completion is not claim acceptance/publication.
- Disabled controls explain prerequisites where useful.
- Do not repeat same warning in every pane.
- Avoid backend class names/enums/acronyms in primary copy.
- Never display raw provider errors, secrets, telemetry source text or unbounded stacks.

## 15. Motion

- 120–220 ms for local feedback.
- Motion explains spatial change, not decoration.
- Progressive output does not animate every token/event.
- Pane resize has no spring overshoot.
- Honor `prefers-reduced-motion`; information never depends on animation.

## 16. Accessibility

Target WCAG 2.2 AA:

- full keyboard operation and visible focus;
- accessible names/descriptions/relationships;
- 44 px primary touch targets where practical;
- semantic headings/landmarks;
- resizable text without clipping;
- verified token-pair contrast;
- restrained live announcements;
- focus return from dialogs/drawers;
- virtualized-list semantics when used;
- pane separator orientation/value/controls/keyboard/screen-reader behavior.

Color, position and motion are never the only state signal. Library claims do not replace exact browser/AT
qualification.

## 17. Responsive rules

- No fixed viewport height on mobile content that must grow.
- No CSS rule depends on changing an element’s parent.
- Breakpoints alter composition through React/layout contracts.
- Canonical widths: 1440, 1024, 768, 390; probe 320 for catastrophic overflow.
- Touch, keyboard and screen-reader behavior are tested separately from pixel geometry.

## 18. U1-R live reference and U1-D internal visual-direction gate

Before token and shell decisions, U1-R opens the current live NotebookLM in the available authenticated browser
and executes `../agent-work/frontend-notebooklm-material-reference.md`. The study records actual panel,
source-selection, composer, citation, Studio, responsive, focus, scrolling, state, typography, surface, shape
and motion behavior with private-data-free screenshots and measurements.

After U1.4, U1-D renders one coherent Eliot composition with deterministic fixture data at:

```text
1440 desktop and 390 phone
light and dark
long Russian and long English
Sources + question-first Research + contextual evidence
useful, loading and degraded states
```

The manager compares it to U1-R and current Material 3 / M3 Expressive, fixes generic admin/shadcn appearance,
selects one coherent direction, removes rejected alternatives and records the internal decision. A pixel copy
of NotebookLM, token swatches, isolated components or green screenshot tests do not pass. U1-D does not stop
the program; the manager continues to U1.5.

## 19. Storybook and static catalog

Each implemented shared component/pattern has stable CSF stories for applicable default/interactions/disabled/
loading/empty/validation/error/denied/offline/degraded/long RU/EN/light/dark/reduced-motion/container states.

Repository catalog and shadcn-compatible registry remain readable through files/CLI. Storybook MCP/generated AI
manifests may mirror them but are not sole authority. Stories use deterministic fixtures, no production data
and no remote Cloudflare bindings.

## 20. Visual acceptance without combinatorial explosion

1. Stories cover state variants/interactions.
2. Small canonical app set covers 1440/1024/768/390 geometry.
3. Major surfaces get representative light/dark/long-content images.
4. Keyboard/high contrast/reduced motion/Firefox/WebKit/most failures are functional/a11y unless pixels matter.
5. Integrated screenshots prove cross-component contracts only.

Artifacts may include screenshots, Storybook interaction/a11y, Playwright route/keyboard/touch/overflow,
console/CSP/network report, accessibility scan, exact build/binding identity, safe review URL and serialized
staging evidence.

The visual manifest has image-count/byte budget. Baseline updates require explicit review; changed pixels are
never auto-accepted. Worker Preview is neither mandatory for fixture-only work nor sufficient for full-stack
acceptance.

## 21. Internal usability audit and final owner review

U2-X is performed by a fresh-context tester who did not implement the screen:

1. select or create a project;
2. add and select a source;
3. ask a question with understandable scope;
4. open an exact citation and evidence context;
5. save/open one supported artifact;
6. locate and resolve one Connections problem.

Record and repair wrong turns, repeated backtracking, undiscoverable controls, accidental scope changes and
places requiring backend terminology. Repeat until the independent audit passes, then continue automatically
through U3-U5.

The owner is not asked to approve partial tokens, components or fixture flows. The first required UI review is
after U5-X, with the finished Sources, Research, Evidence, Studio and Connections interface, representative
states, responsive layouts and browser evidence. No final merge, deployment or cutover follows without a
separate owner decision.

## 22. Prohibited patterns

- global feature styling outside token/reset foundations;
- CSS specificity escalation;
- inline arbitrary design literals;
- components combining transport, authority, layout and rendering;
- `innerHTML` or unaudited unsafe HTML;
- selector/MutationObserver product state;
- breakpoint DOM reparenting;
- hidden persistent private-data caches;
- multiple composite primitive families after U1 lock;
- replacing correct native semantics merely for library uniformity;
- direct feature dependency on provisional pane library;
- decorative glassmorphism/gradient-heavy dashboard;
- generic shadcn/admin appearance accepted without U1-D;
- permanent empty panes;
- hidden reasoning or fake confidence;
- fabricated PDF pages/coordinates;
- connectivity/completeness/support claims from weaker observations;
- custom decorative scrollbars or nested generic scrolling;
- unused generic components built to appear complete;
- onboarding prose used to excuse an owner-unusable primary journey.

## 23. Historical prototypes

`blue-workspace.html`, `research.svg` and `connections.svg` are historical visual research. They may inform
hierarchy but are not production templates, token authority or permission to preserve legacy Astro/DOM
implementation.
