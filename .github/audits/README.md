# Audit evidence

Current product decisions live in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Audits are dated evidence and limitations; they are not an approval programme,
parallel specification or claim that code has been repaired.

## Current review

[2026-10-21/22 — PR #414 replacement architecture audit](2026-10-21/README.md)

The review compares the original Claude draft, two corrected revisions, executable legacy code, official Cloudflare
APIs and selected donors. The third pass identifies and resolves missing outgoing MCP, fragile whole-document citation
mapping, invalid large-scope rank merging, lost Corpus Map/audit functions, duplicated billing controls, insufficient
research metadata and premature one-index/tokenizer assumptions.

The current documents specify the replacement. Runtime implementation, live migration and measured product quality
remain future work.

## Historical evidence

| Reference | Use |
|---|---|
| [2026-10-17 audit reconciliation](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-17/README.md) | Verified/fixed/stale/unverified issue #380 findings at that baseline |
| [2026-10-08 code integrity audit](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-08/CODE-INTEGRITY-AUDIT.md) | Earlier concrete defects and reproduction context; not current status |
| [Full prior audit archive](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits) | Original reports/evidence at pinned legacy main |
| [Issue #380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) | Owner's architecture/code-quality audit and measured legacy hot-path evidence |
| [Issue #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) | Live-product priorities and cancellation of custom index/generation/Rust programmes |
| [Original PR #414 draft](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8) | Exact Claude draft before review |
| [Prior product documentation](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/docs) | Historical capabilities and useful implementation ideas for bounded import |
| [Old donor catalogue](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md) | Wider research history; active selections are in current DONORS |

## Recording future findings

A useful finding names the inspected commit/API version, exact code or primary documentation, observed behavior,
user impact and owning correction. Separate present defect, design risk, fixed historical finding and unmeasured
hypothesis. Put the change in the owning document/code instead of creating another registry, certification packet,
claim file, gate or execution diary.
