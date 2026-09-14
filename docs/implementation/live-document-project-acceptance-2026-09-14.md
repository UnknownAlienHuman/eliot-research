# Live document and project acceptance — 2026-09-14

The current owner workspace deployment is generation `git-a68e21c`, Cloudflare
version `55f91e25-e81b-470e-b977-f4a56e12e561`. Earlier evidence below was
collected under prior generations and remains historical. This note records
the bounded document, project, and research evidence; the project save is live,
the `031c6fa` research DRAFT is historical, and the current `a68e21c` PROJECT
run reached a bounded saved DRAFT. Full project or full-corpus completion is
not claimed.

## Recorded implementation slices

* `0645b8f` — project/PDF decode and timeout handling.
* `6cbed7b` — project title `oninput` handling.
* `7a2c34a` — the project SQL missing-`AND` and membership-witness fixes,
  together with the owner session panel changes.
* `2c160ce` — the bounded project-update SQL expression-depth fix and the
  live project update readback recorded below.
* `031c6fa` — the project-scoped research run reached a saved DRAFT; its
  bounded stage readback is recorded below as historical evidence.
* `a68e21c` — the request-local audit claim-alias fix preserves canonical
  persisted claim refs; one focused offline fixture passed 3/3 and core
  TypeScript typecheck was green.

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

Deployment `git-a68e21c` (Cloudflare version
`55f91e25-e81b-470e-b977-f4a56e12e561`) is D1 `ACTIVE` and carries the
reviewed W2 configuration with `retries.limit: 0` and a 600-second model-stage
lease. The project save above is the live D1 readback for the prior
`git-2c160ce` deployment; the earlier saved DRAFT below is historical evidence
from `git-031c6fa`, while the current bounded DRAFT is recorded below. These
facts describe execution policy and bounded prior evidence; they do not prove
full project or full-corpus completion.

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

The historical run `run-fb3381dff43c416ca6e2f00f2548d5d4b69628649eb42b45` on
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
details remained `NOT_VERIFIABLE`; the saved Stage14/provider comparison below
identifies the binding mismatch. No claim that all semantic verdicts are PASS
is made. An exact comparison of the
saved Stage14 output (`.eliotr-state/orbit-project-audit-stage-output.json`,
SHA-256
`3f90c0b5a8f7d891719b19758000ec452d1b48eb9eac3ff4cb6256daca747b5b`) found
the second expected legacy claim ref contained `64457065` while the provider
returned `64477065` at that position; all four claim-text digests, the verifier identity, and
the evidence input SHA matched. The persisted result recorded
`SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH`. Deployment `git-a68e21c` carries the two-file
request-local alias fix, which maps `claim_1` through `claim_4` back to the
trusted canonical refs without repairing that legacy value. No new live PASS
was claimed from this historical run.

A new UI run under `git-a68e21c` uses the same question and PROJECT `Орбита`
scope; its result is recorded below.

The current run `run-65c62850c6f012ddc67340faf6d2fa4bcde6354d1ba53bd8` on
`git-a68e21c` was created at `2026-09-14T06:38:15.152Z` and reached
`ENGINE_COMPLETED` with `next_stage_index: 18`. Cloudflare reported 19 workflow
steps, at most one attempt per step, and no failed steps. Its PROJECT scope was `Орбита`; the sampled pack
contained seven resolved excerpts (DOCX 3, PDF 4), with coverage `SAMPLED`.
REPORT succeeded from `2026-09-14T06:38:45.584Z` through
`2026-09-14T06:39:01.930Z` with a 2,583-byte output. AUDIT succeeded from
`2026-09-14T06:39:13.107Z` through `2026-09-14T06:39:38.987Z` with a
3,970-byte output. The provider response
`.eliotr-state/orbit-alias-audit-output.json` has SHA-256
`239f7dd06c6325b414c1fbd287b422aedda7d58f00b35253a8c909202c487bc5` and
used request-local `claim_1` through `claim_4` aliases. Persisted Stage14
output `.eliotr-state/orbit-alias-audit-stage-output.json` has SHA-256
`b76a77d1b9b0d3dcee286bb4674f0e2e8a69c5a1f7cdbbde45a7618f4698a2a6` and
contains four canonical claims with disposition `SUPPORTED`, without an
invalid-output reason. The UI opened the saved DRAFT with actual Russian
text, purpose/status/date 21 September 2026, and PDF/DOCX formats; it showed
two represented sources, two cited sources, and zero omitted. Artifact readback
is `eliotr.research.artifact-59bae356b18c894a4f75035ef6323f0475e03dc237f19485568eecfbf21da1e0:1`,
with the same-hash artifact spec and evidence freeze
`eliotr.evidence-freeze-c050bcd8403b44ad0a7042106919743b9c712962ddb7dc7393ed1ab29ec7517d:1`.
The date-claim support readback opened the verified
`Orbit-document-workflow.docx` excerpt at UTF-8 bytes 320–578 with SHA-256
`af0349f078ecf34fecc548eedd7df758c30a1abfaec443f94ed6ddbefccf34ef`.
Evidence receipt
`evidence-resolution-1ce379fed019556eab6e752a789e032e6daa524e5f9a7c38:1`
was `LIVE` and `DATA_ONLY`, matching the current scope and source revision;
the actual milestone table and 21 September date were visible. The UI showed
all four visible claim verdicts as `SUPPORTED`. Coverage remains incomplete,
so this is bounded live evidence rather than full project or full-corpus
completion.

The recorded checks include green core and PWA TypeScript checks, a green PWA
build, the remote D1 `EXPLAIN` of the emitted project UPDATE with 1,317 VM
instructions, and one local SQLite `EXPLAIN` of the project update SQL. No
broad test suite was used for this acceptance note.

## Owner-reviewed Wiki publication

Deployment `git-44ea8be` (Cloudflare version
`3b7158f6-6ff2-4c4e-a0bb-e5b96289209c`) adds the owner publication API and UI.
The existing proposal
`wiki-proposal-5d2536e7ce210d96bfb92b764865bb72104a02618ff881d9:1`
was opened, reviewed and published through the normal authenticated interface.
D1 records `PUBLISHED` at `2026-09-14T07:43:53.976Z`; reopening the page in the UI
returned the same report text with the Published badge and its limitations.

The accepted Wiki revision is
`research-wiki-092a593d6d61b82385988af0b6765a06dde1a22d98f5ee43:1`.
Its immutable manifest was downloaded from R2 and independently matched SHA-256
`9df2915b8525e0ed1289b7dbacd7a530c29d9704495a62b05cc20d15d81c4701`.
The body retains SHA-256
`c633bad3cac6d83cbf900439e30629423b29801bbd9090aab23acd1668230047`.
The head references
`wiki-outbox-a97cb1e531a0c03cb2f50af529a8deee3714754866583949`.
The immutable owner-review receipt was also downloaded and matched SHA-256
`164295e776c4c3b38af0296016b22d13f189d5d08a9a4d3982f6e26e60f1c5b1`.

The same D1 publication transaction retained guard
`wiki-guard-4463834e5246dece38dd4d0b52bc5c4968dfe621ab8fcecc`, observed at
`2026-09-14T07:43:54.575Z` under `git-44ea8be`. It checks current owner grant,
scope, source permissions, policy, deployment and purge/authority epochs before
the head, revision, outbox and proposal effects commit. The review receipt
records `coverage_complete: false`, `dependency_closure_complete: true` and
`conflict_count: 0`. The original research artifact stays DRAFT with its
UNRESOLVED statement label; manual publication does not assert complete coverage
or promote the artifact to VERIFIED. The UI presents the old pending-review
limitation as a historical draft note after publication.

Core and PWA TypeScript checks and the PWA build passed. A single in-memory
SQLite schema pass compiled all 58 migration files and the guard INSERT with
its triggers. Migration `0059_wiki_owner_publication_guard.sql` was applied
through the authenticated Cloudflare connector after Wrangler's D1 request
returned account-authorization error 7403. Live schema readback confirmed 33
columns, 10 triggers and two indexes; only then was the migration recorded in
`d1_migrations`. Wrangler deployment and both R2 downloads succeeded. No broad
test suite was run. This verifies this owner Wiki loop, not the remaining
accepted-artifact, editing, erasure, recovery, federation or Rust launch scope.

## Owner research activity history

Product commit `8b418fe` was pushed to main and deployed as Cloudflare version
`7ee92390-e3c7-4fb2-9e0b-54a7bccf1cf6`. The active D1 deployment was read back as
`git-8b418fe`, admitted at `2026-09-14T08:14:39.175Z`; the normal owner browser
reported that same generation and READY. The Research view now includes Recent
work with the latest 20 visible events and manual refresh.

Migrations `0060`–`0062` were applied through the Cloudflare connector. Live
schema readback confirmed all three producers before their migration names
were recorded. Artifact binding and final workflow checkpoint transactions now
emit `ARTIFACT_DRAFTED` and `RESEARCH_COMPLETED`; the Wiki outbox trigger derives
visibility from its proposal principal and published revision scope. The
server signing secret was created securely and its name was read back without
printing its value. One local SQLite pass compiled all 61 migration files and
the source mutations with their triggers. Core and PWA TypeScript checks and
the PWA build passed after fixing two type errors; no broad suite was run.

The existing Wiki event, sequence 1 at `2026-09-14T07:43:53.976Z`, appeared in
the live UI after its original scope expired. Its immutable legacy row retains
NULL visibility columns; the reader derives the effective owner and scope
from the canonical outbox/revision/proposal join and checks current source
authority. Historical scope reauthorization retains exact source membership,
owner generations and closure checks. Explicitly revoked grants are not
renewed. This observation demonstrates the allowed historical read; a live
cross-owner or revoke-between-pages negative scenario was not executed here.

The owner started a new PROJECT-scoped run through the normal UI:
`run-f1aab21e76884dab48b430cf2fedf64653c368615673b1eb`. It was created at
`2026-09-14T08:15:05.223Z` and reached `ENGINE_COMPLETED`, revision 19,
`next_stage_index: 18`, at `2026-09-14T08:17:10.002Z` (about 125 seconds).
D1 readback and the refreshed UI showed these two new events:

| Sequence | Kind | Subject revision | Recorded event time |
| --- | --- | --- | --- |
| 2 | `ARTIFACT_DRAFTED` | 1 | `2026-09-14T08:15:33.843Z` |
| 3 | `RESEARCH_COMPLETED` | 19 | `2026-09-14T08:17:10.002Z` |

Both new records bind owner `175e73bf-b10e-519f-a660-c582caee2f48` and scope
`scope-300c9fdc0edf1bc98edeb56e022cd9938a86277bc1661cef:1`. The draft subject is
`eliotr.research.artifact-ff49ade4bbc06c52b83fc504aa4f5cb4580b7f6652cc0292fab253d05ed11a92:1`;
its recorded manifest digest is
`1f443b4b7b7e6c503edb8751ab50f6b2b7136ccb9b15e84e1486447f1732bade`.
The completion event points to the committed workflow output with digest
`a287399cb6ec1a68260ef214ce2730e5f4582381b5f26f050d000b93d200bbc3`.

Opening the saved section displayed a Russian summary of the project purpose,
Collect documents / Ready, Review sources / In progress, and the planned
21 September 2026 review, with quotations from the PDF/DOCX sources. The UI
retains DRAFT and incomplete coverage, with two represented and cited sources
and zero omitted. This run verifies the saved-report/completion producers and
the Recent work owner view. New Wiki events use the migrated trigger but a
second Wiki publication was not performed in this pass. Source admission,
source update and erasure producers, accepted-artifact semantics, editing and
the remaining production/Rust scope are still open.

## Owner edits with preserved Wiki history

Product commit `6f14c0c` was pushed to main and deployed as Cloudflare version
`4f540e0b-4210-4b7d-802e-ceabe4d2bdfb`. The active D1 deployment and normal owner
browser both read back `git-6f14c0c`; activation was recorded at
`2026-09-14T09:12:33.879Z`. The Library now displays the selected project title
and keeps scope identifiers in collapsed details.

The owner opened the published Orbit page, changed its title to
`Орбита — рабочая сводка`, and appended an editorial note without replacing the
original report text. The new proposal is
`wiki-proposal-c42dc117e360be2c2606025ec84dc8a713d342c972267a51:1`, created at
`2026-09-14T09:13:43.764Z`, for revision 2 of
`research-wiki-092a593d6d61b82385988af0b6765a06dde1a22d98f5ee43`.

The first live save exposed a D1 expression-depth error in the metadata trigger:
the proposal bytes had settled, but its edit binding had not. Migration `0064`
replaces that one predicate with five shorter guards while preserving its
checks. It was applied atomically and recorded at `2026-09-14 09:20:57` UTC;
commit `acebeb9` contains the correction. Live `EXPLAIN INSERT` then compiled
1,195 instructions and schema readback confirmed all 13 binding triggers.
Retrying the same form completed the original proposal/binding, retaining its
original creation time. No manual binding insertion or duplicate draft was used.

After reviewing the saved draft, the owner published it through the normal UI.
D1 records publication at `2026-09-14T09:21:45.961Z`. The head is revision 2 with
outbox `wiki-outbox-18604c171d92b23095c600c116bf0ea3ff37efc077395c2a`.
The new immutable manifest and owner-review receipt were downloaded from R2
and independently matched these SHA-256 values:

| Object | SHA-256 |
| --- | --- |
| Published revision 2 manifest | `f5764f83ecc4af1b2b3a8c10b02faeea7cb586ee391a9291adccd6e231a01d90` |
| Owner edit review receipt | `089248e66a1a95288e841a2aeff1c4256072c75f1b6dbf6494fb129c2d1db644` |

The new body is 1,861 UTF-8 bytes with digest
`7931708ec32160b02023155836aa4f48bc8cda23e5b580c795a29f1d212cba9a`.
Revision 1 retains manifest digest
`9df2915b8525e0ed1289b7dbacd7a530c29d9704495a62b05cc20d15d81c4701`
and its original body digest. Both proposals reopened in the owner browser:
the original text remained intact and the new Published page included the
editorial note. The receipt uses `eliotr.wiki.owner-edit-review.v1`, records
incomplete coverage and zero supported claims, and binds a separate integrity
receipt instead of reusing the original machine audit for edited text.

The publication transaction retained currentness guard
`wiki-guard-09f2e084c31ea001b6052135820afaae7a27b4777db5ce81`, observed at
`2026-09-14T09:21:46.532Z`. Change-feed sequence 4 is `WIKI_PUBLISHED`, revision 2,
with the new manifest digest and explicit owner/scope visibility. This also
exercises the new Wiki visibility trigger from migration `0062`. Refreshing
Recent work displayed the new publication at 5:21 AM local time. The selected
Library showed `Project: Орбита · исследование документов` and its two sources.

Core and PWA TypeScript checks and the PWA build passed. The first Core check
found one missing parameter; it was fixed before deployment. Local SQLite
compiled the migrations, but did not reproduce D1's lower expression-depth
limit; the deployed EXPLAIN and normal UI retry resolved that live failure.
No broad test suite was run. Concurrent-client and mid-edit revocation scenarios
were not exercised live. Accepted-artifact semantics, source update/purge,
recovery, federation and the mandatory Rust scope remain open.

## Source versions and historical report freshness

Schema commit `39ffd48` was pushed to main. Migrations `0065` and `0066`
were applied atomically to production D1 and recorded at
`2026-09-14 09:59:54` UTC. They add immutable target-source/expected-head
fields to raw capture and record one owner-visible source change per admitted
revision from the final ingest commit guard transaction.

Local SQLite compiled all 65 migration files through `0066`; the actual raw
capture INSERT compiled with 20 matching parameter bindings. Production D1
`EXPLAIN INSERT` compiled 289 instructions for raw capture and 320 for the
ingest commit guard with the new change-feed trigger, with zero data writes.
Implementation commit `66a0e20` was pushed and deployed as Cloudflare version
`5227381a-c6d4-4e2a-b39a-0e69a270ce79`. D1 activated `git-66a0e20` at
`2026-09-14T10:18:22.929Z`; the owner browser showed that generation.

The normal owner UI uploaded `Orbit-document-workflow-v2.docx`, a copy of the
agent-created sample with Review sources changed to Completed and the planned
date changed from September 21 to September 28. The original sample was retained.
The replacement was admitted at `2026-09-14T10:20:20.357Z`:

| Item | Readback |
| --- | --- |
| Unchanged logical source | `raw-17ff19b637696fec16cea180d73727cd18518dbe29ec11d2` |
| New head | `raw-revision-dc4b3b71519b8664c1ff09858a266456b08ab6ba4dd22c96` |
| New normalized SHA-256 | `0a8ec9f21c7fca399f64a2c20fa8fc2ca47e0c3c0b8f7d68517dd225a5d7e8d6` |
| Retained previous SHA-256 | `0c10f4b281d0a2d3267622bf42cfcdca50ec37de92bd65d3ae4c764d711af98c` |
| Source revisions | Exactly two, both LIVE |
| Project | Generation 2, two active source memberships |
| Atomic change | Sequence 5, SOURCE_UPDATED, subject revision 2, new head and digest |

Starting Add new version from the Wiki sidebar correctly opened the upload form
in Sources without requiring a separate workspace selection. Its success message
followed head readback. The admitted document reader displayed 573 normalized
bytes, Completed, and September 28. An independently opened form retained the
old expected head; submitting a different sample file there returned the explicit
source-changed refusal. No third source revision or second update event appeared.

The same live exercise exposed a historical-read integration failure: the existing
source-update trigger invalidated both saved Wiki and Research scopes with
`SCOPE_INPUT_CHANGED` at `2026-09-14T10:20:20.414Z`. Wiki returned HTTP 410 despite
both revisions remaining LIVE. The first implementation rejected every invalidated
original scope before issuing a fresh historical-read grant. Historical reopen
acceptance remains pending correction of that read path; persisted invalidation
flags and old grants must not be reset.

### Stop checkpoint requested by the owner

The follow-up changes allow historical reads of `SCOPE_INPUT_CHANGED` provenance
only after a real source-head change is observed, with exact historical LIVE
revisions and current owner/policy checks. Explicitly revoked original grants
remain denied. Wiki, saved Research, nested artifact reads and scoped activity
use this separate read path; ordinary current-scope reads and mutations retain
their invalidation checks. No persisted invalidation flags or old grants were
changed. Core TypeScript passed after these corrections.

Commit `4a6dd30` also clears cached report views after source admission and includes
SOURCE_ADMITTED/SOURCE_UPDATED in the PWA activity request and display. PWA
TypeScript and Astro build passed. At the owner's stop request these follow-up
fixes are being saved to main only: the live Worker remains `git-66a0e20` and the
historical reopen failure described above has not been verified as fixed there.
No further deployment or model run was performed. The whole project is incomplete.
