# BackupEpoch and restore contour

ER-34 owns the portable backup/restore implementation. A BackupEpoch includes schema and migration
ledgers, D1 Core JSONL, source/project/scope manifests, EvidenceHandle registry including tombstones,
R2 object manifests, Wiki/artifact/investigation heads, generation records, and the current PurgeLedger.
D1 Search, AI Search, Queue, and live Durable Object state are rebuilt rather than treated as authority.

Restore order is fail-closed: restore Core in isolation, apply PurgeLedger and current policy before any
payload exposure, remove or quarantine purged influence, restore remaining R2 objects, then rebuild
projections and run LIVE/REDACTED handle acceptance cases. No readiness receipt is issued before this
sequence completes.
