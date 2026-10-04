# Owner configuration and functional integration checkpoint — 2026-10-03

Baseline: `main` / `78c6595fd8cf1292b55dd64fd13898306bb40360`.
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
| `check:affected` | FAIL on source-maintainability budgets: 22 violations, including 17 present in the October 2 baseline; no full-release pass |
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

1. Publish the source checkpoint, apply
   the separately pinned bounded D1 migration operation and perform guarded
   candidate deployment/readback.
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
5. Verify the functional owner document-to-DRAFT/reopen path on the final build,
   then perform the responsive workspace changes and browser comparison.

The owner permits only free bounded functional checks. Cognitive, quality and
load testing is deferred. Full S92–S97 acceptance, disabled slices and production
restore closure remain separate outstanding criteria.
