# Launch 02 — Content retrieval and exact evidence

Status: eligible local task, unclaimed. The tested #89 checkpoint is integrated in main; unfinished
Library acceptance is tracked by #98, not silently complete. Refresh current main before coding and
follow `agent-start.md` here. Reuse current ScopeSnapshot, read-policy/grant and EvidenceHandle ports.
Owners: ER-06/07/16/39, with ER-21/24 transport and ER-25 UI. Read those packets, retrieval contracts,
`packages/interfaces/src/semantic-api.ts`, `packages/cloudflare-ai`, `packages/cloudflare-evidence`,
`apps/eliotr-core/src/evidence-service.ts` and `composition-root.ts`. Shared series rules: README.md here.

## Result

A real scoped query returns authorized exact fragments with provenance and reopenable handles. Managed
hits remain locators until canonical D1/R2 resolution; provider text never becomes citation authority.

## Small sequential checkpoints

- [ ] R1. Audit/reuse existing strict managed locators in `packages/retrieval/src/locator/strict-decoder.ts`
  and `packages/platform-cloudflare/src/ai-search.ts` and their tests. They already reject fabricated
  handles and unknown fields. Close only missing pinned-profile/byte/coordinate/version cases; do not
  replace them with a second decoder or count existing code as a new implementation.
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

Start with one R2 lane and its real projection input. With local cron absent and remote AI disabled,
explicitly exercise the existing outbox/dispatcher/executor; seeding a finished index is not the full
import-to-query test. Claim exact packet-owned paths before editing. The coordinator retains #98 PWA/
import work; serialize shared exports, migrations and composition through the integrator.

## Completion

Require `pnpm check:affected`, strict Workers fixture typecheck, local Linux/Windows smoke, PWA/Worker
build and exact-head CI. Review quality cases separately by exact/lexical/semantic product. Browser
import-to-evidence must pass; manual fixture-only paths do not qualify usable UI. Keep all R1–R6 items
unchecked until their real acceptance is complete; green planning CI is not implementation.
Update registry/gaps when enabling RETRIEVAL, with actual execution and negatives. Remote AI Search
readback/latency remains NOT_EXECUTED until the first complete staging trial. Follow the #90 section
of `cloudflare-handoff.md`; no partial deployment or launch-gate bypass.
