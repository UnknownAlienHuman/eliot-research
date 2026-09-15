# S63 — Erase all managed dependencies, not only the original file

Baseline: `a2aca127`; ER-28/34. Inputs: S62/#254 cases and S55/#247 dependency producers. Keep the existing erasure coordinator/closure store as the sole executor.

## 1. Problem

Deleting an R2 original does not remove normalized text, indexes, Wiki/reports, model intermediates, or managed delivery/backup copies. A false PURGED result is more dangerous than explicit incomplete deletion.

## 2. Required change

Complete exact closure enumeration and deletion/redaction across all registered locations, including concurrently produced derivatives. Retention/legal holds use the existing BLOCKED outcome with reason and review date. Document report/provider-log/backup retention independently of JWT lifetime.

## 3. Documentation and exact search anchors

[ER-28](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-28-privacy-erasure-and-purge-closure.md) and [ER-34](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-34-backup-restore-and-platform-exit.md).

```sh
git grep -n -F 'Locked backup conflict reports PURGE_BLOCKED.' -- docs/agent-work/ER-34-backup-restore-and-platform-exit.md
```

## 4. Implementation approach

Reuse packages/cloudflare-erasure, the canonical purge ledger, and S55 manifests. Producer fencing prevents late derivatives after accepted purge. For each location retain exact identity/generation and independently verified absence, not merely a delete ACK. Equal hashes do not collapse distinct revisions/residencies into one object. Deletion cursors/checkpoints survive restart/replay.

Connect offsite/Google adapters through existing provider-closure ports. Missing evidence retains the appropriate blocked/unconfirmed state; it does not block development of local components or justify fake completion. State the boundary of managed copies and do not promise deletion of uncontrolled user downloads.

## 5. Acceptance criteria

- [ ] A source→normalized→index→Wiki→artifact→managed-export/backup fixture is erased/redacted according to the architecture. Exact, semantic, historical, and export paths cannot disclose purged bytes or active supporting influence.
- [ ] Purge during synthesis/upload/notification cannot resurrect data; restart/lost ACK preserves remaining work and cannot delete foreign objects.
- [ ] Locked backups, provider outages, and unconfirmed absence remain BLOCKED with a review condition. Removing a hold continues the same case.
- [ ] Minimal tombstones/receipts contain no erased text; current policy/residency remain enforced.
- [ ] Record existing and actual D1/R2 tests, exact SHA, and separate backup/Google integration evidence. Live cases use only explicitly authorized disposable data.
