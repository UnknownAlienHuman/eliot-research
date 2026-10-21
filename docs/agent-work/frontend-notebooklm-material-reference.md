# NotebookLM and Material reference

NotebookLM is a design donor, not Eliot's product specification, dependency or mandatory checkpoint. Use it to study
how a source-grounded research workspace makes sources, questions, answers, citations and reusable outputs
understandable. Eliot keeps its own product model, terminology, data boundaries and visual identity.

Current implementation guidance is in the [UI guide](frontend-material-agent-playbook.md) and
[design specification](../design/OWNER_WEB_UI.md).

## How to inspect

When a current live reference can be opened safely, use a blank/non-sensitive notebook and inspect the actual user
journey rather than copying screenshots or DOM structure. Never upload Eliot/private material, expose account data or
commit authenticated browser state.

Observe:

- library/notebook entry and source selection;
- question composition and scope;
- answer hierarchy and citation opening/return;
- source reader and reusable-output organization;
- useful/loading/empty/degraded/error states;
- pane collapse, scrolling, focus and keyboard behavior;
- responsive behavior, typography, surfaces, shape, icons and motion.

Record only the behavior or design principle relevant to the Eliot decision. A measured observation may inform a
choice; it does not become a permanent receipt protocol. When live access is unavailable, use current official
materials and state the limitation rather than blocking unrelated implementation or inventing behavior.

## What Eliot retains

- one obvious research task at a time;
- a stable Sources / Research / Studio mental model;
- source selection close to the question;
- fast movement from answer to supporting material and back;
- calm information density and long-reading comfort;
- clear primary action with restrained secondary controls;
- adaptive supporting panes and progressive disclosure;
- strong typography and disciplined spacing;
- reusable outputs that remain visibly grounded in selected sources.

## What Eliot improves

- distinguish selected scope, historical scope, readable state, search readiness and exact citation;
- make unknown, partial, stale, denied and degraded states explicit;
- provide a stronger citation/evidence inspector without exposing backend proof machinery;
- preserve stable geometry during progressive output;
- support long Russian/English, dark/high-contrast, ultrawide and phone layouts;
- collapse empty supporting panes;
- keep one scroll owner per pane;
- bound large lists/reports and avoid unnecessary initial work;
- provide a distinct Eliot identity rather than a Google clone.

## Material direction

Use current official Material 3 guidance for semantic color, typography, layout, components and motion. Material is a
system of roles and behavior, not permission to reproduce Google branding or wrap the product in cards.

Prefer tonal hierarchy, readable surfaces, native semantics, meaningful shape, a local icon family and restrained
motion. Expressive treatment belongs to a few major spatial transitions or hero moments; ordinary research work stays
stable and quiet.

## Usability review

A reviewer who did not implement the screen should be able to complete without hints:

```text
select/create project
→ add/select source
→ ask a scoped question
→ open exact citation/source
→ save/reopen the report
→ review/apply or reject one Wiki proposal
→ diagnose one Connections problem
```

Record wrong turns, accidental scope changes, undiscoverable controls and places requiring backend terminology; fix
the product rather than explaining around it.

## Reject

Do not copy NotebookLM branding, assets, text, product-specific generators or unsupported operations. Reject generic
admin dashboards, card/pill/border excess, weak hierarchy, tiny reading type, giant decorative whitespace, permanent
empty panes, hidden scrollbars, status-banner duplication, technical identifiers in primary UI, hidden reasoning and
fabricated confidence/completeness.
