---
title: "Compact refactoring: implementation and removal"
date: 2026-10-17
status: "current owner-product refactoring router"
source_baseline: "4e53d5e2296e7f4ed3ed29cef2f049891c5d20c0"
---

# Current implementation work

Finish the five owner paths selected in [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377)
under [ADR-0018](../adr/0018-owner-single-function-first-profile.md) and
[ADR-0019](../adr/0019-compact-refactoring.md). This is the single current implementation router.
[AGENTS.md](../../AGENTS.md) owns agent coordination and verification timing; archived packets locate
contracts, not a second task queue. Astro is rejected; the target is the existing React/Vite application.

## Size and outcome

The [source inventory](../../.github/audits/2026-10-17/README.md#source-footprint-and-reduction-evidence)
found **283,671 physical lines of authored application/library source**, excluding separately classified
tests, tooling and migration history. This is maintained source, including compatibility and unactivated
implementations, not a deployed-bundle or dead-code measurement.

The working design ceiling is **fewer than 100,000 application/library source lines** for the maintained
product, including explicit deep research and compatibility that remains supported. This translates the
owner's request to leave the hundreds-of-thousands scale into an architectural objective; it is not a new
CI gate or a claim that a complete deletion plan already reaches it. The first candidates below are
insufficient on their own. Consolidate remaining capabilities around their actual callers as well.

A refactoring result names the surviving implementation, callers moved, superseded implementation removed,
and any compatibility reader still required. Count readable source with the same inventory method; moving
it to Rust, another package, tests or generated files is not a reduction. Do not minify code or erase useful
checks/comments to improve the number. Reducing ordinary-path work and deleting maintained source are
separate outcomes: retaining a deep Workflow can leave its source count unchanged.

## Structural changes

Select one bounded caller/family from these changes. Independent changes can proceed together; package
roots, manifests, routes, migration decisions and composition remain manager-owned.

### Managed search without the canceled registry

**Current callers:** [project-search.ts](../../packages/cloudflare-ai/src/project-search.ts) reads and hashes
`ai_search_generation_registry`, verifies generation-wide item counts, and rereads its revision after search.
Run admission, project model readiness and
[SEM retrieval](../../packages/cloudflare-research-runtime/src/research-retrieval-composition.ts) call these
checks. This is live application coupling to the generation overlay canceled by #377.

Use the existing configured AI Search instance and native search adapter. Remove
`readProjectSearchManagedAuthority`, registry-dependent `assertProjectSearchManagedPrimaryAvailable`
and the registry fences in `searchProjectManaged`, updating those three consumers together. Preserve
project/source filters, bounded provider calls, current membership, admitted-revision locator mapping and
honest partial/unavailable results. The existing Items upload/membership outbox is the delivery path;
do not introduce a replacement index, provider registry or blocking upload-and-poll orchestration.

The [projection executor](../../packages/cloudflare-projection/src/executor.ts) materializes R2 work and
activates D1 lexical search; it does not call the managed-item writer. Its
[installed profile](../../apps/eliotr-core/src/projection-execution-handler.ts) sets
`managed_generation_active: false`, but
[Core authority](../../packages/cloudflare-projection/src/core-authority.ts) still prepares managed-target
metadata. Retire the unused managed writer/intent methods and exclusive helpers in
`core-managed-items.ts`, `core-managed-item-intent.ts` and `core-managed-item-receipts.ts`.
Their combined 1,297 lines are an inspection surface, not all deletable: terminal/generation readers use
some definitions. Keep source delivery leases, current R2/D1 projection settlement and retained receipts.
Search 0004 and Core migration files remain history; this code change does not drop tables or data.

**Assembled result:** project upload/search/readiness and ordinary admission work through native managed
search without a custom promotion registry; canonical citation opening and deletion/purge behavior remain.

### One model check at connection, one ordinary-answer path

**Current callers:** [run admission](../../apps/eliotr-core/src/research-run-service.ts) checks installed
model/configuration pins and emits `include_qualification_renewal`;
[Workflow composition](../../apps/eliotr-core/src/research-workflow.ts) installs `renew_qualifications`.
[Qualification renewal](../../packages/cloudflare-research-configuration/src/research-qualification-renewal.ts)
and [semantic runtime](../../packages/cloudflare-research-runtime/src/research-semantic-server.ts) resolve
proofs again. These execution-time renewals are superseded for OWNER_SINGLE by ADR-0018.

Keep the existing provider/model connection and selection check, selected model/transport identity for
the original attempt, and spend/cancellation bounds. Remove per-run proof expiry/revocation/renewal
requirements from new owner admissions and handlers, including the extra callback/dispatch marker.
Update the request/configuration producer and consumers together; keep historical pin/marker readers
only where retained runs need read/resume/settlement. A changed setting does not silently redirect an
already admitted paid attempt to a different model. Do not add another configuration service.

The current [stage list](../../packages/domain/src/investigation.ts) has **18 stages**. New E0/E1 questions
use ADR-0019's admit → prepare once → stream synthesis → save/cite responsibilities, within 4–5 durable
steps. Reuse the existing context compiler, model prompt/transport, attempt ledger,
[streamed answer extraction](../../packages/cloudflare-research-runtime/src/research-answer-text.ts),
exact quote matching and artifact writer. Honor actual model token capacity as well as HTTP/body/runtime
budgets; a UTF-8 byte ceiling is not a tokenizer.

New ordinary runs do not create deep-only branch plans, obligation graphs, counter-search or freeze/audit
stage chains. Optional semantic audit is background work; invalid audit format leaves claims unverified.
Keep E2/E3 explicit and reuse its one existing Workflow. Delete ordinary-path dispatch/codec/adapter copies
as consumers move; do not count preserved E2/E3 modules as removed or create a second generic graph engine.

**Assembled result:** one paid streamed synthesis attempt through report/citations/reopen; reconnect
observes the same attempt. Record context, provider and save timings separately. This path needs a
coherent input/receipt representation, not every historical retrieval lane or Rust port.

### Owner summaries through their existing writers and readers

Take one catalog, history, project-guide, Studio or Inbox endpoint and its client at a time.
Pass the ingress-established owner context into one bounded indexed SQL summary query per page. Maintain
summary columns in the underlying write transaction; display stored draft/report content without opening
every citation or requalifying models. Remove the superseded per-item grant/R2/readback chain for this
profile, including now-unused local wrappers. Do not add a summary service, cache database or permission
compiler. The current generic Managed OAuth final check is functional; its replacement requires the
explicit OWNER_SINGLE transition, not a dead-code claim.

Return the same owner's last observed read with a timestamp/stale indication on a transient failure.
No previous observation means unavailable, not fabricated success. Previous-deployment reads retain the
draft; sign-out/principal change and applicable revoke/purge clear protected data. Exact evidence checks
remain on citation opening.

**Assembled result:** record actual query/R2/request counts and latency for the changed endpoint; keep
citation resolution and unrelated client-profile semantics. Do not infer speed from source-line savings.

### One client and retirement of the old presentation

The legacy UI/client cohort contains **21,137 source lines** across `apps/eliotr-pwa`,
`pwa-http-client`, `pwa-source-workspace` and `pwa-research-workspace`. Retirement is a whole
consumer migration, not renaming these packages or adding another adapter layer.

- [React runtime](../../apps/eliotr-web/src/app/runtime.ts) creates a legacy HTTP adapter that constructs
  an OwnerApiClient, then creates another OwnerApiClient for binary operations over the same ports/epoch.
  Adapt JSON/legacy-shaped methods over one existing client instance; keep error conversion, abort,
  authority epoch, immutable mutation identity and disposal behavior.
- Raw upload has a live 544-line [legacy implementation](../../packages/pwa-source-workspace/src/raw-file-api.ts)
  and a live 587-line [owner-client implementation](../../packages/owner-api-client/src/sources/import/raw.ts).
  Move both UIs to the owner-client implementation, then delete the duplicate legacy protocol/decoders,
  leaving only required error/event adaptation until cutover.
- [Legacy research-run API](../../packages/pwa-research-workspace/src/research-run-api.ts) duplicates launch
  and status behavior; its history already delegates to the owner client. Move the remaining callers to
  canonical run methods while preserving scope/body bounds, freshness, reauthorization and section APIs.
  Its 593 lines are not all proved redundant.
- Complete the existing [UI execution map](../agent-work/frontend-owner-execution-map.md) and integrated
  Vite/Worker build bridge. After cutover and the bounded safe rollback period, remove Astro, the old
  renderers/controllers/styles and unused package dependencies. Migrate
  [the Core retrieval fixture's imports](../../apps/eliotr-core/test/retrieval-q1-fixture.ts) from legacy
  bundle input/import APIs before deleting those packages.

Keep the separately served agent inbox/recovery, permanent inert `/sw.js`, old-tab privacy and retirement-safe
rollback from ADR-0016/0017. The 21,137-line cohort includes pieces that must move or remain; it is not a
promised net deletion. Final handoff names the removed implementations and any remaining compatibility
reader, with its actual retirement condition. No permanent dual UI or parallel wire decoder is accepted.

### Deferred export/restore and Drive Exchange

The export/restore execution work is deferred. Current source exposes
`createPrimaryBackupPort` in [Core composition](../../apps/eliotr-core/src/backup-primary-composition.ts)
and `createQualifiedPrimaryBackupPort` in the backup package, with no production caller found for that
composition. In `packages/backup-o2/src`, `restore-admission.ts`, `restore-store.ts`,
`restore-executor.ts`, `restore-erasure-gate.ts`, `restore-native-history.ts` and
`isolated-restore-preflight.ts` have no production application caller found; the barrel also exposes
the throw-only `createPendingRestorePort`.

Remove these unselected execution exports/implementations and exclusively used epoch/planning helpers
once their operator/scheduled registrations are reconciled. **Do not delete both backup packages wholesale:**
[erasure runtime](../../apps/eliotr-core/src/erasure-runtime.ts) uses purge replay/offsite cleanup;
primary-writer qualification/verifier, inventory/bootstrap, retention and relevant codecs/readers remain.
No dropped data or new backup system is part of this retirement.

The selected Google profile is `gemini-mcp`. Old `google-drive-exchange` OAuth/status handlers and scheduled
intent expiry still exist behind the profile boundary. Retire that unselected profile as a bounded cohort
after checking deployed selection and retained credential/receipt/erasure readers; keep Workspace/MCP and
computer-agent assignment. Optional federation has actual registered HTTP callers and is not proved dead.
An unselected feature can return from Git history when requested; speculative implementations do not need
permanent maintenance merely because an archived packet describes them.

## Bounded correctness work

The [source reconciliation](../../.github/audits/2026-10-17/README.md) owns C01–C11 evidence and statuses.
These fixes can proceed independently of broad consolidation.

| Work | Existing implementation and assembled result |
|---|---|
| C01/C02/C11: immutable payload and observation | `research-session-application.ts` and `platform-cloudflare/src/r2.ts`: conditional absent-key write, bounded exact readback on race/lost ACK; preserve original attempt/pre-ledger metadata. Same bytes recover, different bytes conflict, unavailable observation remains unknown; expected hash is never observed hash. Fix shared error classification before reuse. |
| C03: input/checkpoint representation | HTTP permits 262144 bytes; stored query/planning and freeze currently use the 64 KiB receipt bound. Version one coherent immutable input/compact receipt representation across contracts, Session, branch freeze and consumers. Keep old codecs readable; exercise valid above-64-KiB input and early over-limit rejection after assembly. |
| C05/C10: one freshness contract | Navigation freshness, owner client and legacy consumer must agree for scopes up to 4096. A 65-source change cannot break a report because one decoder caps at 64. Use a shared decoder and set-based membership; a bounded sample/cursor declares total/incompleteness. Reopen with 0, 64 and 65 changed sources. |
| C06: cheap checks before paid COW verification | `artifact-cow-section-producer.ts`: normalize/encode once, check local byte/cardinality/claim bounds, then call its independent verifier. Reuse bytes and preserve final authority/commit checks. This does not add that verifier to E0/E1. |
| C07 after product assembly | Existing Golden gate must bind exactly one result to every expected case ID, rejecting duplicates/missing/unexpected IDs. Existing #378/#379 assertion/story work stays scoped; no new preimplementation test programme. |

## Donors and managed components: decisions, not new packages

The original `AI_knowledge_RAG_NotebookLM_Dify_landscape_2026-10-08.md` was recovered and reconciled
against this service. Its SHA-256 matches the October 8 playbook:
`d5da24be9b6167301a475e40652866943d43d7679d0ed099515e8a4dfa4c08be`.
The [October 17 record](../../.github/audits/2026-10-17/README.md#donor-reconciliation) distinguishes
catalogue recommendations from selected pinned source checks. It is a dated landscape, not today's
dependency list, performance evidence or mandatory implementation programme.

| Donor/mechanism | Decision and code consequence |
|---|---|
| Cloudflare AI Search Items/search bindings | Keep the native upload/search/status adapter; remove the canceled custom generation authority above it. Preserve original item identity and bounded reconciliation; `uploadAndPoll` is not a replacement for durable lost-ACK handling. |
| Cloudflare Workflows / Agents SDK 0.27.0 | Use native durability already present. The pinned SDK's readonly hook can replace only `ResearchSession.validateStateChange`; callable RPC and outgoing protocol are separate. Keep the explicit method/frame allowlist and lifecycle/send checks. Tiny SDK glue savings do not justify a transport rewrite. |
| DocsGPT attachment budget/context | Already overlaps Eliot's prepare-once compiler/prompt path. Importing its token planner or `F#` citation registry adds another mechanism; neither replaces exact EvidenceHandles or request-byte limits. No donor planner/package is needed. |
| Open Notebook Ask | Pinned code uses strategy, fan-out search and final synthesis across three model-call stages. Do not copy it into one-call E0/E1. Its bounded route composition is a design reference for explicit deeper work only. |
| WeKnora Wiki/retrieval | Keep summary-only paged reads and atomic revision/head changes through existing Eliot owners. Its summary method is not itself a one-query implementation. Eliot already has deterministic fusion and Wiki head/outbox commitment; no new RRF or revision engine. |
| Onyx / PipesHub / RAGFlow / Dify | Reject enterprise ACL/connector frameworks, index promotion registry and generic graph runtime for this scope. Retain narrow exact-evidence, atomic update and durable-resume principles through existing code. Their platform topology and donor P0/test lists do not override #377 or ADR-0018. |
| AnythingLLM / Haystack / LightRAG / Agentset catalogue additions | No demonstrated Eliot implementation deletion from importing their context/component/process/vector abstractions. Defer them; do not turn proposed donor contracts into another subsystem backlog. |

Literal code reuse still needs the chosen file/dependency license checked. No donor code or new dependency
is imported by this documentation change. After implementing a selected family, use the existing
[scoped verification procedure](scoped-verification.md) and its assembled acceptance; publish the measured
source change and remaining limitations in the same PR.
