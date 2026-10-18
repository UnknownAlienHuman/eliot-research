# Owner reads: lists, saved reports and freshness

Implementation for task 3 in [the plan](backend-entrypoints.md), not another product specification.
Source inspected at `a5f53d0d` on 2026-10-18. The changes below are selected work, not completed fixes.
Implement catalog, history and freshness as separate end-to-end changes with their actual callers.

## 1. Project and Library lists: metadata is not a research operation

**Code:** `packages/cloudflare-navigation/src/project-owner-service.ts`, `project-owner-storage.ts`,
`catalog-service.ts`, `catalog-queries.ts` and `orientation-authority.ts`.
Core routes compose them; `packages/owner-api-client` owns their browser decoding.

Keep the distinction already present in the code. `createProjectOwnerCapability.list` selects projects by
`project_owner`; `readCatalog` selects projects with a readable source witness. The latter deliberately
omits empty projects. It is not a replacement for the owner's project list. Empty owned projects must remain
visible, including after removing their last attachment. Library metadata and delegated discovery are also
not interchangeable access surfaces.

The current catalog already batches SQL and does not read R2 here. Its excess work is the subsequent
`authority.sources` loading, repeated policy/admission decoding, per-source policy-closure computation,
`orientation_authority_epoch` reads and `catalogTimeFrontier`. That frontier includes unrelated admissions
and memberships. Do not report this as an R2 optimization or remove all source authorization wholesale.

For the owner path, query the authenticated owner's metadata and current attachment/deletion state directly.
Use actual ownership associations: `project_owner`, and namespace provenance such as
`source_namespace_initialization.principal_ref`; a system ID is not a principal ID. Verify/backfill an
unmapped retained namespace once from its real provenance, not by granting the current caller every row.
Move the relevant writer with the query. Namespace creation, source admission and recorded indexing state
remain distinct facts; an indexing failure does not make a retained Library item disappear.

Replace the owner list's expiring policy/fingerprint chain with that direct ownership predicate. Do not
change a delegated caller into an owner: retain its operation/project check at ingress and query filtering.
Keep shared helpers only for remaining real consumers, not as permanent forwarding wrappers.

Page metadata first, then fetch optional readiness rows for those IDs in one bounded batch, or join them
without multiplying the page. Missing/invalid optional readiness is UNKNOWN for that item, not false READY
or failure of an otherwise authorized list. A bad identity or an unestablished access boundary is not optional.
Do not call the provider, hydrate complete source authority or create summaries by opening files during a list.

### Continuation belongs to the query, not a deployment proof

Keep existing ID ordering for projects/sources. Use `limit + 1` and the last emitted key. Authorize every
request independently; a cursor is untrusted position/filter data, never authority. Validate its bounded
shape and query association. It needs no SHA-256, session/deployment generation, global mutation epoch or
five-minute lease. Remove those owner-cursor producers, decoders and retry loops together.

Use a stable unique tie-breaker for any non-unique sort. Do not replace keyset paging with deep OFFSET or
full COUNT on every page. [SQLite's scrolling-window example](https://www.sqlite.org/rowvalue.html#scrolling_window_queries)
explains this tradeoff. Live browsing is not a frozen snapshot: concurrent inserts may appear on refresh;
changing a filter resets its pages. Deduplicate by stable row identity. Do not promise snapshot completeness
or build a snapshot registry for navigation. This replaces the cursor contract, not the whole routing stack.

## 2. Run history: list saved facts, not reconstructed execution

**Code:** `packages/cloudflare-research-runtime/src/research-run-list.ts`,
`research-history-project.ts`; `packages/cloudflare-research-stages/src/research-historical-coverage-reader.ts`;
`packages/owner-api-client/src/research/history-changes/history.ts`; `apps/eliotr-web/src/query/research.ts`.

`scanVisibleRecent` currently scans up to 32 candidates per collection to emit eight. Candidate processing
calls run/artifact authorization; report association can read MATERIALIZE/COVERAGE lineage and R2, then
repeat currentness checks. These bounds do not bound the work inside each candidate. The client decodes six
history generations and a full nested run-status object. None of that is needed to display a recent row.

Use the existing `/api/v1/research/runs` surface and one compact summary DTO: run ID, creation time, saved
question when present, recorded execution state and saved artifact reference when present. Do not synthesize
completion from a report locator or turn recorded status into a claim of live engine observation. Detailed
progress is the existing selected-run read. Do not poll each historical Workflow while listing.

Join existing D1 run/admission/artifact bindings and the actual owner-reader origins. Preserve owner-visible
agent results through `owner_machine_run_origin` / `owner_artifact_read_origin`, not the agent's expired
execution lease. Enforce current report/metadata deletion and access disposition in this read. No list-time
`prepare_artifact_read`, historical checkpoint reconstruction or fallback R2 locator lookup is required.

The admission and report writer own missing summary facts. `research_report_admission`,
`artifact_draft_binding`, `artifact_revision` and the saved question already provide much of the association;
use them before adding storage. Persist a genuinely missing locator with the report commit. Backfill actual
retained results once; no per-request migration or second synchronized summary database. Remove the old list
callbacks and unused history-version branches with the server/client replacement.

**Project filtering:** the current SQL searches every `project_id` in `json_tree`, including an EXCEPT
right-hand operand. `scopeIncludesProject` then rejects that row after selection. Excluded-project matches
therefore spend the 32-candidate budget and can hide older matching history behind BUDGET_STOPPED.
Resolve positive project attribution once in admission using the existing scope walker; EXCEPT contributes
only its left side. Store/query those associations with the run, using the existing captured relation where
it suffices; a missing indexed run-to-project relation belongs to that same writer, not a new service.
Do not infer historical attribution from today's source attachments. Validate/convert older scope associations
once rather than retaining the post-filter scan as a hidden fallback.

Keep separate continuations for runs and saved drafts; one collection exhausting its page does not exhaust
the other. Order by `(created_at, operation_id)` and `(created_at, artifact_id, revision)` respectively, with
matching predicates and indexes. Preserve eight as the current default display size, not a completeness claim.
Add continuation to the existing client/query/UI together. It must remain possible to reach older reports.

## 3. Reopen and freshness: useful content must not depend on optional enrichment

**Code:** `packages/cloudflare-artifacts/src/artifact-draft-read-service.ts` (`prepare`, `reopen`),
`packages/cloudflare-wiki/src/wiki-service.ts`, navigation `source-revision-freshness.ts`,
client `evidence/report/manifest.ts`, `studio/wiki-read.ts` and `studio/wiki-types.ts`.

The current report reader finishes content authorization/readback and then awaits freshness; a failure there
still rejects reopening. The server emits all changed scope members, while the inspected report and Wiki
client decoders cap details at 64. The server also repeats `refs.includes` inside a loop despite already
checking each page's membership. Raising one cap or adding another retry does not resolve this contract.

Authorize the saved report itself, then load its stored content. Head freshness is advisory enrichment;
run/model qualification, search readiness and current source-head equality do not establish report access.
A newer source revision makes the report historical, not invalid. A failed optional comparison yields UNKNOWN
without discarding a successfully authorized report. Do not turn an authorization error, purged/withdrawn
report or unknown report-access disposition into a successful read through a catch-all fallback.

Use one shared freshness schema for the server and both current clients, with three outcomes:

- CURRENT_REVISIONS: the complete retained source set was compared, zero changes.
- PREVIOUS_REVISIONS: exact `changed_source_count`, and up to 64 `changed_sources` in stable order;
  `changes_truncated` explicitly says whether the details are only a sample.
- UNKNOWN: no successful count or currentness claim; carry a bounded unavailable reason, not invented zeroes.

Put the schema in `packages/contracts/src/source-freshness.ts` and replace the duplicated interface/client
rules. Keep this one concrete shared contract, not a generic decoder framework or another protocol generation.
Use the admitted source-identifier type rather than independently narrowing its alphabet/length in each UI.
Update `packages/interfaces/src/semantic-api.ts`, server producers and current browser consumers together.
Migrate still-served PWA callers to the same decoder or retire them at cutover, not to another copied schema.

Compare the saved revision set with current heads in SQL; compute the total independently of the bounded
detail sample, in the same read transaction/batch when split. Use set membership for any residual in-memory
validation. Missing expected source-head rows make the comparison UNKNOWN, not current or an exact
smaller change count. Do not traverse R2 or rebuild scope/grant proofs to calculate head differences. Do not compute whole-report freshness in every history row.
Exact citation opening remains a separate source-revision/range read. An unavailable citation does not get
silently redirected to current bytes. Apply real deletion policy to derived private content; this separation
is not permission to keep serving a report that itself must be removed.

## 4. Reuse donor operations, not their accidental semantics

[WeKnora at `005627b1`](https://github.com/Tencent/WeKnora/blob/005627b180c6c7509660b0a14401e463f48d53f8/internal/application/repository/wiki_page.go)
separates `ListRevisions` (no content body) from `GetRevision`, and has `UpdateWithRevision` plus expected-
version handling. Apply those ideas to existing Eliot readers/writers. Do not copy GORM, its COUNT+OFFSET
paging, multi-dialect code or a second revision store.

Its `UpdateAutoLinkedContent` writes content by ID without an expected-version predicate or version increment.
Do not copy that mutation into immutable reports/Wiki history: it could overwrite a concurrent edit or alter
what a saved revision means. Presentation-only link decoration stays a view; substantive persisted edits
create a revision through the existing writer. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
rolls back failed statements, not a successful zero-row update; dependent writes need the same successful
transition predicate. A post-batch row-count check alone cannot undo already committed companion writes.

References were inspected on 2026-10-18; donor code is a pinned pattern reference, not imported source.
No new library, read-model service, compatibility layer, audit registry or cryptographic cursor is selected.

## Finish the behavior

During implementation use scoped compile/lint. After assembly exercise empty projects, independent paging,
equal sort timestamps, EXCEPT-only matches before a real match, 65 changed sources, unavailable optional
freshness and actual access/deletion failures. Report list D1/R2/Workflow call counts separately from latency.
Verify that still-needed metadata is written on the actual mutation path and the replaced readers/codecs
are gone. Do not create another test campaign, metric gate or approval sequence before implementing this.
