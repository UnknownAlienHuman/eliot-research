# S98 — Complete machine bundle ingestion and explicit project attachment

Baseline `a2aca127`; ER-24/29/14. Inputs: common S10/#202 grant, owner issuance S31/#223, and the existing normalized-bundle importer. This is proposed implementation, not an already working path. S58/#250 separately covers Workspace raw export/conversion; ordinary machine ingest requires no Google integration.

## 1. Problem

Machine read/query/run is incomplete without adding a source. The earlier optional project.attach wording left the final source→project→research step undefined. Ingestion permission must not become unrestricted project editing or source ownership.

## 2. Required change

Complete existing bundle discover/prepare/parts/file-complete/commit/status/recovery for a service with ingest.bundle and explicit ingest_namespace_ids. Then attach the admitted source through separately granted project.attach. Both use the shared project_client_grant/DTO from S10.

Use existing `PUT /api/v1/research/projects/:project_id` and UpdateProjectRequest: title, source_ids, expected_revision, idempotency_key. For service project.attach, permit only additions: title unchanged, all current sources retained, and no owner/project metadata changes. Other project mutations remain owner-only. Do not add another project namespace or membership API.

## 3. Documentation and exact search anchors

[Routes](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/routes.ts), [Project DTO](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/interfaces/src/project-owner-api.ts), [project service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/project-owner-service.ts), [ER-29](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-29-source-acquisition-admission-and-qualification.md).
```sh
git grep -n -F '/api/v1/ingest/bundles/prepare' -- packages/interfaces/src/routes.ts
git grep -n -F 'export interface UpdateProjectRequest' -- packages/interfaces/src/project-owner-api.ts
```

## 4. Implementation approach

**Ingest:** X-Eliotr-Client-Grant is a locator, not a credential. Check verified caller, grant/project, bundle namespace, current grantor writer/admission policy, and owner generation before upload and canonical commit. An empty namespace set is not a wildcard. Bind operations durably to the authorized actor/grant/namespace; later status/recovery cannot substitute another binding through headers. Generalize genuinely owner-only storage/caller restrictions with additive migration where required, never by forging owner_pwa context. The delegate does not become mutable owner.

**Attach:** decode the existing PUT DTO, read the current project head, check expected_revision, and permit only unchanged title plus a superset of current members. Every addition must already be admitted, authorized to the grantor, in a permitted ingest namespace, and compatible with residency/disclosure rules. A new source need not already be a project member—that would make attachment impossible. The separate source/namespace ceiling authorizes adding it; it does not grant namespace-wide read access.

Reuse the existing guarded project CAS/membership/outbox transaction rather than copying its SQL into a new service. Recheck permissions and append-only semantics at settlement, not only before external I/O. Reject rename, removal, metadata changes, or foreign additions as an entire request; never silently strip disallowed changes. Concurrent edits conflict rather than overwrite. Identical replay returns its existing receipt without new temporal membership.

Preserve bundle validation, quality/admission/residency, exact byte readback, and partial-upload exclusion from retrieval/context. Offline processing is not admission proof. New queries see newly committed membership; historical runs retain original frozen members. Neither permission automatically authorizes paid preprocessing or ownership cutover.

## 5. Acceptance criteria

- [ ] From a clean database, the owner issues explicit grants through the API; an independent service imports, attaches through the existing PUT, then queries/runs/opens citations without browser cookies, Google, or manual SQL.
- [ ] One admitted revision/outbox and expected membership revision survive repeated upload/attach, lost ACK, and restart without duplication.
- [ ] Read-only grants, wrong namespace, revoked authority, changed owner, corrupt bytes/maps, stale heads, and invalid residency fail before canonical mutation.
- [ ] Service rename/detach/metadata changes and foreign/unadmitted additions fail atomically; a not-yet-member source succeeds only with valid attachment permission and source ceiling.
- [ ] Before/after queries reflect the membership change without expanding old run/history scopes. Retain actual HTTP/D1/R2 tests, owner regression, a wire example, exact SHA, and results; declaring an operation enum is not completion.
