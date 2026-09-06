# Launch 06 / #94 — Wiki, artifacts, changes and selective distillation

Follow execution-contract.md. Baseline f94bd7a. Read canonical ELIOT_RESEARCH §§5.4–5.7,7.9–7.11,
9.1–9.6,10.4,13.7,15.1–15.5,19.2–19.3/19.6/19.8; language §§5–10.
Owners ER-11 Artifact Compiler, ER-12 Wiki/promotion, ER-32 atoms/ArgumentMap; ER-08 shared research
ports, ER-10 audit/freeze, ER-13/14 persistence, ER-21/24 API and ER-25 UI. ER-27 integrates tests.

Reuse `packages/research/src/{ports,artifact-compiler,wiki,distillation,argument-map}.ts`,
`packages/domain/src/publication.ts`, current publication/evidence/research schemas, exact resolver and
R2/head/outbox patterns. No Markdown-only second authority; exports are not canonical section storage.
P1 storage is independent of W6 execution. W4 audit releases P3 publication; W6 then consumes P2/P3.

## Local checkpoints

### P1 — Immutable section/revision storage and head CAS (start here)

ER-11/12 services; shared ports ER-08; additive SQL ER-13 and R2 adapter ER-14. Persist Artifact,
ArtifactRevision, ArtifactSection, dependency/evidence manifests and verification receipts using complete
residency identity. PUT immutable object -> exact length/hash readback -> expected-head D1 CAS + outbox.
No cross-service transaction. Same identity/different bytes is integrity failure; lost ACK reconciles
exact objects/head before retry. No source or private data copied across residency domains for reuse.
Tests on actual local D1/R2: concurrent publishers, partial object upload, lost object/head ACK, checksum
mismatch, stale head and cross-domain reuse. PASS: exactly one competing head wins; loser typed conflict;
no partial/unverified revision becomes visible. D1 heads, not `_head.json`, remain authority.

### P2 — Copy-on-write Artifact Compiler (after P1 and #90 Q2)

ER-11 `artifact-compiler.ts`. Consume ArtifactSpec and per-section EvidencePacks, freeze dependencies,
outline/contracts, bounded drafts, terminology/cross-section reconciliation and deterministic assembly.
Escalate only difficult sections under W3 reservation; do not regenerate entire reports for one edit.
Persist independent sections/ledgers and exports with digests; target section <=1 MiB, large returns by handle.
Tests: modify one section of a multi-section artifact, reuse unmodified object IDs/digests, omitted/degraded
section, cancelled draft, budget exceeded and conflicting revision. PASS: only affected sections/calls
change, deterministic exports reopen to the same content, no assumed citation or completed-audit flag.
Final accepted publication still requires P3/W4; successful assembly alone is only a draft.

### P3 — Citation/claim/current-authority publication barrier (after P2 and #92 W4)

ER-10/11 current services + ER-39 exact resolver. Require exact current freeze/audit/denominator and
resolved support for every material accepted statement. Classify all material statements using canonical
SOURCE_SUPPORTED/DERIVED_INFERENCE/HYPOTHESIS/CONTESTED/UNRESOLVED/EDITORIAL_RECOMMENDATION/
REDACTED_DEPENDENCY labels; models cannot mint reference IDs. Recheck policy/purge/source generations
at publication and bind that observation to head CAS; external reads remain outside SQL transactions.
Tests: correct source but cropped hedge, stitched quote, number absent in span, stale grant, unadmitted
source, stale freeze and purge between validation/head mutation. PASS: accepted citation resolution 100%,
unsupported accepted claim/cross-project leak/purge-surviving support 0; failure leaves a bounded draft
or explicit redacted/pending status, never an accepted head. Terminal receipt precedes Google delivery.

### P4 — Wiki proposals, risk tiers and changes (after P1/P3)

ER-12 `wiki.ts`/domain publication; ER-21/24 `research.wiki.propose`, artifact/changes/trace integration.
Keep immutable Wiki revisions with labels, evidence map, counterpositions, limitations and supersedes.
D0 mechanical promotion requires deterministic checks and ordinary receipts; D1 additive promotion only
under explicit project policy, exact handles, no conflict/current-state override and independent verifier.
D2 needs verifier plus authorized committer; D3 owner/designated authority only. Use no bypass around CAS,
erasure or disclosure. Persist append-only change stream with principal/scope/revision-bound cursors.
Tests: D0/D1 missing policy/handle/verifier, D2/D3 auto-promotion attempt, concurrent expected-head race,
foreign cursor, lost notification, purge/revoke after publication. PASS: policy-prescribed tier behavior,
zero D2/D3 automatic promotion, exact replayable changes; full trace is not the metadata-orientation trace.

### P5 — Selective EvidenceAtoms and reversible ArgumentMap (after Q2, W4 and N1 inputs)

ER-32 `distillation.ts` and `argument-map.ts` are unfinished contracts; implement rather than leave them
outside the launch inventory. Trigger only for canonical core/active/repeated/audit/dependency/owner cases.
Validate verbatim span/hash, number, modality, conditions/population/time and frozen-scope identity before
atom admission; preserve finding/decision/hypothesis/failed-approach distinctions. Build source-bound
argument nodes/edges with exact spans and distinct precision class; no model-candidate edge becomes a fact.
Add the scientific/project profile validations required by ER-32, not optional Slice 7 infrastructure.
Tests: recommendation presented as decision, hypothesis as observed fact, negation cropped, wrong unit/
population/version, invented causal edge, unsupported source and duplicate trigger. PASS: 0 forbidden
semantic collapses, every admitted atom has exact support/validation receipt, every edge traceable, and
ordinary ingest performs 0 full-paragraph LLM distillation jobs. Track controlled-model versus genuine-quality evidence.

### P6 — Full report/Wiki browser lifecycle and erasure linkage (after P1–P5, #92 W6, #98 L1)

ER-25 panels + ER-27 proposed `tests/integration/browser/publication.spec.ts`. Actual local runtime:
investigate -> draft -> review -> publish -> reopen -> one-section edit -> changes -> purge support.
Show labels, verification, coverage, stale/redacted state and conflict errors. Register every source,
section, head/export/Drive-copy dependency with #96 erasure. No permanent private browser cache.
PASS: published output and durable head agree; one edit reuses unchanged content; lost ACK/restart does
not duplicate publication; purged support becomes redacted/pending and cannot reappear through exports.
Add publication/atom/Wiki suite and failure cases to O1 probe runner; no fake browser HTTP for this acceptance.

## Verification and completion

Run execution-contract.md commands, research/publication/policy/exact-evidence tests, actual D1/R2 CAS
fixtures, Golden Corpus forbidden-collapse cases, L1 Playwright and combined exact-head CI. Store compact
section/head/manifest/digest comparisons as evidence, not complete private reports in public comments.
All P1–P6 local items are required; drafts alone are not completion. Pure invariants target the canonical
research/evidence/coverage crates and parity fixtures; TS keeps storage/model/transport orchestration.

## Live-only gates after O7

Publish and revise with real D1/R2/Access and independent evidence resolver, including concurrent CAS,
revocation/purge race, copy-on-write object equality and dependent export invalidation. Run real controlled
model quality against labelled corpus; preserve exact model/prompt/route generations and budgets. Result
Doc delivery belongs to #95 G7 and must leave this canonical artifact available on failure. Follow
cloudflare-handoff.md #94; unresolved citations, forbidden collapses or failed retention stop publication.
