# Preservation branch reconciliation — current-main dispositions

Date: 2026-10-08  
Current source baseline: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`

This document reconciles the three open preservation-only pull requests against current `main`. It is a source-preservation audit, not a request to merge or delete their branches.

Disposition vocabulary:

- `INTEGRATED_EVOLVED` — the behavior exists on current main in a later or stricter implementation.
- `SUPERSEDED` — the historical artifact is no longer the owner or current contract.
- `REJECTED_OLD_VARIANT` — a historical sub-delta was deliberately not retained because current code has a narrower, tested rule.
- `PRESERVE_ONLY` — retain source history; never merge wholesale.

## PR #173 — Research citation-resolution WIP

Retained head: `df9f814131c3cb7e033f0b56c362bea030242c8c`  
Compared with current main: 20 commits ahead / 866 behind; five final changed paths.

| Preserved path | Current-main owner | Disposition | Evidence / difference |
|---|---|---|---|
| `packages/cloudflare-research/src/research-citations-result.ts` | `packages/cloudflare-research-stages/src/research-citations-result.ts` | `INTEGRATED_EVOLVED` | v1 whole-audit payload became a compact v2 receipt with explicit investigation/audit/verification lineage, bounded server text, strict claim identity, resolver-receipt digest verification and `MAX_WORKFLOW_RECEIPT_BYTES`. |
| `packages/cloudflare-research/src/research-citations-stage-handler.ts` | `packages/cloudflare-research-stages/src/research-citations-stage-handler.ts` + `research-citations-stage-execution.ts` | `INTEGRATED_EVOLVED` | Handler is split from effect/recovery execution, validates dependencies, exposes `recoverStartedAttempt`, composes with the canonical post-synthesis freeze reader and is wired by `cloudflare-research-runtime`. |
| `packages/cloudflare-research/src/research-committed-lineage.ts` | `packages/cloudflare-workflows/src/committed-lineage.ts` | `INTEGRATED_EVOLVED` | The helper moved to the workflow owner and is reused by citation, coverage, materialization, branches, run readers and Artifact COW. |
| `tests/integration/browser/library.spec.ts` | same path on main | `INTEGRATED_EVOLVED` | `verifyAsyncLaunchTerminalRegression` and its 202-before-duplicate-abort test are present on main. |
| `tests/integration/browser/owner-e2e.mjs` | same path on main | `INTEGRATED_EVOLVED` | The matching harness function is present and consumed by the browser spec. |

No current-main delta should be extracted from #173. The preserved v1 result is weaker than the current v2 contract and must not be reintroduced.

**PR disposition:** `SUPERSEDED / PRESERVE_ONLY`; close without merge. Branch deletion is not required.

## PR #174 — Research coverage/report-admission WIP

Retained head: `1abf2fa09ee78c3daa8bb0073b42630e1cb00e8c`  
Compared with current main: 20 commits ahead / 866 behind; twelve final changed paths.

| Preserved area | Current-main owner | Disposition | Evidence / difference |
|---|---|---|---|
| `0041_research_report_admission.sql` | identical path | `INTEGRATED_EVOLVED` | Exact blob SHA on branch and main is `cfd561a15a540510b7af7c8773fe9aec7a2e9a14`; later migrations extend project-client/read authority and D1 expression-depth handling. |
| Artifact-draft admission bridge | `packages/cloudflare-artifacts/src/artifact-draft-types.ts`, `artifact-draft.ts`, Artifact COW materialization | `INTEGRATED_EVOLVED` | `ArtifactDraftAdmissionPort` remains the server-only bridge; final intent/outbox/draft transaction stays owned by the artifact store. |
| REPORT admission/config | `packages/cloudflare-research/src/research-report-admission*.ts`, `research-report-config.ts` | `INTEGRATED_EVOLVED` | Contract was split, current policy/currentness checks retained, downstream run/read authority added. |
| Report materialization | `research-report-materialize-stage-handler.ts`, `research-materialize-stage-handler.ts`, runtime configured handler factory | `INTEGRATED_EVOLVED` | The handler is part of the configured v3 factory; metadata does not mint authority. |
| `research-coverage-result.ts` v1 | `packages/cloudflare-research-stages/src/research-coverage-result.ts` v2 | `INTEGRATED_EVOLVED` | Historical impossible condition `requested_count !== cited_source_refs.length && requested_count < 0` is gone. v2 calls domain coverage validation, checks unique eligible/represented/cited/omitted sets, binds Stage15 lineage and resolver digest, and permits `NO_MATCH_IN_COMPLETE_SCOPE` only with a complete denominator. |
| Report-admission tests/docs | current core tests and `workflow-checkpoints.md` | `INTEGRATED_EVOLVED` | Current docs describe the configured report composer and sole final transaction owner. |

No current-main delta should be extracted from #174. Copying its v1 coverage codec would reintroduce a known validation defect and weaker lineage.

**PR disposition:** `SUPERSEDED / PRESERVE_ONLY`; close without merge. Branch deletion is not required.

## PR #121 — N1 integration bundle

Retained head: `f1e678cc20eec9787d2c803f65a2ac0426827f0d`  
Compared with current main: 10 commits ahead / 1961 behind; 65 final changed paths across multiple owners.

The octopus integration commit is not a valid modern implementation branch. Its component commits reconcile as follows.

| Commit | Historical purpose | Current disposition | Current-main result |
|---|---|---|---|
| `e275629` | ER-37 `d1-ingest-commit` delegation | `INTEGRATED_EVOLVED` | Current `d1-ingest-commit.ts` validates canonical decision/qualification, promotion objects, digest, residency/current policy, source/head/readiness and atomic intent/outbox settlement. The old temporary helper split is not the current package boundary. |
| `60d85a2` | ER-01 promotion-readback contracts/schemas | `INTEGRATED_EVOLVED` | Promotion/readback identity is enforced by current `ingest-promotion.ts`, `ingest-state.ts`, `d1-ingest-commit.ts`, normalized bundle schemas and current tests. Historical `packages/contracts/src/validation/*` placement was later replaced and must not be restored. |
| `698fa38` | ER-14 per-object R2 readback | `INTEGRATED_EVOLVED` | Current promotion receipt retains canonical key, object digest/size, readback digest and exact commit checks; live qualification remains separately pending. |
| `c23fa49` | ER-05 structural navigation derivation | `INTEGRATED_EVOLVED` | The pure implementation now lives in `packages/retrieval/src/structural-navigation.ts`, is consumed by Cloudflare navigation materialization/expand paths and has focused structural tests. |
| `75af941` + `2201c69` | historical Corpus Lens status/docs and partial revert | `SUPERSEDED` | Current architecture, packets, status and launch documents are newer; these historical status hunks are not execution authority. |
| `6b7427e` | ER-31 persisted navigation tests | `INTEGRATED_EVOLVED` | Current `navigation-persistence.test.ts`, structural navigation tests and D1/native-coordinate tests retain persistence, replay, authority and corruption negatives. |
| `f895dd7` | ER-24 structural orientation contour | `INTEGRATED_EVOLVED` | Current `orientation-authority.ts`, `orientation-materialization.ts`, `orientation-service.ts` and navigation callers contain the structural-first path and honest degradation. |
| `488a99d` | octopus integration of seven owners | `PRESERVE_ONLY` | Never merge wholesale. Each useful child delta has a current owner; cross-owner history and stale contracts make the aggregate branch unsafe. |
| `f1e678c` | provisioner forced-exit repair | `INTEGRATED_EVOLVED` plus `REJECTED_OLD_VARIANT` | Current owned provisioners contain no `process.exit(0)` and have a dedicated regression test for natural success completion on Windows. Current code deliberately preserves immediate nonzero `process.exit(2)` argument failures; the test documents that those paths do not have the pooled-fetch success-path hazard. |

### N1 bundle conclusion

No missing current-main behavior was found that should be extracted from #121. The useful source slices are present in later owners; temporary validation placement, stale status files and the octopus merge are superseded. The only apparent textual difference in provisioners — retained `process.exit(2)` — is deliberate and regression-tested, not an unported fix.

**PR disposition:** `SUPERSEDED / PRESERVE_ONLY`; close without merge. Branch deletion is not required.

## Result

```text
#121  SUPERSEDED_PRESERVE_ONLY
#173  SUPERSEDED_PRESERVE_ONLY
#174  SUPERSEDED_PRESERVE_ONLY
```

Preservation reconciliation is complete. These branches are historical evidence, not implementation queues. Future agents start from current main and the active owners in PR #327.