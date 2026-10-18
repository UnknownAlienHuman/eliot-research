# Owner reads: lists, history, reports and freshness

Implementation for the lightweight read/edit slice in [the plan](backend-entrypoints.md).
Checked 2026-10-18 against source at `3dd3a028`. These are selected replacements, not completed runtime fixes.
Implement each behavior with its real server, client and React callers; delete the replaced reader/decoder.

## 1. Project and Library lists are metadata reads

**Start here:** `packages/cloudflare-navigation/src/project-owner-service.ts`, `project-owner-storage.ts`,
`catalog-service.ts`, `catalog-queries.ts`, their Core routes and owner-client decoders.

Keep the existing product distinction:

- the owner's project list includes empty owned projects;
- source-witness/delegated discovery may omit empty projects;
- Library metadata is not a research operation;
- project membership does not own or duplicate source bytes.

For the owner path, query authenticated ownership, attachment and deletion state directly. Page metadata first;
join or batch optional readiness for those IDs. Missing readiness is `UNKNOWN` for that item, not missing access,
false readiness or failure of the whole list. Do not call a model, open R2 bodies, hydrate complete source authority
or generate summaries during a list.

Remove the owner list's policy snapshots, global mutation frontiers, orientation epochs and repeated source-policy
closure once callers use direct ownership. Keep an explicit current project/operation predicate for delegated callers;
do not turn them into owners.

### Continuation is position, not authority

Use stable keyset pagination with `limit + 1` and the last emitted unique key. Authenticate every request. A cursor is
bounded untrusted query position/filter data; it needs no SHA-256, deployment generation, mutation epoch or lease.
Changing the filter resets pages. Do not replace keyset paging with deep OFFSET, full COUNT or a snapshot registry.

## 2. Run history lists saved facts

**Start here:** `packages/cloudflare-research-runtime/src/research-run-list.ts`,
`research-history-project.ts`, owner-client history modules and `apps/eliotr-web/src/query/research.ts`.

The current reader scans up to 32 candidates to show eight. Candidate authorization can reconstruct Workflow,
report-admission and artifact lineage, read R2 and repeat currentness checks. The client decodes multiple history
and nested status generations. These bounds do not bound the work inside each candidate.

Use the existing history surface with one compact row:

```text
run id, created time, saved question, run kind, recorded phase,
report ref/title/summary when present
```

The list reads D1 only. It does not poll historical Workflows, open a report object, calculate freshness, reconstruct
MATERIALIZE/COVERAGE stages or infer completion from a locator. Detailed live status belongs to the selected run.

Persist genuinely missing summary/association fields on run admission and compact report commit. Do not add a second
synchronized read-model database. Backfill retained rows once and remove old list callbacks/decoders.

### Project filtering occurs before pagination

Current SQL searches every `project_id` inside the stored scope expression, including the excluded side of `EXCEPT`,
then rejects that row after selection. Excluded matches can consume the candidate budget and hide older valid runs.

Capture positive run-to-project attribution at admission with the existing scope walker: `EXCEPT` contributes only
its left side. Query that relation before ordering/limit. Do not infer history from today's source attachments or
retain JSON-tree post-filtering as a fallback.

Order by `(created_at, operation_id)`. Keep independent continuations for runs and reports when both collections
remain visible. It must be possible to reach older results; eight is a display default, not completeness.

## 3. Replace artifact-draft reports with direct report revisions

**Current cohort:**

- `packages/contracts/src/publication.ts`;
- `packages/cloudflare-research/src/research-artifact-draft.ts` and `research-materialize-result.ts`;
- `packages/cloudflare-artifacts/src/artifact-draft*.ts`;
- migrations `0032_artifact_drafts.sql`, `0041_research_report_admission.sql` and later authority extensions;
- `packages/cloudflare-artifacts/src/artifact-draft-read-service.ts`, reauthorization/read-authority modules;
- owner client `src/evidence/report/manifest.ts` and React `ReportPanel.tsx`.

This is not a reusable simple report store:

- `ArtifactRevision` requires `ArtifactSpec`, EvidenceFreeze and dependency manifest;
- each section requires a body object, evidence ledger and verification receipt;
- the draft writer adds reservation, binding, head, planned-object receipts, residency keys and outbox;
- report admission is tied to active Workflow stage 17;
- owner/delegated reads reconstruct original scope/grant/policy lineage;
- the client decodes three reauthorization protocols and receives authorization receipts/policy authorities.

Do not create placeholder freezes/manifests/receipts to call this writer. Replace it with the compact report state in
[the ordinary-answer contract](research-full-answer-v1.md) and [runtime notes](runtime-contract.md):

```text
report(report id, owner, head revision, deletion state, timestamps)
report_revision(report/revision, run, title/summary/language,
                one R2 object locator/hash/size, exact source revisions, created time)
```

One immutable R2 object carries Markdown, compact citation refs and bounded generation metadata. Markdown headings
are view structure, not durable section objects. A full-body revision is simpler and coherent for generated reports.

Create the object conditionally, then in one D1 transaction insert the revision, advance the expected head and attach
the report ref to the run. No internal report admission decision, object residency graph, verification receipt or
outbox is required. A real Queue consumer may still have a real outbox.

## 4. Remove the report acceptance/publication ceremony

**Current cohort:**

- React `ArtifactActions.tsx`;
- owner client `studio/artifact.ts` and legacy PWA artifact-product modules;
- `packages/cloudflare-artifacts/src/artifact-publication*.ts`, publication policy/product service;
- migration `0098_artifact_publication_authority.sql` and later extensions;
- operation intent/attempt/receipt/outbox rows used only for `ARTIFACT_PUBLISH`;
- publication receipts, publication head and mutation guard.

The current owner action says “Accept this report”. The server then revalidates section receipts and evidence
currentness, records a signed-looking owner decision/provenance, appends operation/outbox records and advances a
second publication head. Storage status `PUBLISHED` is projected as another `VERIFIED/ACCEPTED` status. This does not
make model prose true, and repository search finds `artifact.accepted` only at its producer—not at a consuming
integration.

Selected behavior:

- a completed generated report is saved and usable immediately;
- UI labels it generated/edited, never “truth accepted”;
- owner may edit it, download it or explicitly propose derived material to Wiki/Inbox;
- Wiki/Inbox proposal/review is its own meaningful action with its own target, not a prerequisite acceptance receipt;
- source changes appear through advisory freshness and exact citations, not a publication disposition.

Delete the acceptance button/status/receipt details and server/client routes after report cutover. Do not replace the
system with `accepted_at`, another publication table or a new proof badge unless a concrete product action later
requires a simple user-owned flag.

## 5. Reopen the saved report before optional freshness

The current read path reauthorizes a historical scope, compares authorization snapshots, reads section/manifest
objects and then awaits source freshness. Freshness failure can still hide otherwise readable content. A saved
report also leaks internal authorization fields into the browser DTO.

Selected owner read:

1. authenticate the owner;
2. select the exact report revision by owner and non-deleted state;
3. read its exact R2 object and verify the stored hash/size;
4. return report ref, title, summary, language, Markdown and compact citations;
5. calculate freshness separately and optionally.

The owner does not need the producing credential generation, deployment generation, policy lease, original scope
expression or stage lineage to read a retained private report they still own. A connected client must still prove
its current explicit report/operation/project grant. Report deletion/purge remains authoritative.

Remove `artifact-draft-reauthorization.v1/v2/v3`, scope authorization objects and policy/receipt fields from the
current client. Server and React change together; do not add another compatibility generation.

## 6. Freshness is advisory

A newer source revision makes the report historical, not invalid. Use one current schema:

- `CURRENT_REVISIONS`: complete saved source set compared, zero changes;
- `PREVIOUS_REVISIONS`: exact changed count plus up to 64 stable detail rows and an explicit truncation flag;
- `UNKNOWN`: no successful currentness/count claim, with a bounded reason.

Compare `report_revision.source_revision_refs_json` with current heads in D1. Compute total independently of the
bounded detail sample. A missing expected head makes the result `UNKNOWN`, not current or a smaller exact count.
Do not traverse R2, replay scopes, open every citation or compute freshness for every history row.

Exact citation opening remains separate: authenticate, load the retained source revision/readable object, apply
actual deletion/disclosure, and return the bounded range. Never redirect to the latest bytes.

## 7. Edits are expected-head full revisions

Current `artifact-section-revise.ts` starts another Workflow, renews REPORT admission/source witnesses, creates a COW
child artifact, invokes a model and reconciles another attempt state. That is another research engine hidden behind
“Revise this section”.

Selected manual edit:

1. read exact current report revision;
2. submit bounded complete Markdown/citation state plus expected head;
3. create one immutable object;
4. insert one `report_revision` and conditionally move the report head;
5. return conflict on zero affected rows.

No in-place mutation of body/provenance and no section child graph. Reports are bounded generated documents; a full
body is the simplest coherent edit unit.

If AI-assisted revision is later selected, admit one explicit model attempt against the chosen report/source refs,
retain its completed Markdown, then call the same report writer. It does not get a COW Workflow, report-admission
witness, section ledger or acceptance prerequisite.

Wiki should follow the same expected-version rule even before storage is consolidated. WeKnora's useful pattern is
`expected version → snapshot/write atomically` and body-free revision listings. Do not copy its auto-link/meta
updates that write by page ID without the same expected version. Decoration is render-time or a new revision.

Extract a shared revision helper only after both current report and Wiki callers use the same small operation and it
removes code. Do not build a generic content framework first.

## 8. Data transition and deletion

Before destructive migration, inspect deployed retained rows. Convert each real saved report once:

- preserve stable report identity/revision where practical;
- read the verified current Markdown and compact/convert its citations;
- preserve originating run, title, language and creation time;
- write the new immutable object and report/revision rows;
- verify object hashes/counts and run/report associations.

The conversion does not migrate artifact-publication receipts as product truth. If an old report was accepted,
preserve that only as bounded migration diagnostics when needed to audit the conversion; do not recreate the
acceptance platform or expose the old receipt in the new product.

Switch current writer, status, history, report read, export, edit and React callers. Then delete the old report-
specific artifact/admission/freeze/manifest/verification/publication/COW tables, code, contracts, routes, protocol
decoders and fixtures. Do not keep a fallback reader; Git history is the archive.

## Donor and platform decisions

- **SurfSense:** generation outlives the follower; finalization is disconnect-safe; adjacent deltas are batched.
  Do not copy its transcript DB or in-memory replay list of every frame.
- **WeKnora:** expected-version writes and body-free history. Do not copy GORM topology, COUNT+OFFSET or blind
  auto-link/meta writes.
- **ThinkEx:** retaining a readable result when optional enhancement fails is useful. Its provider work and publish
  occur in one Workflow step; Eliot splits paid generation from publication because the step can retry.
- **Cloudflare:** R2 conditional create and D1 batch transaction are sufficient. They do not form a distributed
  transaction; an unreferenced immutable object is reconciled/cleaned rather than wrapped in two-phase proof.

No donor code or dependency is imported.

## Completion

During implementation use scoped compile/lint. After assembly exercise empty projects, independent pagination,
EXCEPT filtering, save failure after completed generation, report head conflicts, unavailable optional freshness,
65 changed sources, actual access/deletion failures, manual edit conflict and conversion of retained reports.

Complete means the new writer/readers/edits work through real callers and the old report artifact, acceptance and COW
cohorts are gone—not hidden behind adapters.
