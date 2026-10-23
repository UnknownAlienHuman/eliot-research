# Audit evidence

Current product decisions live in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Audits are dated evidence and limitations; they are not an approval programme,
parallel specification or claim that code has been repaired.

## Current reviews

- [2026-10-23 — retrieval coverage, knowledge freshness and effect recovery](2026-10-23/README.md): fixes partial search
  interpretation, native range use, table context, scoped chat history, transitive/new-source dependencies, card refresh,
  retry/deadline settings, D1 scope bounds, task claims/wake delivery and server draft recovery.
- [2026-10-22 — implementation viability and documentation integrity](2026-10-22/README.md): removes the opaque
  documentation rewrite path and corrects queryable source/page use, replacement-head publication, native
  chunking/keyword defaults, no-tool versus tool-assisted chat, Access topology, public URL acquisition limits,
  broad-discovery ranking, task scope/revision semantics, frozen-scope/tombstone readback, private browser/Markdown
  boundaries, MCP identity/catalogue drift, deletion/third-party-retention boundaries, canonical-entry redirects,
  spend limits and reindex/recovery.
- [2026-10-21/22 — PR #414 replacement architecture audit](2026-10-21/README.md): compares the original draft,
  corrected revisions, executable legacy code, Cloudflare APIs and selected donors; covers retrieval, outgoing MCP,
  Corpus Map/audits, migration, billing and product-function preservation.

The documents specify the replacement. Runtime implementation, live migration and measured product quality remain future work.

## Historical evidence

| Reference | Use |
|---|---|
| [2026-10-17 audit reconciliation](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-17/README.md) | Verified/fixed/stale/unverified issue #380 findings at that baseline |
| [2026-10-08 code integrity audit](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-08/CODE-INTEGRITY-AUDIT.md) | Earlier concrete defects and reproduction context; not current status |
| [Full prior audit archive](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits) | Original reports/evidence at pinned legacy main |
| [Issue #380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) | Owner's architecture/code-quality audit and legacy hot-path evidence |
| [Issue #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) | Live-product priorities and cancellation of custom index/generation/Rust programmes |
| [Original PR #414 draft](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8) | Exact Claude draft before review |
| [Prior product documentation](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/docs) | Historical capabilities and useful implementation ideas for bounded import |
| [Old donor catalogue](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md) | Wider research history; active selections are in current DONORS |

## Recording future findings

Name the inspected commit/API version, exact code or primary documentation, observed behavior, user impact and owning
correction. Separate present defect, design risk, fixed history and unmeasured hypothesis. Put the change in the owning
document/code instead of creating another registry, certification packet, claim file, gate or execution diary.
