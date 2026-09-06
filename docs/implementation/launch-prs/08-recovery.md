# Launch 08 / #96 — Steward, erasure, recovery and controlled release

Follow execution-contract.md. Baseline f94bd7a. Read canonical ELIOT_RESEARCH §§1.4/1.6,10,
13.5–13.8,14,15–16,17.3–17.4,19.1–19.14; language §§7–10; production-readiness-plan.md,
release-checklist.md and cloudflare-handoff.md. ER-33 Steward, ER-28 erasure, ER-34 backup,
ER-17 metrics/limits, ER-26 deploy, ER-27 conformance, ER-00 CI/locks, ER-13 migrations.
Specialist ER-35/optional Slice 7 is NOT an unconditional release requirement. Do not omit mandatory
Steward/security/restore work merely because earlier plans focused on the deployment script.

Existing files: `tests/integration/{gate-state.ts,gate-state.test.ts,live-gates.example.json}`,
`packages/platform-cloudflare/src/{backup,observability}.ts`, `packages/research/src/steward.ts`,
`packages/cloudflare-erasure/`, Worker erasure runtime/coordinator, `infra/{backup,erasure}/`,
`scripts/{deploy-cloudflare,check-launch-code}.mjs` and `scripts/lib/deployment-verification.mjs`.
Backup/Steward contracts are not executable implementations. Existing inventory smoke is not full
version/binding attestation. Reuse implemented erasure/receipt/state families rather than a parallel harness.

## Off-account implementation checkpoints

### O1 — One executable conformance runner and strict evidence validator (first task)

ER-27 adds proposed `tests/integration/run-conformance.mjs`; ER-00 adds NEW `pnpm conformance:run`.
Use existing LiveGateReceipt family; version additive envelope/fields through ER-01 where needed.
Define suites library/retrieval/lens/research/federation/publication/drive/recovery/rust-runtime supplied
by the owning themes. Proposed CLI: `pnpm conformance:run -- --mode fixture --suite <name>`;
live additionally requires explicit `--mode live --target-file <private.json> --release-file <manifest.json>
--confirm-live`. These commands do NOT exist yet; implementing them is this task.
Validate exact code/build/config/data generations, gate/test/input identity, real observation vs expected,
start/finish/currentness, redacted immutable receipt ref+digest, reason codes and cleanup state. Missing
credentials => NOT_EXECUTED; missing code/approval => BLOCKED; executed mismatch => FAIL. None => PASS.
Tests: fake/stale/wrong-generation PASS, arbitrary reference with no readback, duplicate receipt,
wrong target/origin, missing credentials, redirect, truncated body, timeout and cleanup failure. PASS:
runner fails closed before effects, no live call in fixture mode, outputs are machine-checkable and
redacted. Keep bounded observed evidence private; a digest is not proof an unobserved action occurred.

### O2 — Portable backup and admissible offsite copy (independent of product UI)

ER-34 `backup.ts`/`infra/backup/`, ER-13 snapshot queries. Implement streamed epoch manifests containing
Core JSONL/schema+ledger, source/project/membership/handle and publication/investigation heads, R2 object
manifests, generations and purge frontier. Freeze a coherent authority view using explicit revisions/
watermarks; detect concurrent drift, never silently combine incompatible heads. Hash/read back each part.
Separate KEKs/credentials from backup delivery; no plaintext keys in epoch. Offsite adapter uses one
approved encrypted independent destination with expiry/deletion journal, not invented external credentials.
Tests: real local D1/R2 backup, concurrent mutation, incomplete chunk, wrong hash, lost copy ACK,
interrupted/resumed export, new purge and inadmissible retained destination. PASS: exact complete portable
epoch/readback or explicit incomplete; no reliance on D1 Time Travel as the only backup and no Search/Queue/DO as canonical data.

### O3 — Restore in isolated no-traffic mode (after O2)

ER-34 restores Core/ledger into separate target, loads CURRENT purge/policy frontier before payload
exposure or index rebuild, filters/quarantines purged originals AND derivatives, verifies surviving R2
objects/heads/schema, then rebuilds Search/AI/Atlas/Wiki views through existing adapters. Restore never
silently reactivates expired/revoked credentials or grants from an old epoch. No fixed-resource production
name may resolve to the restore target. Local tests use actual empty D1/R2; remote adapters are implemented
with controlled responses first.
Tests: old backup containing later-purged evidence and influence, absent/current purge mismatch, lost
restore ACK, corrupted object, schema drift, failed rebuild, restart and traffic attempted early.
PASS: zero purged bytes/influence served or reindexed; LIVE samples reopen exactly and REDACTED samples
return only non-revealing tombstones; readiness stays false until checks complete. Record measured local
RPO/RTO with limitations, not unsupported live guarantees. Code/index rollback must not roll back purge history.

### O4 — Compose complete ErasureCoordinator (after O2/O3 and all dependency producers)

ER-28 existing coordinator/backend plus ER-21/24 authorized API and ER-25 status. Admission immediately
revokes new reads/model routes, enumerates canonical/derived/provider/offsite/continuation/backup closure,
checks legal retention/locks, deletes only exact governed locations, independently verifies absence,
appends purge ledger and invalidates support. Steward cannot call privileged deletion. A redacted derivative
may survive only with exact DeclassificationReceipt, not a model summary.
Tests: missing/subset location, wrong object/domain, provider outage, locked backup, concurrent new copy,
purge/resume/lost ACK and restore after erasure. PASS: requested-location equality and all required absence
proof before completion; blocked hold/backup => BLOCKED with review date, not PURGED. Canonical/derived
closure includes Drive copies, Wiki sections, Atlas omissions, federation ranges and route continuations.

### O5 — Deterministic Steward, bounded proposals, metrics and budget/alert behavior

ER-33 `steward.ts`, ER-17 observability/runtime-limits, ER-24 schedules, ER-25 health. Implement bounded
hash/handle/readiness/watermark/projection/outbox/DLQ/backup/purge/route/cost checks. Semantic work only on
listed §10.2 triggers and within W3 reservations; proposals name evidence and verifier. Retrieval feedback
creates candidate QueryHint/generation only after Golden replay, not silent live policy changes.
Tests: stale Wiki dependency cannot self-publish, erasure alarm cannot hard-delete, untriggered semantic
loop, quota exhaustion, DLQ and missing telemetry. PASS: no permission/authority mutation from Steward;
required §15.6 metrics and SLO breaches appear in PWA even without an email/webhook sink; no raw content
in metrics. Assert §14.6 budget actions at 70/80/90/95/100%, preserving allowed evidence access.

### O6 — Complete local release validation and full deployment attestation adapter

ER-26 extends existing orchestrator/readback, not a second deployment command. Before release effects,
check every mandatory route/contour and critical Rust promotion records, target isolation, config/resource
schema, budget, build digests and rollback references. Implement bounded exact deployed-version/bindings/
D1-ledgers/exports/assets/Wasm readback; inventory presence alone is insufficient. Existing generated-config
dry-run occurs before remote migration; digest checks hold between effects. Missing/changed version blocks success.
Tests with controlled Cloudflare responses: wrong binding/version/route, partial migration, stale receipt,
config drift, expired auth, fake smoke, first deployment without previous live receipts and production
attempt without qualification. PASS: all predictable failures stop before mutation; no code-hold skip,
no false deployment receipt, no destructive rollback of current policy/purge. Run the entire integrated
local suite, all theme browser tests, exact-main CI and `pnpm launch:code` after code is actually complete.

## O7 — First COMPLETE staging deployment (account-only; not authorized now)

Preconditions: all local theme checkboxes and production-critical Rust migration/promotions integrated;
O1–O6 executable; exact-head CI, local Linux/Windows smoke, full real-storage browser loops and dry-run
pass. Existing real T4/T6 receipts are NOT required to start their first trial. Obtain explicit operator
account/hostname/jurisdiction/owner-service identities, KEKs/secrets, budget and target approval; record
only non-secret references. Staging label alone is not isolation: require a dedicated approved account
or reviewed distinct resource profile. Never seed trusted identities/policies using fixture SQL.

Use existing commands, not raw Wrangler:

```text
pnpm launch:code
pnpm cf:preflight:remote
node scripts/deploy-cloudflare.mjs --confirm-live
```

Set `ELIOTR_ENVIRONMENT=staging` and exact tested `ELIOTR_DEPLOYMENT_GENERATION` explicitly. Read-only
preflight checks every product before creates/updates. After deployment, execute O6 independent full
readback and O1 live suites using the private approved target/release manifests. Follow the handoff's
exact per-theme observations. Stop on drift, unapproved spend, secret exposure or ambiguous writes;
cleanup only exact disposable IDs belonging to this trial. PASS: complete built application identity,
real expected outcomes and redacted receipts, not merely successful deploy/health/Queue ACK.

## O8 — Production qualification, load and recovery (after O7)

Run actual T4 vertical Drive action -> D1/R2 -> research/PWA/Wiki -> Doc/RESULTS readback; T5 failures,
injection/erasure/restore; T6 profiles 5/20/50 readers, 5 interactive sessions, 10 queued ingest/projection
jobs, 2 long Workflows. Retain p50/p95/p99, contention/lag/DLQ, throughput, exact corpus quality, provider
usage and cost stops. Test independent encrypted offsite clean-target restore and rollback. First-month
bill cannot be manufactured before it exists; mark its observation pending until actually available.

Good result: §19 forbidden counts all 0, accepted citations/exact recall 100%, labelled semantic Recall@20
initially >=0.90, no knowledge/job loss from rebuildable stores, restore and rollback PASS. Measure §15.8
catalog/orient <500 ms (excluding client network), exact <800 ms, hybrid <2.5 s, first token <4 s after
retrieval; record route/index generations and any unmet target, never relax it ad hoc. Compressed Worker
<=4 MiB, PWA JS <=600 KiB, startup <=400 ms, first-party heap target <=32 MiB. These are repository targets.
Production stays blocked by required failed/missing gates, P0/P1, unresolved citations or blocked erasure
without review. No theme may mark LIVE_QUALIFIED just because this runbook exists.
