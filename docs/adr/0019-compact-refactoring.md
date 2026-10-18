# ADR-0019: Keep the product, remove accumulated machinery

The owner's direction selects a compact single-owner research product and rejects prototype compatibility,
pervasive proof/crypto machinery and development bureaucracy. [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377)
retired the old programme; [#380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) records the audit.
This decision does not claim runtime refactoring or deployment complete.

## Decision

The [product manifesto](../architecture/ELIOT_RESEARCH.md) is the lead developer's persistent context:
purpose, selected behavior, requirements and principles. [Implementation](../implementation/backend-entrypoints.md)
contains the source map, concrete changes, donor choices and removal/integration details. It implements the
manifesto; it is not another architecture or an opportunity to expand product scope.

One current implementation replaces its predecessor. Actual saved content and acknowledged work must
survive deliberate transitions; historical executors, unpublished protocols and hypothetical consumers
need not. No custom cryptographic/proof system, index-promotion platform, bilateral owner-transfer system,
or speculative federation/backup/connector framework is part of the selected product.
Standard authentication, credentials, actual source identity and necessary atomic writes remain.

The former below-100,000-line objective is withdrawn as a design requirement. Counts can reveal growth,
but the decision criterion is whether a mechanism serves selected behavior and whether its responsibility
can be removed or combined. Package moves, language ports, minification and deleting useful capabilities
do not establish simplification. There is no replacement numeric quota or size gate.

## Consequences

Old documents and tests are evidence of their versions, not obligations to retain canceled behavior.
Use Git history for discarded specifications. Do not preserve a second working implementation for an
imagined future client. Do not build a new governance system to enforce this decision.

The five owner journeys, Library/Lens/Wiki, ordinary downloads and explicit deep research remain.
React/Vite replaces Astro; exact citations and existing agent task interfaces remain product behavior.
Implementation decides the safe transition for actual data, running attempts and browser/deploy artifacts.
Unknown deployed data stops its destructive migration, not independent development.

[AGENTS.md](../../AGENTS.md) owns coordination and verification timing. Older profile/UI decisions remain
references for retained behavior; contradictory all-feature, proof, compatibility and ceremony requirements
are superseded. This ADR is the reason for the change, not a duplicate implementation checklist.
