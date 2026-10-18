# Implementation and removal plan

Updated 2026-10-17. Read [current architecture](../architecture/ELIOT_RESEARCH.md) and [AGENTS.md](../../AGENTS.md).
This is the only current work queue. #377 archived the previous programme; #380 holds the source audit.
The tasks below are implementation outcomes, not completed work or prerequisites to create more plans.

## Size and outcome

The earlier [inventory](../../.github/audits/2026-10-17/README.md#source-footprint-and-reduction-evidence)
measured 283,671 authored application/library lines, including unselected and historical implementations.
The working goal is below 100,000, not a quota to fill or a source-size gate. First removals do not prove
that goal achieved. Keep readable source; moving code between packages, Rust, fixtures or generated files
is not reduction. Count changed product code separately from documentation, tests and tooling.

## Working method

Pick one caller/behavior and its writer/reader, implement the replacement, move callers and delete its old
code/exports/fixtures in the same integration. Keep unchanged shared paths alone. A row covering several
independent families is several small assignments, not one all-repository Issue. The manager serializes
shared manifests/routes/migrations; independent assignments continue without waiting for unrelated work.

Default: one current format and implementation. A real running attempt or retained user result may need
settlement or one-time conversion; old fixtures and hypothetical consumers do not need compatibility.
Use stored object locators where possible; do not move every R2 object merely to rename its key scheme.
Unknown live data blocks a destructive migration, not ordinary source cleanup. No new registry tracks this process.

## Candidate order and retirement decisions

### 1. Remove the machinery that recreates obsolete obligations

Start at `scripts/check-frontend-owner-checkpoints.mjs`, `scripts/check-work-packets.mjs`,
`docs/agent-work/manifest.json`, `package.json` and the manual provenance portion of
`.github/workflows/frontend-owner.yml`. Remove claim/ancestry/path-lock enforcement and its exclusive
fixtures/claim files, scripts and references together. Historical task documents are not permanent locks.

Separately simplify `scripts/check-launch-code.mjs`: readiness must reflect selected capabilities,
not exact statement counts/AST layout or canceled feature flags. Keep ordinary compile/lint and actual
product checks; do not replace this with another source interpreter. Existing automated CI changes only
in the explicit tooling change, not because these requirements were edited.

### 2. Disconnect the canceled search generation layer

Move the consumers together: `cloudflare-ai/src/project-search.ts`, Core `research-run-service.ts`,
project readiness, and `cloudflare-research-runtime/src/research-retrieval-composition.ts`.
Replace registry-based managed-authority/readiness/fences with the configured native instance and existing
project/source filters. Keep source admission, membership, delivery and evidence resolution.

Then remove writer-exclusive helpers from `cloudflare-projection/src/core-managed-items.ts`,
`core-managed-item-intent.ts` and `core-managed-item-receipts.ts` plus their unused exports/callers.
Do not delete the whole projection executor: existing R2/D1 delivery still uses it. Replace any actual
retained-record use before removing a shared definition. Old generation fixtures are not a reason to keep writers.
Result: upload, search and new run admission work without `ai_search_generation_registry` as authority.

### 3. Remove per-run model qualification renewal

Change admission in `apps/eliotr-core/src/research-run-service.ts`, composition in `research-workflow.ts`,
and the selected consumers in `cloudflare-research-configuration/src/research-qualification-renewal.ts`
and `cloudflare-research-runtime/src/research-semantic-server.ts`.
Use connection/selection validation and the captured model/transport for the original attempt.
Remove new-run renewal markers, proof expiry/revocation gates and the renewal callback from that path.
Keep credentials, practical spend bounds, cancellation and uncertain-effect reconciliation.
Do not build another model-configuration or accounting service. Old completed results stay readable without renewing a model.

### 4. Assemble the ordinary answer, not another graph generation

Use [the answer contract](research-full-answer-v1.md). Align the actual current admission/client schema,
context builder, prompt, streamed-text extraction and materializer before adding a new route or option.
`research-run-request.v5` already exists; do not redefine it from the old proposal.
The `answer_markdown` extractor and `material_claims`-based deep response cannot be assumed interchangeable.

Prepare once, stream one synthesis, save answer and exact citations. Reuse existing context/model/output
and evidence owners. Remove branch-plan/freeze/audit obligations from ordinary admissions and dispatch.
No mandatory settings service, token event journal, second citation table or shadow executor.
Result: ask → provisional text → saved report → citation open/reopen, with the same attempt after disconnect.

### 5. Replace expensive owner reads one endpoint at a time

Choose history, project guide, catalog or Wiki/Inbox with its existing writer and client.
Maintain needed summary fields in that writer; read one bounded indexed page without opening all R2 bodies,
requalifying models or rebuilding grant chains. Remove the superseded per-item helpers on that owner path.
Preserve actual project/source access for the selected interface, pagination and honest unavailable/stale state.
Record changed query/R2/request counts. A code-size delta is not a latency measurement.

### 6. Collapse browser clients, then remove Astro

First change `apps/eliotr-web/src/app/runtime.ts` and `owner-api-client/src/legacy/http.ts` to share
one real client, not two instances plus a permanent wrapper layer. Keep epoch/disposal/error behavior.
Next migrate `pwa-source-workspace/src/raw-file-api.ts` callers to
`owner-api-client/src/sources/import/raw.ts`; delete the duplicate protocol/decoders.
Next migrate `pwa-research-workspace/src/research-run-api.ts` callers to canonical owner-client run methods.
These are distinct assignments. Integrate common exports once, through the manager.

Finish the existing React/Vite + Worker artifact and selected UI wiring. Migrate Core fixture imports from
`apps/eliotr-core/test/retrieval-q1-fixture.ts` rather than retaining old clients for a test.
Cut over with standalone Inbox/recovery and service-worker retirement; then remove `apps/eliotr-pwa`,
old controllers/styles and unused `pwa-*` dependencies. Keep a rollback artifact, not a second maintained UI.
The earlier PWA/client cohort was 21,137 lines; this is not a promise to delete every line without replacement.

### 7. Simplify source/object identity instead of porting the old machinery

Begin at `packages/contracts/src/residency.ts`, `packages/domain/src/residency.ts` and
`packages/platform-cloudflare/src/r2.ts`. Migrate one source-ingest caller/reader, then artifact storage
and evidence coordinate-map readers. Use source/revision/representation and a stored R2 locator; retain
only actual membership/retention distinctions. Reuse old locator strings or backfill them once where absent.

Remove the seven-domain serializer and transition receipts when their real callers are gone; do not
reimplement them in Rust or put an equivalent record behind a new name. Update shared ingestion types
with consumers. Remove unselected `contracts/src/owner-cutover.ts` and its exclusive vectors/adapters
with the cross-system transfer path. A local imported snapshot needs an origin reference, not bilateral cutover.
Do not merge independent objects or delete actual source history merely to simplify the schema.

### 8. Retire unselected integrations and obsolete executors

Take backup export/restore, Drive Exchange, federation, or an old exploratory executor as separate changes.
Inspect actual route/cron/Queue registrations and selected consumers. Remove the unselected registrations
and their exclusive code; having a handler is not a requirement to keep the product. Preserve ordinary
file/report downloads, `gemini-mcp`, connected-agent tasks and needed credential migration.

Backup removal starts with Core `backup-primary-composition.ts` and unused restore execution in
`backup-o2`; `apps/eliotr-core/src/erasure-runtime.ts` still uses cleanup, so do not drop both backup
packages blindly. Finish outstanding cleanup through a small existing source-linked job, not a new backup platform.
For exploratory versions, stop old admissions, settle their actual running attempts and keep/migrate saved
results. Delete obsolete handlers/codecs/fixtures together. [Workflow notes](workflow-checkpoints.md) define
why historical report reading does not require historical execution.

### 9. Collapse storage/orchestration scaffolding along the changed path

After moving one selected mutation, simplify its D1 views/triggers and intermediary intent/receipt records.
Keep unique/FK and atomic expected-revision predicates; do not move concurrency protection to a non-atomic
application preflight. A zero-row update must not allow dependent publication/outbox writes to commit.
Use existing report sections/revisions and Wiki heads; do not build a generic compiler, revision engine or event bus.
Applied schema changes need the actual ledger and an explicit migration. Unapplied prototypes can be
simplified; no required new migration for every removed helper, and no assumed production reset.

## Bounded correctness work

These can proceed independently where they touch retained code. The [audit](../../.github/audits/2026-10-17/README.md)
is evidence of the earlier source, not a mandate to preserve every audited subsystem.

| Finding | Existing path and required outcome |
|---|---|
| C01/C02/C11 | `research-session-application.ts` and `platform-cloudflare/src/r2.ts`: native conditional create; exact bounded reconciliation of same bytes/conflict/unavailable. Do not substitute an expected digest for an observation or retry a paid effect because storage observation failed. |
| C03 | Align actual HTTP, persisted input and compact checkpoint writers/readers. The earlier 256-KiB HTTP vs 64-KiB persisted-input mismatch is not fixed by raising one constant. Use a large-input reference rather than duplicate payloads in every receipt. Convert observed old inputs once or settle their attempts; no universal codec-compatibility programme. |
| C05/C10 | Align freshness response/client bounds; use set membership, not repeated linear scans. A 65-source change must not break a report because one decoder caps at 64. A sample/page states its incompleteness. |
| C06 | `artifact-cow-section-producer.ts`: local size/cardinality checks before a requested paid verifier. No verifier is added to ordinary E0/E1. |
| C07 / #378 / #379 | At final product verification, repair retained assertions/fixtures against the selected behavior. A retained case runner rejects missing/duplicate case IDs. Remove canceled replay/feature assertions with canceled code; do not preserve historical behavior just for a green test. |

## Donors: reuse a mechanism, not their product topology

The [existing donor reconciliation](../../.github/audits/2026-10-17/README.md#donor-reconciliation)
records pinned source. Reopen the specific file and its license before literal reuse; no new dependency is selected here.

| Source | Useful transfer | Do not import |
|---|---|---|
| Cloudflare native APIs | R2 conditions/checksums, D1 batch/constraints, Workflow wait/retry, managed search | Custom implementations of indexing, persistence, scheduling or proof protocols already covered by the platform |
| WeKnora | Lightweight summary reads and atomic revision changes through existing Eliot owners | GORM, an extra revision database, enterprise product topology; its count + page is not a one-query implementation |
| DocsGPT / SurfSense | Prepare context once; server maps quote/citation candidates to selected source material | Another token planner, citation identity registry, local knowledge-store architecture or regex-only injection boundary |
| Open Notebook | A compact readable research flow as reference | Its multi-call Ask graph as the ordinary one-call path; a five-search prompt hint is not a runtime bound |
| Agents SDK | Existing session/durability primitives where they remove glue | A second executor/transcript; a readonly hook alone does not replace RPC/disclosure checks |
| Other landscape donors | Only an identified function/pattern that replaces real Eliot code | Full ACL/connector/graph/knowledge-platform frameworks or their acceptance bureaucracy |

## Verification and publication

Implement first; scoped compile/lint and minimal Clippy during development. Tests and assembled-product
acceptance come later. Use the existing checks appropriate to changed SQL without inventing another analyzer.
The final product checks actual owner journeys, source citations, cancellation/reconnect and selected integrations;
old all-feature passports and proof inventories are not prerequisites. Keep real failures visible.

Publish the working replacement and what was actually removed. Keep the PR summary short: source delta,
checks executed, remaining behavior/data migration and deployed status. Do not claim that these instructions
already remove runtime code, achieve the size goal or meet ADR-0018's unmeasured latency targets.
