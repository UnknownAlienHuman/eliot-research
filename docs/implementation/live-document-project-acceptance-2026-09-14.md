# Live document and project acceptance — 2026-09-14

The later owner workspace deployment is `d54539f`, Cloudflare version
`2d2bf002-5d17-4a3e-83da-8c65583f71ec`. Earlier evidence below was collected at
generation `git-e027ebe`, deployment version `eb28deea-e5cd-422a-8a2e-8b3c06919b9a`,
and remains historical. This note records the bounded document and first
project slice evidence without claiming that the later changes solved either
the project update or research workflow.

## Recorded implementation slices

* `0645b8f` — project/PDF decode and timeout handling.
* `6cbed7b` — project title `oninput` handling.
* `7a2c34a` — the project SQL missing-`AND` and membership-witness fixes,
  together with the owner session panel changes.

## Live evidence

* Empty project `project-cf376e32c6b61ca3be479e341db27110370e20d62355b0a2`
  was created successfully at `2026-09-14T04:20:08.839Z`, revision 1.
  Its first title update returned `PROJECT_SETTLEMENT_UNCERTAIN` and the
  database remains at revision 1 with no active memberships and no update
  receipt. The later failure tail was D1 `Expression tree too large (max depth
  100)`; the project update fix remains pending.
* PDF conversion operation
  `55fefa4ccb4711372300eacf96a421148fd59f2c4bfe085803435ebc103e064c`
  is `COMPLETE`, with 731 bytes and SHA-256
  `2b2e98d7ef1344b05ef1ea855fa0f69ca6f8207007531377f420e75ed94d13ac`.
  Admission receipt
  `34cc2340a365883d03a04af1c5e7a6be4133f352e67b16ab4404fc4e31894d01`
  is `QUARANTINED` because of
  `RAW_MARKDOWN_CANDIDATE_NO_SOURCE_MAP`; its quality is degraded. This is
  not treated as an admitted document.
* The Cloudflare Access application readback confirms a 24-hour session
  changed to 168 hours while retaining owner-only access and the existing
  policy.

## Subsequent document readback

The owner namespace `namespace-3836a5d16b6e0712b435b04384bde6c74a32e9b15368fb0f9a497bfe6deb9771`
(`Документы`) has two admitted document revisions. The DOCX admission is
`14a0e6e81653b56c4ed286300b55a95503f78dfe25a85961`, revision
`raw-revision-17ff19b637696fec16cea180d73727cd18518dbe29ec11d2`; the PDF
admission is `e8f2d4bba54083d0e1207ca03e0a1693dcffcc03b8f3b226`, revision
`raw-revision-f55f6b42411b2337a699e45e6b9b1ea68274e9386b567914`. Both were
read back as `ADMITTED` in the owner namespace. The PDF conversion operation
`adbbdda6b31e89f0f73fd0f4ba1fd97b561fac5d8f3109e0a8dbfdeb5f8a075e` completed
with 731 bytes and SHA-256
`2b2e98d7ef1344b05ef1ea855fa0f69ca6f8207007531377f420e75ed94d13ac`.

Document search for `Орбита` over the two current source IDs returned one
verified DOCX excerpt, UTF-8 byte range 57–320 (263 bytes). Its evidence
receipt is `evidence-resolution-046b4505a46b2fe4c487adf6db6b108c0460a7def20b396d`,
with source revision `raw-revision-17ff19b637696fec16cea180d73727cd18518dbe29ec11d2`,
scope `scope-ebbae0db1b7394a53d93fa36086c41154daf81cad3dd8e81`, and pack
`pack-44618ea8f1db07894551e64f5fd8b7e94892c8654714eea1`.

The owner namespace renewal readback kept the same owner-only policy and
`research` use, advanced read-policy generation 1 to 2, and renewed access
through `2026-09-21T05:09:28.000Z`. That renewal preceded `d54539f`; Library
remained stale until the page was reloaded. After `d54539f` deployed the
lifecycle-event fix, a reload showed three sources. No second live
expired-workspace renewal has been observed after that deployment. The owner
browser login succeeded through Gmail OTP; no Google IdP integration was
present, so this was a one-time PIN flow. This does not change the pending
project update state above.

## Current deployment and limits

Deployment `d54539f` carries the reviewed W2 configuration `retries.limit: 0`
and a 600-second model-stage lease. No new run has yet produced a persisted W2
readback under this deployment. These facts describe execution policy; they do
not prove a successful project update or research result.

## Owner namespace renewal contract

The authenticated owner API exposes `POST /api/v1/library/namespaces/:namespace_id/renew`.
Its bounded request is exactly `{ "expected_generation": number }`; the versioned
result includes the namespace title, read-policy generation, read expiry, and
`ACTIVE` read access. Namespace listing carries the same read-policy fields and
reports `ACTIVE` or `EXPIRED`. The route uses the existing owner authorization
and schema-readiness path without an orientation-policy readiness gate.

## Research result boundary

A subsequent research run failed during the first `VERIFY` at
`2026-09-14T05:05:42Z` with `WORKFLOW_OUTPUT_CORRUPT`, before `AUDIT`. Retries
were later surfaced as a budget stop, masking the original reason. Only the
SYNTHESIS model call ran (about nine seconds); its output states contained no
evidence. No successful research result or saved research DRAFT is claimed.

The recorded checks were TypeScript typecheck, package build, and one local
SQLite `EXPLAIN` of the project update SQL. No broad test suite was used for
this acceptance note.
