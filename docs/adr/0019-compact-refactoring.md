# ADR-0019: Delete superseded mechanisms, retain the product

Updated 2026-10-17 under the owner's explicit simplification direction. The selected design is in
[ELIOT_RESEARCH.md](../architecture/ELIOT_RESEARCH.md); implementation and deployed acceptance remain open.
[The plan](../implementation/backend-entrypoints.md) is the only current work queue.

## Problem

The old specification made discarded prototypes, protocol generations, signed/digested control records,
package ownership and all-family Rust ports into permanent obligations. A short exception table above
that specification still sent agents back to the same requirements. Adding another adapter did not remove
its predecessor. The earlier source inventory counted 283,671 authored application/library lines;
that is a dated maintained-source measure, not deployed bundle size or a dead-code count.

## Decision

Keep the five owner paths from [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377),
Library/Lens/Wiki, normal downloads and explicit deep research. Keep one Worker, React/Vite and the
existing TS/Rust/SQL stack. There is no mandated 17-crate topology or requirement to port every rule.

Retire custom search generations/promotion, bilateral source-owner transfer, general federation machinery,
seven-domain residency keys, unselected Drive Exchange and backup/restore execution from the selected
product. Keep the simple external task/MCP interfaces actually used by connected agents. Reachable code
is not necessarily required code. Existing selected consumers must move before their old route is removed.

No bespoke cryptosystem, signed proof chain, universal canonicalization envelope or per-list verification
pipeline. Retain ordinary ingress authentication, secret handling, exact source references and the checksums
that actually identify stored bytes. Local function calls do not need hashed inputs/outputs or policy passports.

Replace internal interfaces in place with their callers. Delete old exports, wrappers, tests/fixtures and
instructions for canceled behavior. Git history is the archive. Keep real content and results through an
ordinary locator or one-time conversion, not permanent historical executors. A running paid attempt needs
settlement; an old completed report does not need its producing Workflow to remain executable.

Unknown live data blocks destructive migration only. Applied SQL migrations need a data-safe transition;
unapplied prototype migrations can be simplified once their deployment status is established. No mass
production reset, secret deletion, automatic migration or branch purge is authorized by this ADR.

## Consequences

Current architecture replaces the long historical full-product document instead of layering exceptions.
The old numbered contracts remain accessible at a pinned Git revision, not a second working-tree copy.
Old packets/ADRs/audit matrices apply only where explicitly retained for a selected current behavior;
they cannot require canceled features, replay compatibility or governance ceremonies.

Ordinary answers prepare once, stream one synthesis and save/cite. Deep research is explicit and shares
those primitives. Reconnect reads the same run/result; a full token-replay journal is not required.
React cutover removes Astro and duplicate clients after caller migration; a rollback artifact is sufficient.

The working source-size objective is below 100,000 application/library lines, not a quota or CI gate.
A smaller bundle, package move, language translation or shorter request path is not itself source reduction.
No net-deletion forecast is claimed before implementing the actual replacements.

One manager/checkout, precise disjoint tasks, ordinary source review. No claim JSON, lineage-only commits,
new status registry or full-repository reread before every edit. Compile/lint and minimal Clippy during
implementation; tests and final acceptance follow the assembled product. Do not promote unrun checks to PASS.

The earlier profile/UI decisions (ADR-0018/0016/0017) retain useful owner behavior and browser cutover
requirements. Any contradictory mandate to maintain unselected legacy systems is superseded here.
