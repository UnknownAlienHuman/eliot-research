# Launch 02 — Content retrieval and exact evidence

Status: queued draft, unclaimed. Refresh current main before coding. Predecessor: Launch 01 (#89) for
populated owner UI. Reuse current ScopeSnapshot, read-policy/grant and EvidenceHandle implementation.
Owners: ER-06/07/16/39, with ER-21/24 transport and ER-25 UI. Read those packets, retrieval contracts,
`packages/interfaces/src/semantic-api.ts`, `packages/cloudflare-ai`, `packages/cloudflare-evidence`,
`apps/eliotr-core/src/evidence-service.ts` and `composition-root.ts`. Shared series rules: README.md here.

## Result

A real scoped query returns authorized exact fragments with provenance and reopenable handles. Managed
hits remain locators until canonical D1/R2 resolution; provider text never becomes citation authority.

## Small sequential checkpoints

- [ ] R1. Strictly decode managed AI Search responses into bounded LocatorCandidates. Cover unknown
  fields, fabricated handles, oversized arrays/text, invalid byte coordinates and version mismatch.
  Use the pinned provider API/profile; no new SDK or permissive casts.
- [ ] R2. Wire real D1 exact/literal/lexical lanes to the current active projection generation. Execute
  parameterized, bounded queries; distinguish unavailable/stale index from an empty valid result.
  D1 FTS fallback stays usable when managed search fails; record degraded coverage explicitly.
- [ ] R3. Compose semantic retrieval and merge candidates under query budgets, cancellation and
  current scope/read grants. Recheck ownership, policy, generation, expiry and purge after each read.
  No completeness or absence proof from top-k or partial generations.
- [ ] R4. Resolve candidates through the existing canonical EvidenceHandle service, persist exact
  result/trace references and implement `research.query` HTTP dispatch. Reject unsupported product/
  evidence-grade combinations explicitly rather than quietly downgrading precision.
- [ ] R5. Add ER-25 query/evidence panels using typed HTTPS contracts: display revision, anchor,
  checksum, provenance, coverage/omissions and neighboring authorized text. Reopen via `research.open`;
  exact verification uses `research.verify`, not a second client evidence algorithm.
- [ ] R6. Prove import -> projection -> query -> verify/open using actual local Worker/D1/R2 and
  representative RU/EN/code/table fixtures. Add purged/stale revisions, policy withdrawal during
  resolution, provider outage, cancellation, forged preview and absent-answer cases.

One checkpoint per bounded commit, preferably 2–5 files plus a negative test; split further where
needed. Reuse ER ownership; register exact shared edits before changing routes/migrations/barrels.

## Completion

Require `pnpm check:affected`, strict Workers fixture typecheck, local Linux/Windows smoke, PWA/Worker
build and exact-head CI. Review real quality cases by product (exact/lexical/semantic), not a blended
score. Browser import-to-evidence loop must pass; no manual fixture-only path counts as usable UI.
Update registry/gaps when enabling RETRIEVAL; do not remove sentinels without actual execution/tests.
Keep draft until R1–R6 are complete. Remote AI Search generation/readback/latency evidence remains
NOT_EXECUTED until the first complete staging trial; no partial deployment to develop this feature.
