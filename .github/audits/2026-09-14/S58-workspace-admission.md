# S58 — Workspace export → authorized capture → conversion → admission

Baseline: `a2aca127`; ER-36/37/21/24. Requires the common S10/#202 authorizer/schema and S31/#223 owner issuance, not the entire Research engine. This is an assignment, not implemented code. Previous review found a missing link: workspace admission takes existing capture_id/conversion_operation_id, but their raw capture/read/conversion endpoints are owner-only. Authorizing only the final admission call does not complete headless import.

## 1. Problem

An MCP connection, client receipt, or authorized final admission does not establish that a service client can upload and convert the file. An end-to-end test must not hide this gap by creating privileged owner captures behind the scenes.

## 2. Required change

Complete this existing path for selected gemini-mcp:

`official client connector Drive export/read → v2 plan/observation → raw capture/read → Markdown conversion → workspace admission/status → SourceRevision/readiness`.

Apply project_client_grant with workspace.admit and explicit ingest_namespace_ids to every necessary boundary, not only the last call. S98's normalized-bundle path is separate and does not prove the raw Workspace pipeline. Do not write another importer or converter.

## 3. Documentation and exact search anchors

[ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), [Workspace service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/apps/eliotr-core/src/workspace-candidate-admission.ts), and [raw transport](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-raw-ingest/src/raw-capture-http.ts).

```sh
git grep -n -F 'does not receive Google credentials' -- docs/adr/0006-google-external-transport-profiles.md
git grep -n -F 'parseRawFileCaptureRequest' -- packages/cloudflare-raw-ingest/src/raw-capture-http.ts
git grep -n -F 'WorkspaceCandidateAdmissionRawNormalizedPort' -- apps/eliotr-core/src/workspace-candidate-admission.ts
```

## 4. Implementation approach

**Transport.** Preserve existing raw routes and upload headers: Content-Length, Content-Type, Idempotency-Key, x-eliotr-original-file-name, x-eliotr-content-sha256, x-eliotr-source-namespace-id, and the paired target-source/expected-head headers for updates. Services must provide an explicit namespace and S10's X-Eliotr-Client-Grant locator. Existing owner requests without delegation remain compatible. Do not add another uploader or ticket service.

**Workspace binding.** Before capture, the service identifies an existing observation through the proposed X-Eliotr-Workspace-Observation-Id locator. This header is not proof. Load the plan/observation from the existing candidate store; check authenticated-actor access, WorkspaceOwnerAuthorization, transport/plan, exported-byte digest/length, and the namespace ceiling. Preserve legacy logical identity with its separate owner authorization. The static gemini-spark label alone does not authenticate a new client. Unprovable binding denies capture.

**Storage and dispatch.** Generalized capture/read/conversion/admission receive one server-created typed authorization context containing the actual service principal, grant/observation binding, and permitted namespace. It cannot be supplied as request JSON or obtained by changing client_class to owner_pwa. Persist capture/actor/observation/grant links through existing immutable metadata/admission bindings; use an additive migration only if current storage lacks the required linkage. Do not rewrite historical receipts. Each later read/convert/admit/status reconstructs the stored binding and rechecks current rights rather than trusting a newly supplied namespace.

**Spend and admission.** workspace.admit alone does not authorize paid inference. Check existing policy/reservation when managed conversion requires spend authority; a rejected service conversion must not secretly fall back to privileged owner conversion. Preserve original immutable bytes and qualify converted output without fabricated coordinates. A caller receipt remains an untrusted observation. Eliot byte readback proves its received payload, not automatically the external Google action. Google I/O runs through the client's separately authorized official connector; no Google OAuth secrets, custom OAuth server, or Cloud project are introduced into the Worker.

**Recovery.** Partial upload, lost response, UNKNOWN conversion, and repeated admission reconcile original IDs. Do not blindly repeat an unknown paid conversion or Google creation action. Project attachment is a separate authorized S98 action using the same grant; admission does not attach sources to arbitrary projects. Do not evade conflicts by inventing another source identity.

## 5. Acceptance criteria

- [ ] Start without a prepared capture/conversion: the owner API issues a grant and the service itself uploads, converts, admits, and reads status. No hidden owner JWT, direct INSERT, or owner-only call supplies missing steps.
- [ ] One export produces the exact original capture digest and one admitted revision/outbox; readback/replay/restart/lost ACK do not create duplicates.
- [ ] Read-only grants, unknown/foreign observations, substituted grant/namespace/capture, altered bytes, mid-operation revocation, expired policy, and insufficient conversion budget fail at the appropriate boundary.
- [ ] A later header cannot replace stored grant/observation provenance. Grant expansion cannot rewrite old capture provenance; current denials remain effective.
- [ ] Existing owner raw-upload/admission regressions pass. Local HTTP/D1/R2 acceptance is distinct from actual Antigravity/Spark export/readback; unverified external actions are not LIVE_QUALIFIED.
- [ ] Record exact SHA, commands, observed identities/outcomes, and secret-free evidence. No second import framework is added.
