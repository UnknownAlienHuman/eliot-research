# S53 — Edit REPORT sections without regenerating the whole report

Baseline: `a2aca127`; ER-11/13/24. Artifact compiler, section stores, draft readers, and Markdown export already exist. Integrate missing behavior rather than creating another report engine.

## 1. Problem

Persisting a single DRAFT body does not establish ArtifactSpec → section tree → reconciliation → ArtifactRevision. Editing one section must not automatically regenerate the entire report.

## 2. Required change

Complete the REPORT profile and copy-on-write section lifecycle: planned sections, per-section EvidenceLedger/verification/dependencies, deterministic assembly, and versioned exports. Editing B retains A/C identities/bytes only where their supporting evidence and context remain valid.

## 3. Documentation and exact search anchors

[Architecture, sections 9.1–9.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).

```sh
git grep -n -F '## 9.2. Copy-on-write section tree' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Implementation approach

Reuse immutable R2 sections/revisions/manifests and D1 expected-head/outbox settlement. Section identity includes content, dependencies, and residency; equal text cannot authorize cross-domain key/ciphertext reuse. Write/read back exact R2 bytes before guarded D1 CAS; do not pretend this is a cross-service transaction.

Reconcile terminology, units, and cross-section assumptions through existing verification. If B changes A's premise, revalidate A rather than reusing it solely because its body hash is unchanged. Missing sections or failed audits retain a limited DRAFT, not a complete report. Build exports from the canonical tree; export files are not the only state. Lost responses reconcile original objects/heads. Section-edit requests reuse ArtifactSpec/reference/version contracts and expected_revision; no model keys enter the PWA.

## 5. Acceptance criteria

- [ ] Editing B in an A/B/C report retains valid A/C references/bytes without unnecessary model calls; B gets a new audited revision and deterministic export.
- [ ] Changed dependencies trigger targeted revalidation of affected sections.
- [ ] Concurrent edits, CAS losers, lost R2 ACK, and partial assembly cannot publish broken heads.
- [ ] Revoke/purge/residency checks hold at commit and read; history remains readable only under valid policy.
- [ ] Record actual storage/API tests, per-section call counts/hashes, and exact SHA.
