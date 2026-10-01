# S68 — Complete Research Steward without autonomous data mutation loops

Baseline: `a2aca127`; ER-33/24. Reuse packages/research/src/steward.ts, scheduled handling, and observability; do not create another persistent agent.

## 1. Problem

The system needs to detect stale dependencies, stuck outbox work, hash inconsistencies, and overdue purge. Steward must not repeatedly rewrite documents or grant itself permission.

## 2. Required change

Connect ER-33's deterministic checks to a bounded scheduled pass and owner-visible findings. Semantic revalidation/QueryHint proposals remain candidates triggered explicitly, with verifier and Golden replay before policy promotion.

## 3. Documentation and exact search anchors

[ER-33: Required implementation and Acceptance](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-33-research-steward.md).

```sh
git grep -n -F 'Turn retrieval feedback into versioned QueryHint/policy generation followed by Golden replay.' -- docs/agent-work/ER-33-research-steward.md
```

## 4. Implementation approach

Each pass reads a bounded page of current hashes/readiness/handles/watermarks/outbox/DLQ/backup/purge/routes/usage and persists cursor/findings using existing operation identity. Do not scan the whole corpus in one Worker invocation. Repeated triggers do not repeat settled model calls; unchanged state does not generate unsolicited improvements.

Hints/policy generations change through existing policy/verifier paths, not direct Steward mutation. Erasure issues go to the existing operator path, not automatic hard deletion. An unavailable observation remains unknown/degraded rather than healthy or permission-changing.

## 5. Acceptance criteria

- [ ] Stale Wiki produces a revalidation candidate with exact dependency/trigger/owner, not a new published head; unchanged passes make zero semantic calls.
- [ ] Outbox/DLQ/backup/purge/route failures appear in diagnostics; replay/restart does not duplicate findings/effects.
- [ ] Embedded instructions cannot alter scope/tools/policy; Steward cannot auto-publish D2/D3, hard-delete, or broaden grants.
- [ ] QueryHint cannot activate before Golden comparison; negative replay preserves the previous generation.
- [ ] Record actual scheduled/D1 tests and exact SHA/results.
