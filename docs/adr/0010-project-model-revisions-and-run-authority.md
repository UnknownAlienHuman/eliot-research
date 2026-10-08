# ADR-0010: Project model revisions and current run authority

- Status: accepted for the owner-directed model configuration amendment.
- Date: 2026-10-03.
- Scope: owner template v2, exact project selection and immutable run capture.

## Decision

Owner settings describe durable choices. Authentication, grants and execution
leases describe current permission to act. A new browser session, a UI release
or the age of a model observation does not itself invalidate v2 owner settings.
This amendment preserves the original readers and expiry rules for v1 records.

| Field or check | V2 owner configuration | Every execution |
| --- | --- | --- |
| Owner, project and source/disclosure scope | Retained | Current owner, project generation, scope and grant checked |
| Model, provider, billing mode and BYOK alias | Exact versioned selection | Exact saved transport and provider/model observation checked |
| Prompt, schema, parameters and pricing | Retained in the configuration revision | Exact deployment and request digest checked |
| Model qualification | Exact candidate/proof refs and hashes retained | LIVE tier, exact identity and explicit revocation checked |
| Qualification calendar expiry | Historical observation; alone does not block v2 | V1 still enforces its original proof expiry |
| Owner setting sunset | Optional explicit owner decision | Enforced when supplied |
| Worker release generation | Removed from v2 owner spend/report templates | Current execution generation checked; original run capture retained |
| Browser credential generation | Bound at execution rather than copied into durable settings | Current authenticated credential and effective grant checked |
| Scope/grant/task/W2/W3 deadlines and budget | No manufactured owner-setting lifetime | Current cancellation, deadlines, reservation and spend authority enforced |

The live model catalog is descriptive and does not grant inference permission.
Migration 0106 stores immutable project configuration revisions and a selected
head. Selection/import requires current project ownership and generation at
the D1 commit, exact canonical bundle bytes and qualified model pins. Stale
compare-and-swap requests cannot consume history; exact acknowledged-or-lost
retries reconcile against the same next revision and content.

Migration 0104 captures that selected revision once per new run, before workflow
creation. Recovery uses the capture, including stage-specific transport policy,
rather than following the current selected configuration or active route head.
Only runs explicitly marked as predating capture keep the installed legacy path.
Migration 0105 adds explicit qualification revocations and checks original run
lineage and exact configuration/candidate/proof pins at execution admission.

The selected transport controls supported token/reasoning fields. BYOK keeps an
existing credential alias and refuses an implicit change to Unified Billing.
Unsupported request formats fail before inference. Configuration changes do not
grant new source access or create provider credentials.

## Boundaries

This decision changes the corresponding owner configuration mode; it does not
replace ModelRoutePort, the Research workflow, source/evidence authority, financial
history or Access/Managed OAuth. Existing immutable manifests and receipts are
not rewritten. Historical COW verification uses its originating run capture.

Implemented code, local checks, deployment, live functional receipts and release
acceptance remain separate. This ADR is not a live qualification receipt.
