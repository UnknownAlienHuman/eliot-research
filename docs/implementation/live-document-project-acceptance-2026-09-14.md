# Live document and project acceptance — 2026-09-14

The current owner workspace deployment is generation `git-031c6fa`, Cloudflare
version `c837f53b-d0b3-4c62-9cb6-092d63715a41`. Earlier evidence below was
collected under prior generations and remains historical. This note records
the bounded document, project, and research evidence; the project save and a
saved research DRAFT are live, while full research completion and universal
semantic PASS verdicts are not claimed.

## Recorded implementation slices

* `0645b8f` — project/PDF decode and timeout handling.
* `6cbed7b` — project title `oninput` handling.
* `7a2c34a` — the project SQL missing-`AND` and membership-witness fixes,
  together with the owner session panel changes.
* `2c160ce` — the bounded project-update SQL expression-depth fix and the
  live project update readback recorded below.
* `031c6fa` — the project-scoped research run reached a saved DRAFT under the
  current deployment; its bounded stage readback is recorded below.

## Live evidence

* Historical project state: empty project
  `project-cf376e32c6b61ca3be479e341db27110370e20d62355b0a2` was created
  successfully at `2026-09-14T04:20:08.839Z`, revision 1. Its first title
  update returned `PROJECT_SETTLEMENT_UNCERTAIN`; at that point the database
  remained at revision 1 with no active memberships and no update receipt.
  The failure tail was D1 `Expression tree too large (max depth 100)`.
* Live project update on deployment `git-2c160ce` succeeded from the owner UI:
  title `Орбита · исследование документов`, revision 2, and two active
  memberships for the admitted DOCX and PDF sources. The UPDATE receipt was
  recorded at `2026-09-14T05:42:11.571Z` with deployment generation
  `git-2c160ce`. The diagnostic tail also logged `ProjectOwnerError` because
  the batch did not settle exactly while D1 metadata included trigger changes;
  receipt readback recovered the successful result.
* The final remote D1 `EXPLAIN` of the emitted UPDATE succeeded with
  `success: true`, `errors: []`, and 1,317 VM instructions. Core TypeScript
  typecheck was green.
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
present, so this was a one-time PIN flow. This is independent of the later
project save and research run evidence below.

## Current deployment and limits

Deployment `git-031c6fa` (Cloudflare version
`c837f53b-d0b3-4c62-9cb6-092d63715a41`) carries the reviewed W2 configuration
`retries.limit: 0` and a 600-second model-stage lease. The project save above is
the live D1 readback for the prior `git-2c160ce` deployment; the saved DRAFT
below is the live readback under this current deployment. These facts describe
execution policy and a bounded DRAFT outcome; they do not prove full research
completion or that every semantic verdict is PASS.

## Owner namespace renewal contract

The authenticated owner API exposes `POST /api/v1/library/namespaces/:namespace_id/renew`.
Its bounded request is exactly `{ "expected_generation": number }`; the versioned
result includes the namespace title, read-policy generation, read expiry, and
`ACTIVE` read access. Namespace listing carries the same read-policy fields and
reports `ACTIVE` or `EXPIRED`. The route uses the existing owner authorization
and schema-readiness path without an orientation-policy readiness gate.

## Research result boundary

A historical research run failed during the first `VERIFY` at
`2026-09-14T05:05:42Z` with `WORKFLOW_OUTPUT_CORRUPT`, before `AUDIT`. Retries
were later surfaced as a budget stop, masking the original reason. Only the
SYNTHESIS model call ran (about nine seconds); its output states contained no
evidence. For that failed run, no successful research result or saved research
DRAFT is claimed.

The intermediate historical run `5917638b1d7ea333eec733aaba611b665e6bb95855afaa3e` on
`git-2c160ce` read the entire library scope: three documents and a pack with
14 resolved excerpts (DOCX 3, PDF 4, README 7), with coverage marked
`SAMPLED`. SYNTHESIS succeeded from `2026-09-14T05:45:00.307Z` through
`2026-09-14T05:45:22.748Z`; its 3,103-byte output has SHA-256
`009cf7c8f8ade30de2ea2d18f0f8fe9f9af98a9e40a2bc21a5bfe41c507a55fb` and
contained the actual `Орбита` facts and citations. The response was wrapped
in one JSON Markdown fence. VERIFY then failed from `2026-09-14T05:45:23.540Z`
through `2026-09-14T05:45:25.609Z` with `OUTPUT_CORRUPT` after exactly one
attempt (`retries: 0`), so there was no AUDIT or saved DRAFT. The fenced-response
normalizer was subsequently fixed and deployed with `031c6fa`; the prior
single-document fallback issue was fixed, and this run used all 14 resolved
handles.

An offline 3,103-byte parser fixture contained four claims and six references;
plain-JSON equality was accepted, while prose-prefixed and multiple or
malformed JSON fences were rejected. This fixture is parser evidence, not a
live research result.

The later run `run-fb3381dff43c416ca6e2f00f2548d5d4b69628649eb42b45` on
`git-031c6fa` completed with `ENGINE_COMPLETED`, `next_stage_index: 18`, and
was created at `2026-09-14T06:07:58.375Z`. Its actual project scope was
the UI-selected project `Орбита`; its sampled evidence pack contained seven
resolved excerpts (DOCX 3, PDF 4, README 0). REPORT
succeeded from `2026-09-14T06:08:30.091Z` through
`2026-09-14T06:08:52.595Z` with a 2,655-byte output. AUDIT succeeded from
`2026-09-14T06:09:03.580Z` through `2026-09-14T06:09:24.874Z` with a
3,697-byte output. The UI opened a saved DRAFT section containing four actual
paragraphs about the goal, import, reading, and draft, with Ready/In progress
statuses, a 21 September 2026 review date, and PDF/DOCX format details. Its
footer reported two represented sources, two cited sources, and zero omitted,
while coverage remained unknown/incomplete for the DRAFT. Citation readback
then succeeded for one date claim: the verified `Orbit-document-workflow.docx`
excerpt covered UTF-8 bytes 320–578 and had SHA-256
`af0349f078ecf34fecc548eedd7df758c30a1abfaec443f94ed6ddbefccf34ef`.
Evidence receipt
`evidence-resolution-2598e88db6627a3c9db9cd0e7664ce1ba9c9ae1fa0e9b1d6:1`
was `LIVE` and `DATA_ONLY`, matching the run scope and source revision; the
readback showed the actual milestone table and the 21 September date. The
details for all four claims still reported `Could not be verified in this
scope`, so this does not establish semantic PASS verdicts or complete
coverage. The saved artifact readback is
`eliotr.research.artifact-0b2e55be285f24f29bb3f8da89de4b68feb50fc02d33f0c547f7c925cf4332b2:1`,
with the same-hash artifact spec and evidence freeze
`eliotr.evidence-freeze-6973036c2bef88182541878fad90ba97d2003d112d023d5ca48efd57e4859375:1`.
The 3,697-byte AUDIT output was otherwise successful, but all four UI claim
details remained `NOT_VERIFIABLE`; decoder/binding diagnosis is pending. No
claim that all semantic verdicts are PASS is made.

The recorded checks include green core and PWA TypeScript checks, a green PWA
build, the remote D1 `EXPLAIN` of the emitted project UPDATE with 1,317 VM
instructions, and one local SQLite `EXPLAIN` of the project update SQL. No
broad test suite was used for this acceptance note.
