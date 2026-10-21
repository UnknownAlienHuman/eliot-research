# UI implementation guide

Use this for React presentation work. It is not an approval DAG, checkpoint protocol, tool-installation script or
receipt format. Product behavior comes from the [manifesto](../architecture/ELIOT_RESEARCH.md), the
[current plan](../implementation/backend-entrypoints.md), the [UI design](../design/OWNER_WEB_UI.md), the
[delivery map](frontend-owner-execution-map.md) and the actual owner-client/server contracts.

## Sources of truth

Use sources in this order:

1. current product and implementation documents;
2. current source, API contracts, `@eliotr/ui` catalog and accepted stories;
3. the real user journey being changed;
4. current official Material guidance and one qualified component/library reference when needed;
5. [NotebookLM observations](frontend-notebooklm-material-reference.md) as donor evidence, never as Eliot authority.

Optional browser/MCP tools may accelerate inspection. Their absence does not block independent engineering and does
not justify a second catalog, random design search or invented component API. Use committed files and normal browser
tools when an optional integration is unavailable.

## Working loop

For one complete outcome:

1. Trace the real browser action through the owner client and server state. List the useful, loading, empty, stale,
   denied, offline, unknown and failed states that actually exist.
2. Search the existing UI catalog, stories and feature patterns. Add a shared primitive only for an immediate
   consumer and only when native HTML or an existing pattern is insufficient.
3. Write a short screen brief: user goal, primary action, information hierarchy, selected scope, evidence truth,
   layout/scroll owner, responsive transformation, keyboard/focus path and progressive disclosure.
4. Implement the smallest coherent screen/flow with deterministic fixtures, then connect the real client.
5. Render and inspect it in a browser. Check console/network, geometry, scroll ownership, focus, Back behavior,
   long English/Russian, light/dark, reduced motion and representative widths.
6. Run scoped Storybook/Playwright/accessibility checks that cover the changed behavior. Fix the root cause and
   repeat. After two materially different failures, change strategy instead of adding overrides.
7. Remove replaced legacy renderers, CSS, decoders, controllers and unused shared components in the same integration.

Do not stop for approval of reversible implementation details. Review the integrated result; deployment, account
changes and destructive cutover retain their own authorization boundary.

## Visual system

- Use semantic Material color roles and committed tokens. `primary` means action/focus/selection, not truth,
  evidence support, readiness or success.
- Create hierarchy with typography, spacing and tonal surfaces before borders, cards, shadows or pills.
- Use a 4 px base and disciplined 8 px rhythm. Source lists may be compact; reading surfaces need a comfortable
  65–80 character measure and approximately 16–18 px body text.
- Keep one coherent local SVG icon family with accessible names. No emoji/icon-font/mixed-pack/CDN authority.
- Use restrained standard motion for ordinary work and expressive motion only for meaningful spatial transitions.
  Never animate every streamed token or status event; honor reduced motion.
- Responsive layouts change composition, not the parent of a live feature root. Do not squeeze three desktop panes
  into phone-sized columns.
- Each pane has one vertical scroll owner. Use native overflow/scrollbars unless measured need proves otherwise.

Feature code consumes semantic roles. Raw visual literals, feature palettes, arbitrary Tailwind values and local
z-index/radius systems require a concrete mathematical/layout reason and review; they are not the default.

## Components and patterns

Native HTML is first choice for ordinary controls. Use one qualified external composite family only where it provides
needed focus, ARIA or positioning behavior. Do not wrap every native element for library uniformity or mix primitive
families component-by-component.

Shared components implement only variants used by current callers. Every shared addition has:

- a real consumer and stable import;
- semantic tokens;
- keyboard, pointer, focus and accessible-name behavior;
- applicable loading/disabled/error/selected states;
- long-content and narrow-container behavior when content-bearing;
- deterministic stories/tests and known limitations.

Do not build a generic enterprise kit, speculative editor, splitter, virtualizer or rich table. Pagination precedes
virtualization; a stable static pane precedes a poorly qualified resizer.

## Product screens

**Sources** makes project, selected sources, current revision/readiness and next action obvious. Capture, conversion,
admission, readable state and search readiness stay distinct; technical IDs belong under details.

**Research** leads with the question and understandable scope. It may show public phase, provisional text,
limitations, cancellation and recovery, never hidden reasoning, prompts or raw provider frames. Progressive updates
must not move unrelated layout.

**Report/evidence** opens useful Markdown and exact citations. Citation selection opens the retained revision/range and
separates source availability from semantic support. SafeMarkdown and typed citations own untrusted content.

**Studio/Wiki/Inbox** shows only implemented operations and explicit owner decisions. It does not represent future
generators as decorative disabled cards or call model output “verified.”

**Connections** separates Worker/API availability, owner session, project permission, model configuration, external
transport observation and active work. Configuration is not proof of a call; history is not current presence.

## Browser and security boundaries

Browser code does not receive Cloudflare bindings, credentials, prompts, reasoning or database authority. Components
do not call `fetch`, open Agent sockets or duplicate transport decoders. Protected source/report/evidence bytes do not
enter browser persistence. Late responses cannot revive cleared or stale state.

Use native semantics, visible focus, WCAG 2.2 AA contrast, keyboard/touch parity, restrained live announcements,
focus return and 200% zoom/reflow. Color, position and motion are never the only signal.

Source/report/Wiki markup is untrusted. Raw HTML is disabled or handled by the one audited sanitizer; validate URL
schemes and external-link behavior. Typed citation controls never come from arbitrary Markdown links.

## Review evidence

For the affected journey, retain only useful, private-data-free evidence:

- exact build/route/scenario and environment;
- representative desktop/compact/phone states;
- long RU/EN, light/dark and applicable high-contrast/reduced-motion states;
- keyboard/focus/scroll/a11y/CSP/console/network findings;
- actual commands and failures;
- known limitations and environment-dependent checks not run.

A screenshot, story, DOM snapshot, green test suite or Material token file alone is not product acceptance.

## Reject

Reject and repair generic admin/shadcn-demo composition, card soup, repeated status banners, technical IDs in primary
UI, fake confidence/completeness, permanent empty panes, nested generic scrolling, jumping progressive layouts,
custom decorative scrollbars, copied Google branding, unsupported actions, auto-accepted visual changes and shared
components without a current consumer.
