# Launch 06 — Wiki, reports, artifacts and changes

Status: queued draft, unclaimed. Dependencies: #90 exact evidence and #92 research for publication.
Owners ER-11/12, ER-21/24 API composition, ER-25 UI, ER-13 storage and ER-28 purge integration.
Read these work packets, Wiki/Artifact contracts, `packages/research`, existing citation-resolution
ports and `packages/interfaces/src/semantic-api.ts`. Reuse existing scope, handles and research results.

## Small sequential checkpoints

- [ ] A1. Persist immutable Wiki revisions, proposals and expected-head CAS; bind owner/scope/policy,
  request digest and generation. Test exact replay, concurrent promotion and lost acknowledgement.
- [ ] A2. Implement explicit proposal/review/promotion with statement labels and dependency closure.
  Source text and model candidates cannot approve themselves; permissions and currentness are rechecked.
- [ ] A3. Implement Artifact Compiler through existing research contracts: section-level copy-on-write,
  stable dependencies, bounded materialization and exact artifact/result readback. Never overwrite an
  older published revision or materialize unbounded whole-corpus text in the Worker.
- [ ] A4. Gate every publishable material claim on exact authorized citation-resolution receipts from
  #90. Missing, stale, purged or fabricated citations block publication or yield an explicit draft.
- [ ] A5. Wire `research.artifact`, `research.wiki.propose` and `research.changes`; extend trace beyond
  metadata orientation without changing old trace semantics. Cursor scope/generation must be bound.
- [ ] A6. Add Wiki/report/revision/diff UI with typed failures and revoked-source state. Register exact
  section/source dependencies so purge invalidates output, including caches and derived excerpts.
- [ ] A7. Prove research -> draft -> review -> publish -> reopen -> revise, concurrent head conflict,
  purge during publication, partial citation resolution and restart/replay in local Worker/D1/R2 and
  browser tests. Include RU/EN/code/table evidence and candidate-only hypotheses.

Each checkpoint is small related commits with negative tests; use the current owning packet before
editing shared manifests/routes/migrations. Do not build a second evidence store or alternate domain
state machine. Coordinate stable decisions with Launch 09 rather than maintaining permanent TS/Rust copies.

## Completion

All mandatory routes execute real services and the published bytes match immutable receipts. Require
repository/Rust gates, strict Workers fixtures, exact-head CI, local boot, browser lifecycle and output
size budgets. Update status/gaps without promoting local tests to live qualification. Keep draft until
A1–A7 pass. Publication with unresolved citation is a failing test, not a warning. No partial deployment;
remote publication/purge/recovery readback belongs to complete staging and Launch 08.
