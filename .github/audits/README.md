# Audit evidence

The current product decisions live in [Architecture](../../docs/ARCHITECTURE.md) and
[Implementation](../../docs/IMPLEMENTATION.md). Audits describe a dated baseline and consequences;
they are not a parallel specification, approval programme or claim that code has already been repaired.

## Current review

[2026-10-21 — replacement architecture and PR #414 review](2026-10-21/README.md)
checks the draft against current source, source lifecycle requirements and Cloudflare APIs.
It distinguishes verified source observations from unverified production counts, and records the
preservation requirements carried into the replacement [work map](../../docs/MAP.md).

The revised documents address the draft's design problems. Implementation and real product measurements
are still required; this documentation change does not certify the legacy runtime or deploy a replacement.

## Historical evidence

These immutable links preserve context without keeping superseded programmes as active instructions.

| Reference | Use |
|---|---|
| [2026-10-17 audit reconciliation](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-17/README.md) | Which issue #380 findings were verified, fixed, stale or unverified at that baseline |
| [2026-10-08 code integrity audit](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-08/CODE-INTEGRITY-AUDIT.md) | Earlier concrete defects and their reproduction context; not current status |
| [Full prior audit archive](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits) | Original reports and evidence at the preserved main baseline |
| [Issue #380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) | User-reported complexity and code-quality problems; measurements require baseline/context |
| [Issue #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) | Cancellation of custom-index/generation machinery and return to native Cloudflare retrieval |
| [Original PR #414 architecture](https://github.com/UnknownAlienHuman/eliot-research/blob/42d728716bf0c6ee2450fcee3f9b50cbaed061f8/docs/ARCHITECTURE.md) and [implementation](https://github.com/UnknownAlienHuman/eliot-research/blob/42d728716bf0c6ee2450fcee3f9b50cbaed061f8/docs/IMPLEMENTATION.md) | Exact draft reviewed, before corrections in this PR |
| [Prior documentation](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/docs) | Full historical ideas, contracts, design and migration notes for bounded reference/import work |
| [69-repository donor catalogue](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md), [NotebookLM study](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/notebooklm-donor.md), [EdgeQuake study](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/edgequake-donor.md) | Wider research history; the active selected mechanisms are in [DONORS](../../docs/DONORS.md) |

## Keep findings useful

Name the inspected commit, exact source or primary documentation, observed behaviour and its user impact.
Separate a present defect, a design risk, a fixed historical finding and an unmeasured hypothesis.
Put the resulting change in the owning implementation section or code; do not create another registry,
recertification chain or mandatory audit packet before ordinary development can proceed.
