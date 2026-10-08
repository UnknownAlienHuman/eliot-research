# 2026-10-08 backend audit index

This directory contains audit evidence and implementation passports. It is **not** the day-to-day
implementation entry point.

Start implementation at:

- [`docs/START-HERE.md`](../../../docs/START-HERE.md);
- [`docs/implementation/backend-entrypoints.md`](../../../docs/implementation/backend-entrypoints.md).

## Canonical handoff documents

| Document | Purpose |
|---|---|
| [BACKEND-AUDIT-PREPARATION-COMPLETE.md](BACKEND-AUDIT-PREPARATION-COMPLETE.md) | Completion marker, settled ownership, first wave and verification boundary. |
| [FINAL-PR-DISPOSITION-MATRIX.md](FINAL-PR-DISPOSITION-MATRIX.md) | Complete starting-set disposition and non-circular dependency graph. |
| [CLOUDFLARE-NATIVE-OWNERSHIP.md](CLOUDFLARE-NATIVE-OWNERSHIP.md) | Cloudflare commodity ownership versus Eliot semantic authority. |
| [PRESERVATION-RECONCILIATION.md](PRESERVATION-RECONCILIATION.md) | Per-delta reconciliation for #121/#173/#174. |

## Implementation donor guides

| Document | Purpose |
|---|---|
| [BACKEND-DONOR-PLAYBOOK.md](BACKEND-DONOR-PLAYBOOK.md) | Retrieval, indexing, product planning and counter-search donor functions. |
| [BACKEND-DONOR-PLAYBOOK-2.md](BACKEND-DONOR-PLAYBOOK-2.md) | Acquisition, branches, durable wait, quality and first-cause donor functions. |

## Code and PR audits

| Document | Purpose |
|---|---|
| [CODE-INTEGRITY-AUDIT.md](CODE-INTEGRITY-AUDIT.md) | Concrete code defects and reproduction boundaries. |
| [REPLAY-IDENTITY-AUDIT.md](REPLAY-IDENTITY-AUDIT.md) | Replay, digest, trace and execution-identity findings. |
| [OPEN-PR-BACKEND-TRIAGE.md](OPEN-PR-BACKEND-TRIAGE.md) | Family-level open PR triage; the final matrix supersedes stale status lines. |
| [SOURCE-PR-READINESS.md](SOURCE-PR-READINESS.md) | Source-branch ancestry/overlap/readiness observations; final current state is in the matrix. |
| [LEGACY-PR-REVIEW.md](LEGACY-PR-REVIEW.md) | Historical/legacy PR analysis and absorbed requirements. |
| [REPAIR-SERIES.md](REPAIR-SERIES.md) | Repair-series index and original passport mapping. |

## Executable passports created in this pass

| Document | PR |
|---|---:|
| [R08-cloudflare-native-stage-effects.md](R08-cloudflare-native-stage-effects.md) | #330 |
| [R09-shared-bounded-stream-readers.md](R09-shared-bounded-stream-readers.md) | #331 |
| [R10-ledger-snapshot-consistency.md](R10-ledger-snapshot-consistency.md) | #332 |

Other dated files in this directory are supporting analyses or earlier revisions. When they disagree
with the completion marker, final matrix or current PR body, treat them as historical evidence.
