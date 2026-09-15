# S52 — Keep generation A serving until B is verified and promoted

Baseline: `a2aca127`; ER-05/16/38. The existing managed-generation registry/provisioners are required by the architecture. Do not remove them or reimplement AI Search internals.

## 1. Problem

uploadAndPoll or a Queue ACK does not establish complete or activated indexing. Initial indexing and reindexing must start from canonically admitted sources, not preseeded index fixtures.

## 2. Required change

Complete source admission → outbox → D1 IDENT/LEX and managed projection → per-channel readiness, plus A → shadow B → verified expected-head switch → rollback A. Connect existing stores/consumer/promoter; do not create another registry.

## 3. Documentation and exact search anchors

[Architecture, sections 6.4.2 and 19.10](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 6.4.2. Embedding generation migration' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Project stable sections, context headers, and maps. Shared project membership creates only permitted projection copies within the authorized residency. Freeze item manifests/counts/digests and generation configuration. A remains serving and queries pin it while B is incomplete. Promote B only after exact readback, completeness, and required Golden/latency/cost evidence under existing policies. Never mix raw vector scores across generations.

Failed/cancelled migration cannot switch the head; concurrent promotion uses CAS. Source updates/purge during construction must be reconciled against current watermarks/denials before activation so erased influence cannot return. Retain old generations according to the existing rollback policy, not indefinitely.

## 5. Acceptance criteria

- [ ] Actually imported sources become available through IDENT/LEX/SEM; stale or partial channels are explicitly degraded.
- [ ] Incomplete or foreign-item B cannot become ACTIVE. Lost upload/switch ACK and restart converge on one head winner.
- [ ] A continues serving during B construction; rollback preserves current purge state.
- [ ] Record local storage/controlled-platform lifecycle tests and exact SHA.
- [ ] Native AI Search item/readback/promotion/performance receipts are obtained separately after authorized staging. No new quota or financial subsystem is introduced.
