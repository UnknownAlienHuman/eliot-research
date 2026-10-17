# ADR-0019: Compact refactoring of the owner service

- Status: accepted implementation direction under the owner's 2026-10-17 request; runtime changes and acceptance remain pending.
- Source baseline: `4e53d5e2296e7f4ed3ed29cef2f049891c5d20c0`.
- Decisions reconciled: [owner backlog decision #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377),
  [audit #380](https://github.com/UnknownAlienHuman/eliot-research/issues/380),
  [ADR-0016](0016-react-cloudflare-owner-ui.md), [ADR-0017](0017-owner-web-browser-runtime-and-tooling.md)
  and [ADR-0018](0018-owner-single-function-first-profile.md).
- Supersedes: mandatory crate-per-capability topology, ER-49 claim/ancestry prerequisites, historical
  S01–S99 delivery ordering, and requirements to build the canceled S52 search overlay for this service.
  Wire protocols and persisted-data semantics do not change merely because this ADR is accepted.

## 1. Product and selected scope

Finish the five owner paths selected in #377: project/sources/question/report with citations/reopen;
project upload to managed search; draft publication through Inbox; connected agents; task assignment to an
agent. Preserve Library, Lens, Wiki and explicit deep research. A refactor must improve a named path or
remove an identified implementation cost on that path.

`OWNER_SINGLE` is the service profile. `gemini-mcp` is the selected Google transport profile; these are
different settings. Optional federation and Drive Exchange do not become mandatory by appearing in an old
packet. Backup/export/restore execution remains deferred under the recorded owner cancellation; existing
retention and erasure obligations remain. No new backup subsystem is part of this refactor.

Astro is rejected as the target. The target is the existing React/Vite owner web, existing `@eliotr/ui`
and one `@eliotr/owner-api-client`. The current Wrangler asset path still serves `eliotr-pwa`; that is a
migration fact, not a choice to continue developing an Astro application.

## 2. One application, coherent modules

Keep one `eliotr-core` Worker with static assets, D1 and R2. Queues and Workflows provide native durable
execution. A module below is a responsibility, not a mandatory npm package, Cargo crate, process or service.

| Responsibility | Existing implementation homes | Boundary |
|---|---|---|
| Owner presentation | `apps/eliotr-web`, `packages/ui`, `packages/owner-api-client` | React renders; Query owns request cache; one client decodes owner responses. No copied legacy decoders. |
| Ingress and composition | `apps/eliotr-core`, `packages/interfaces`, `packages/platform-cloudflare` | HTTP/MCP, authenticated principal, bindings and composition. No second application engine in route wrappers. |
| Sources, projects and evidence | `packages/domain`, `cloudflare-raw-ingest`, `cloudflare-navigation`, `cloudflare-evidence` | D1 owns identities/membership; R2 owns source bytes; one resolver owns exact citations. |
| Research | `packages/research`, existing `cloudflare-research*` and `cloudflare-workflows` | One ordinary-answer path; explicit deep Workflow; one durable attempt/result owner. |
| Models and external agents | existing `cloudflare-model-*`, `cloudflare-ai`, `cloudflare-computer-agent` | Thin provider/transport adapters and existing task lifecycle. Do not build a local agent scheduler or a second Swarm Controller. |
| Reports, Wiki and Inbox | `cloudflare-artifacts`, `cloudflare-wiki`, existing research compiler | Reuse artifact revisions and Wiki head changes; Inbox is a view over existing records. |

The names above locate code, not prescribe a bulk rename. When touching a capability, keep its public
entrypoint, group related internals and remove pass-through layers after migrating their callers. Merge
packages when their only distinction is forwarding the same capability or satisfying a source counter.
Split only for a real dependency/runtime/public-interface boundary. Register changed manifests/import
boundaries together; do not create new scaffolding for every row in this table.

Rust remains the owner of promoted pure decisions; TypeScript owns platform I/O and the currently unported
decisions. SQL remains the atomic storage boundary. There is no permanent duplicate decision engine.

## 3. Owner reads and ordinary answers

Apply ADR-0018 at composition, not as a bypass scattered through readers. The ingress establishes the
trusted owner principal once; application reads receive that context. Keep the external-client policy
path distinct. Do not copy multi-client grant/qualification chains into the owner summary path.

| Operation | Required work |
|---|---|
| Owner list/summary | One bounded indexed SQL query per page over existing metadata/summary rows. No per-item R2 reads, grants or model qualification. Maintain summary fields in the underlying write path. |
| Saved draft/report | Return stored content and recorded assessment with its revision and freshness. Do not reopen every citation merely to display the draft. |
| Open citation | Resolve the exact admitted revision and bytes through the existing evidence owner; verify representation/digest and applicable purge/currentness. |
| Mutation or paid operation | Cheap local shape/size/budget validation before effects; original idempotency identity; atomic expected-state/CAS at commitment; uncertain acknowledgement reconciles the same attempt. |
| Owner reconnect/deploy | Retain the same owner's draft and last known read with a stale indication; refresh/retry reads. Clear private data on sign-out/principal change. A deploy does not authorize replaying a write. |

Stale fallback must be an observed value for the same owner/project, with a timestamp; absence of such a
value remains an explicit unavailable read. It never converts unknown data into success. Additive fields
in owner list/draft responses are tolerated while known fields remain validated. Mutations and evidence
contracts retain their strict versioned decoding.

E0/E1 uses one streamed synthesis, with four durable responsibilities:

1. Admit the request and record the original run/attempt and spend bound.
2. Prepare the selected-source context once within the model's actual token and runtime budgets. Use full
   selected sources when they fit; otherwise use existing guide/retrieval selection and report omissions.
3. Stream the single synthesis through the existing provider transport. Provisional text is not accepted
   evidence. A disconnected browser observes/reopens the same attempt; it does not start another call.
4. Save the answer, exact matched citations, coverage and summary through existing artifact/receipt owners.

These responsibilities may use up to five native durable steps as in ADR-0018. They do not require a new
universal pipeline framework. Preserve the existing streamed-text extraction and prompt/context compiler.
Optional semantic audit is background work; malformed audit output means unverified, not refuted, and
does not erase a usable saved answer. E2/E3 continues through the explicit deep-research Workflow.

## 4. Managed search and native execution

#377 cancels S52's custom search index, managed-target assignment, target manifests, required-set registry,
generation promotion and rollback machinery. Do not implement them from archived PRs or donor playbooks.
Use Cloudflare AI Search or the selected model provider's search. Retain canonical source admission,
project membership, the existing source/project outbox delivery and exact evidence resolution. Current
D1 lexical/exact compatibility is not permission to create another ranking/index platform.

Cloudflare owns indexing and ranking. The thin adapter owns project filtering, bounded calls, mapping
provider locators back to admitted sources, and honest unavailable/partial results. Provider search success
does not prove corpus completeness. Do not rename the canceled generation registry to recreate it.

Workflows owns durable wait/retry. Existing `native-external-task-step.ts` implements `waitForEvent` for
the unactivated R05 Research external-task W2 graph. Reuse it only if that Research flow is selected;
generic computer-agent assignment remains in the existing dispatch lifecycle. Queue events remain
delivery hints. ResearchSession is a presentation transport, not a second executor or transcript owner.
Do not replace its snapshot transport with a new event journal solely to remove SDK glue. Simplify SDK
overrides only after the pinned SDK can express the same public method surface and lifecycle.

## 5. Storage and compatibility

Keep D1 constraints for unique identities, foreign keys, row-local validity and atomic expected-state
updates. Evaluate pure canonicalization and policy decisions once in their application/kernel owner.
Avoid encoding a second complete research engine in JSON-heavy views/triggers. Moving an expensive check
out of SQL must retain the final transactional predicate that prevents a stale/concurrent write.

Do not add a table per stage, validation, log event or function. Prefer existing records and projection
fields when they share lifecycle. New persistent state needs a named writer, reader and retention purpose;
record that in the change itself, not a new registry framework.

R2 immutability uses native conditional writes, followed by bounded readback. A failed observation is
unknown, not absence; an expected hash is not an observed hash. Validate local cardinality/bytes before
paid verification. HTTP input, persisted planning data, checkpoint receipts and model context have separate
named bounds; update all producers/consumers of a changed representation together.

Retire legacy code by identifying its callers and retained-data readers, stopping new admissions/writers,
migrating consumers, and deleting the superseded implementation in that bounded change. Keep old Workflow
generations only while retained runs need their read/resume/settlement semantics; they do not force new
runs onto the old graph. Do not create a new generation for a source-only refactor with unchanged semantics.

Merged migration files remain history. Inspect actual deployed migration ledgers before any schema action:
the October 15 cancellation record explicitly distinguishes applied 0141 from unapplied 0142–0151.
No blind migration squash, production reset, bulk table drop, branch/worktree deletion or automatic
application of canceled migrations follows from this document.

## 6. React cutover and Rust migration

React cutover joins the existing Vite client output and existing Worker into one reproducible deploy path.
A fixture build is insufficient. Complete feature wiring, standalone agent inbox, service-worker retirement
and inert `/sw.js`, old-tab recovery, and the retirement-safe rollback described in ADR-0016/0017 before
switching production assets. After cutover, remove Astro and superseded PWA renderers/dependencies; retain
only the explicitly bounded rollback artifact for its needed lifetime. Do not build a third UI.

The 17 names in the former Rust target tree are capability families, not 17 required crates. Extend the
existing pure kernel with coherent modules. Add a crate only for a concrete build/dependency boundary.
M1's Wasm self-test is not a product ABI. For a selected operation, implement the pure decision, its versioned
ABI and real Worker caller as one vertical slice; after assembled parity/cutover acceptance, remove the TS
decision. Do not port all families before making the first call. Rust migrations do not block the five
owner product paths (#377), and source language percentages are not a success metric.

## 7. Agent execution and verification

One manager uses one checkout/worktree. Leaves receive a bounded outcome, exact files, relevant contracts
and expected behavior; parallel leaves have disjoint files. The manager serializes shared files and
publishes the coherent change. Existing packet documents are a code/contract map, not 49 permanent locks.
No new JSON claim, claim-only commit, ancestry gate, predecessor approval record or ER-49 prerequisite is
required. Preserve old claims/checker for optional historical audit. This also reflects the already-advisory
manual provenance job introduced on October 15; product CI is separate.

Source size diagnostics guide review; they are not reasons to split capabilities, move tests, create
wrappers or compress formatting. Runtime byte/memory/spend limits still constrain the actual operation.

During implementation use scoped TypeScript compilation/ESLint; Rust changes use scoped compilation and
minimal Clippy; changed SQL uses the existing depth compiler on the affected query/schema. Do not start
test-writing, broad suites, mutation/coverage campaigns or repeated live qualification as prerequisites
to this code phase. Perform the applicable tests and final product acceptance after assembly. Existing
CI is not disabled, and an unexecuted/failed check is never reported as passing.

Measure ADR-0018's targets on the same named project/model/build: list latency below 500 ms, first token
below 4 s, ordinary answer at most 30 s. Record request/query counts and provider/context/save timing so
overhead is attributable; record cold/warm runs and p50/p95 rather than a single best result. The targets
remain unverified. Quality comparison retains the same source set, questions, citations and omissions.
Do not infer a required LOC/table count or a percentage of agent time from repository size.

Current bounded work and donor choices live in [backend-entrypoints.md](../implementation/backend-entrypoints.md).
The source reconciliation is [the October 17 audit](../../.github/audits/2026-10-17/README.md).
