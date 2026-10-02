# Implementation status is executable

The architecture defines the target product. The machine-readable
[implementation registry](implementation-status.json) records registered source contours; the
[gap register](gap-register.md) records missing behavior, and the
[production readiness plan](production-readiness-plan.md) defines release acceptance.
These sources answer different questions. A compiling port, completed Workflow or passing local test
cannot establish production readiness.

## Read the current state

Run these commands in the repository root:

```bash
pnpm check:implementation-status
pnpm launch:code
```

The first validates registered markers and prints their current state counts. The second reports
mandatory disabled slices, uncomposed operations and the selected Google transport's unfinished
requirements. Its `LIVE_DEPLOY_BLOCKED` result is an explicit failure, not a deployment instruction.
Counts and unavailable-method lists are intentionally not copied into this document: older copies
incorrectly described an implemented ResearchSession as a scaffold and working query/run routes as
uncomposed.

The launch-code check is a negative gate. Passing it would still require the canonical product,
Rust migration, live integration, recovery and workload evidence defined in the readiness plan.
Unregistered composition gaps and unfinished owner workflows also remain in
[canonical alignment](canonical-alignment.md) and the [theme plans](launch-prs/README.md).

## State meanings

| State | What it proves |
|---|---|
| `SCAFFOLD_FAIL_CLOSED` | A contract or port exists, but execution explicitly refuses pending behavior without mutating canonical state. |
| `IN_PROGRESS` | An owned implementation is unfinished and its acceptance remains open. |
| `IMPLEMENTED_NOT_LIVE` | The named local and recorded-fixture evidence exists; required platform or provider qualification remains open. |
| `LIVE_QUALIFIED` | The named live gate has a retained receipt and exact readback. |

`check:implementation-status` rejects missing/stale registered markers and an unregistered
`IMPLEMENTATION_PENDING` source marker. Removing a scaffold requires its negative acceptance and
corresponding registry/gap evidence in the same change. Neither prose nor a green typecheck promotes
an implementation state.

## Library, retrieval and Workspace boundaries

The owner Library composes admitted revision history, current source-head readiness, FAST_SEARCH and
persisted retrieval traces. Revision history remains `RECORDED_ONLY`; active readiness is a separate
server assessment. The PWA checks source, revision, scope and deployment before rendering resolved
excerpts, and clears results when those identities become stale.

Raw-file capture, conversion and governed Library admission have separate durable outcomes.
Conversion is a candidate operation; admission does not establish index readiness. The actual local
scheduled/Queue/R2 projection and browser FAST_SEARCH path has a focused retained result, including
honest managed-index degradation. The complete owner suite, deployed Access and managed-provider
qualification remain separate acceptance. See [Library checkpoints](launch-prs/01-library.md).

`research.orient` returns metadata-only navigation. `research.query` and `research.run` are composed
product paths, with limits and remaining gaps documented in the registry and
[local launch guide](local-launch.md). Q8 can expose an earned `COMPLETE` from the persisted exhaustive
receipt and its settled denominator. Missing remote acceptance is a qualification gap; it is not a
rule that forces every local Q8 result to `UNFINISHED`. A Workflow transport completion alone still
cannot establish a research result or enable the whole RETRIEVAL slice.

The selected `gemini-mcp` Workspace profile uses Spark Connected Apps or Antigravity. Verified MCP
identity, server-issued plans and append-only candidate observations preserve transport provenance.
They do not grant namespace write access or admit source bytes. Explicit candidate authorization,
byte admission and authenticated Workspace action/readback remain distinct work. The separate
`drive-exchange` profile is retained for an explicit future selection; its unfinished custom OAuth
setup is not a prerequisite for the selected Workspace path. See
[Google transport profiles](../adr/0006-google-external-transport-profiles.md).

## Artifact drafts

The internal `cloudflare-artifacts` draft store persists canonical ArtifactSpec/ArtifactRevision
manifests, section bodies and referenced objects with explicit residency. It reserves the operation
before R2 writes, verifies actual object readback, then commits the DRAFT revision, draft head and
intent/outbox together through a guarded D1 transaction. Finalized replay reads the original receipt
even after a later draft revision; missing stored evidence fails without rewriting objects.

The owner endpoint `GET /api/v1/research/artifact/:id:revision` returns the canonical DRAFT
ArtifactRevision for an exact stored revision, including a historical draft behind a later draft head.
It requires the binding owner and current persisted scope/grant authority before reading WORK_BUCKET,
verifies the manifest and every declared object's bytes, residency and durable binding, and rechecks
authority before returning metadata. Missing, stale, denied and inconsistent records remain distinct
typed failures. This metadata endpoint does not return object bodies or mutate draft/published heads.

`GET /api/v1/research/artifact/:id:revision/sections/:section_id:revision` reads one exact section's
stored bytes through the same verified historical manifest and owner authority. The response uses
`application/octet-stream`, `no-store` and `nosniff`; artifact, section and object reference headers
are percent-encoded and must be decoded with `decodeURIComponent`. Section selection does not bypass
verification of the manifest's other declared objects. The explicitly configured exploratory.v3
composition attaches a DRAFT through stage 17; the unqualified `research.run` entrypoint retains exploratory.v2; explicit-protocol and deployed owner paths are distinguished below.
The local D1/R2 reader suite passed 12 cases at source `0118208`; the subsequent Unicode-header change
passed its one affected case at `5de069f` with the other 11 skipped.

The section's `/citations` endpoint returns its stored verification reference and exact cited
handle and excerpt digests after the same owner and current-scope checks. The PWA opens sources
through the existing evidence reader and retains `DRAFT` and `NOT_EXECUTED` labels. The native
Worker AI Gateway adapter and persisted model-profile authority reader support the configured
source-to-DRAFT path: configured v3 executes source verification at stage 13 and binds its receipt to
committed synthesis bytes and current frozen evidence. The actual local source-to-DRAFT case passed
at `0c0506e`, including replay and revoked reads. Configured REPORT admission executes inside the
stage-17 handler and final artifact transaction; its separate D1/R2 case passed at `74203c9`,
including missing-policy/revoked-grant refusal and replay. In configured v3 local acceptance, stages
14–16 and model responses remain controlled, and semantic verification is `NOT_EXECUTED`; these
local tests are not live semantic/provider qualification.

Separately, new explicit-protocol admissions select v7 (`research-handlers.exploratory.v7`);
delegated computer-agent runs select v8. Idempotent replay keeps its stored generation and prior
generations remain accepted. These routes compose branch execution, evidence freeze/reconciliation,
per-role model calls and spend admission; `model.roles` is assembled server-side from the installed
`ELIOTR_MODEL_PROFILE_DEFINITION_JSON` policy and committed stage-five evidence. See the
[backend delivery plan](backend-delivery-plan.md). Production/operator policy installation and exact
provider qualification, S37/S93 acceptance and remaining release gates remain open.

The deployed owner PWA path is distinct from configured v3 and the unqualified `research.run`
entrypoint. The Sep 14 live acceptance records a bounded project run on `git-a68e21c` completing
all 18 stages, with four `SUPPORTED` claim assessments, a saved/reopened DRAFT and incomplete
coverage. This does not establish full-scope completion or general launch acceptance. See
[live document/project acceptance](live-document-project-acceptance-2026-09-14.md).

These local draft tests do not establish semantic verification or accepted-artifact publication.
The bounded owner from-run Wiki proposal/review/publish/reopen path and owner editing, republishing
and reopening of Wiki revision 2 have live evidence; the report remains DRAFT and its coverage limits
and unresolved labels are retained. This does not complete full WIKI readiness or the accepted-artifact
lifecycle.

Live change evidence includes `ARTIFACT_DRAFTED`, `RESEARCH_COMPLETED`, `WIKI_PUBLISHED` and a
D1 `SOURCE_UPDATED` receipt at sequence 5/revision 2. The `SOURCE_ADMITTED` request/display path
was delivered in `4a6dd30`, but the live-acceptance note says that follow-up was not yet deployed at
its stop checkpoint. Erasure-event coverage and the full `research.changes` lifecycle remain open.
At exact checkpoint `8415793a`, PWA owner revision/acceptance controls and COW have focused native
HTTP verification; browser/process-restart and live-provider qualification remain pending. See the
[product integration checkpoint](product-resume-2026-10-02.md). Local D1/R2 and HTTP acceptance is
separate from deployed Access/storage qualification.

## Evidence must match the claim

- Queue acceptance is not a durable consumer receipt or projection success.
- A provider/index hit is a locator until exact authorized R2 bytes resolve its EvidenceHandle.
- SourceCard, DocumentMap and ProjectAtlas are navigation, not publication support.
- A Google transport result remains a candidate until exact readback and ELIOT admission.
- Local Worker bindings, browser fixtures and deployment dry-runs are not live qualification.
- A commit on `main` records delivery. Its CI result and product/release acceptance are separate facts.

Keep focused test results, full owner acceptance, current CI and live receipts distinct in PR evidence.
A failing or unexecuted gate remains visible while development continues. The repository's release
claim is governed by the readiness plan, not by this explanatory page.
