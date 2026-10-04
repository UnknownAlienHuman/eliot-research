# Owner configuration and functional integration checkpoint — 2026-10-03

Baseline: published `main` source `e6da93c` (2026-10-03).
Status: integration in progress; this document is not release acceptance.

## Product changes under integration

- The owner can browse the Cloudflare Workers AI catalog and save an exact
  project model configuration revision. Selection preserves provider, billing
  mode, credential alias, transport constraints and qualified model identities.
  A missing selection blocks a new run without blocking saved-document reading.
- Owner template v2 separates durable configuration choices from current access,
  scope, cancellation and execution authority. V1 keeps its original expiry
  rules. See [ADR-0010](../adr/0010-project-model-revisions-and-run-authority.md).
- New Research runs capture the selected configuration before Workflow creation.
  Recovery and historical COW reuse the originating snapshot. Migrations
  `0104`–`0106` implement capture, explicit qualification revocation and immutable
  project configuration history with owner/generation/CAS fences.
- Managed OAuth MCP uses a verified human identity and one current project.
  Bounded exact document reading is independent of search projection availability.
  Headless service-token diagnostics retain their separate protocol. The native
  maintenance transition preserves PWA Access separately; see
  [ADR-0014](../adr/0014-maintenance-managed-oauth-mcp-transition.md).
- Offsite backup now retains authenticated encrypted object bodies and verifies
  the exact body/digest on read. Migration `0107` adds target-bound restore
  intent, attempt and receipt storage; these control records are not portable
  backup data. Production restore target/admission composition remains pending.
- Guarded maintenance keeps D1 migration application separate from Worker
  deployment. The narrow AI Search binding transition is defined by
  [ADR-0011](../adr/0011-maintenance-ai-search-binding-bootstrap.md); it cannot
  create resources or enable other slices.
- An owner-only AI Search functional probe intersects one project with one
  selected current source and resolves one native shadow locator through the
  exact evidence reader. Immutable START/terminal records prevent a repeated
  provider call after an uncertain effect. Its result carries no qualification
  authority; see [ADR-0012](../adr/0012-owner-ai-search-functional-probe.md).
  A new HTTP scope snapshot can make a reused request return UNKNOWN without
  issuing another query; receipt replay requires the original pinned scope.
- Project configuration import persists the canonical semantic revision before
  selecting its immutable configuration. The empty-table constraint repair in
  `0108` uses short D1-compatible GLOB predicates and refuses nonempty tables;
  see [ADR-0013](../adr/0013-empty-semantic-revision-constraint-repair.md).

## Observed checks

These results describe the local integration snapshot, not an attested deployed
build. The final source SHA and necessary checks must be recorded after assembly.

| Check | Observed result |
| --- | --- |
| Workspace TypeScript build | PASS |
| Whole-tree ESLint | PASS at the prepublication checkpoint |
| Root Vitest suite | 175 files, 1615 tests PASS |
| Core native Worker suite | Initial run: 104 files passed, 11 failed, 1 skipped; 828 passed and 21 failed tests. Follow-ups: five corrected files / 13 tests PASS, three further files / 33 tests PASS, session file / 15 tests PASS. Native current-dispatch scenario PASS: completes the Workflow, materializes verified evidence and reopens/replays without another model call |
| PWA build | PASS |
| Generated binding types | PASS; generated file retained outside tracked product sources |
| Worker dry run | PASS; gzip upload approximately 816 KiB |
| PWA emitted JavaScript | Conservative sum of all emitted JS gzip 208,676 bytes, below the 600 KiB initial-JS target |
| Repository boundaries and eight negative boundary fixtures | PASS |
| Privacy large-line regression and full privacy scan | PASS |
| Depth-100 SQL compilation | PASS for 107 Core migrations / 472 statements, including the empty-table repair |
| D1 migration application and reconciliation | All five intended migration applications succeeded. The earlier `UNKNOWN` receipt remains unchanged. A fresh read-only reconciliation verified all 52 expected schema objects; the migration ledger had no pending names and reported `ALREADY_APPLIED`, with zero apply attempts and zero writes |
| Native COW/owner-loop final cases | 7/7 PASS on `e6da93c`; a unique attestation was observed |
| `check:affected` | FAIL on source-maintainability budgets: 22 counted violations versus 18 at the October 3 integration baseline (`78c6595`), or four additional threshold crossings; no full-release pass |
| Live Workers AI access | One direct bounded GLM-5.3-Flash response observed; not a Research run |
| AI Search metadata | Private namespace and five exact empty Built-in instances created and read back; no READY, indexed-content or evidence claim |
| Managed OAuth Access application | Separate owner-only `/mcp` application created and read back with a 24-hour session; existing PWA application remains at 168 hours. Worker variables and client OAuth connection are still pending |
| Native Cloudflare MCP operator connection | Supported App Server OAuth login completed; three tools available, including `execute`. A fresh process completed the supported GET-only Access verification and emitted the standard managed-OAuth receipt |

The emitted-size observations do not measure Worker CPU/heap/startup, production
asset delivery or the full S90 resource matrix. Private operator observations
and browser captures remain outside the public repository. The final native
scenario passed with a background Workerd request-cancellation warning; a live
functional run is still required. The full Core suite was not rerun.

## Remaining functional acceptance

1. Perform the guarded Worker candidate deployment and exact readback. D1
   migration application and readback are recorded above; the earlier
   `UNKNOWN` receipt remains unchanged.
2. Use fresh current owner approval, source admission and bounded real model
   qualification. Old route approvals, expired source evidence and prior-model
   receipts cannot be relabelled for the new tuple.
3. Observe normal source admission/outbox projection, actual indexed/readback
   counts and one owner-scoped managed locator resolving into exact evidence.
   This functional observation does not promote a shadow generation. Full S1
   retains its golden-set and qualification gates, deferred with quality testing.
4. Complete the real Managed OAuth client connection and its project/document/
   search/run/citation path. The owner-approved Access app and native Cloudflare
   operator readback are verified; the deployed Research client connection
   remains to be completed.
5. Complete one free, owner-scoped Worker-backed Research run through real
   REPORT output and reopen. Verify the functional owner document-to-DRAFT/reopen
   path on the final build, then perform the responsive workspace changes and
   browser comparison. Quality, cognitive and load testing remain deferred.

The owner permits only free bounded functional checks. Cognitive, quality and
load testing is deferred. Full S92–S97 acceptance, disabled slices and production
restore closure remain separate outstanding criteria.

## 2026-10-04 integration checkpoint

- Separate post-upload reconciliation reached `AUTHORITY_SYNCED_POSTUPLOAD_RECONCILED` at 04:19 UTC; ten assets, owner health,
  capability state and exact current D1 authority were verified. The standard asset-readback failure remains; no standard
  deployment receipt or full deployment PASS is claimed.
- Deterministic README import (no AI) admitted a new head; exact 12,688-byte R2 content matched the repository digest.
  Project revision 3 preserves two entries and adds the README. Live FAST_SEARCH returned the exact 3,103-byte excerpt,
  matching trace and `SAMPLED` scope. Exact/lexical checks are ready; semantic was not requested, currentness `NOT_VERIFIED`.
- SDK predecessor-fingerprint CAS and reactivation target-existence gate passed an offline SQLite audit. Native CF Dynamic
  Route SDK request-port and `--gateway-transport cloudflare-mcp` installer preserve Wrangler D1; focused checks 10/10 with
  the MCP fixture and full TypeScript passed. No model calls were made.
- Public Research MCP DCR callback/single-resource configuration are fixed; one conformant native registration returned
  201, but native OAuth completion failed (provider-compatibility cause unconfirmed). MCP acceptance remains open; Report
  was not executed.
- The Sources / center Report / right context composition awaits final review and browser QA. Prior 35-file / 328-test results precede
  the last bounded label/layout correction and are not final UI acceptance.
- Only free bounded functional checks remain authorized; quality/load are deferred. Last recorded source-budget result:
  22 findings vs 18 baseline, not rechecked here. Full-release gates and production restore remain unaccepted; no new ADR
  authority or overall completion is claimed.
