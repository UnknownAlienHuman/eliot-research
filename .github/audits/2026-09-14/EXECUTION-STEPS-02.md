# Execution steps 02 — Research, artifacts, integrations, and operations

This is the ordered implementation section for existing S35–S77, not new feature scope. Use the owning five-part PR for canonical references and exact accepted DTOs. Read [steps 01](EXECUTION-STEPS-01.md) for U/W/B commands and the important separation between root unit tests and actual core Workers tests. Baseline: `a2aca127`; implement the current-main delta, never replace working modules merely because a task mentions their topic.

## Shared implementation decisions

All Research products use the existing `packages/research` contracts, `cloudflare-research` model/freeze/materialization services, `cloudflare-research-stages` audit/citation/coverage handlers, and `apps/eliotr-core/src/research-stage-handlers.ts` factory. An output product selects a versioned schema and installed prompt/profile; it is not another engine, task ledger, or endpoint family. Additive input versions preserve legacy E0/E1/E2 behavior. New schema fields live in the existing contracts package and are decoded strictly.

The actual W1 `LedgerHead` in `packages/research/src/ports.ts` and `assertAppendMutationMask` in `ledger-commands.ts` are binding: portfolio/debt references cannot change through APPEND, and CHECKPOINT cannot modify acceptance or lineage. Initial manifests precede CREATE; changed protected inputs use explicit supersession. Runtime observations use immutable checkpoint payloads. W3 model receipts, W2 stage receipts and W1 investigation events are different identities, not a defect to flatten.

Each product test starts with actual admitted source bytes, not a preaccepted model output. Controlled model responses are appropriate for orchestration tests; actual semantic quality is S93. No finite fixture is a promise of universal factual accuracy.

## S35 — inquiry protocol · [#227](https://github.com/UnknownAlienHuman/eliot-research/pull/227)

1. Extend `research-session.ts::parseResearchRunRequest` with the explicit new version/profile reference from the passport. Keep the old strict decoder and its E0/E1/E2 semantics intact.
2. Use `packages/research/src/ports.ts::ProtocolRegistry` and `cloudflare-research/src/research-protocol-freeze.ts` to resolve an installed profile. Build actual obligations with named verifier/certificate/stop rules, bind them to request identity and persist before execution through W1.
3. Run contracts/research checks and W fixtures: lookup, evidence review, architecture decision; replay with changed profile; old E1/E2 input. **Done:** profiles yield distinct persisted obligations and no implicit grade downgrade or model-selected authority.

## S36 — portfolio and hypotheses · [#228](https://github.com/UnknownAlienHuman/eliot-research/pull/228)

1. Implement the single immutable planning-manifest builder specified in the revised S36 passport: QuestionGraph, hypotheses/falsifiers, represented/missing source classes, explicit lineage and unknown independence.
2. Verify Work R2 readback before initial W1 CREATE using `portfolio_ref`; branches consume that exact ref. Hypothesis registration uses its existing event kind, not arbitrary head editing.
3. Runtime observations do not rewrite initial portfolio/debt refs. Changed protected inputs use S40 supersession. **Done:** two rival hypotheses and ten copies of one origin retain correct identity/independence; forbidden APPEND remains rejected by TS and actual D1. Research/contracts checks, ledger-command U tests and W.

## S37 — actual branches · [#229](https://github.com/UnknownAlienHuman/eliot-research/pull/229)

Execute the revised passport's five commits: **37.1** shared branch envelope/exact read; **37.2** SUPPORT+COUNTER with S22; **37.3** ALTERNATIVE/CHRONOLOGY/IMPLEMENTATION/LITERATURE/SOURCE_AUDIT through the same executor where required; **37.4** W3/R2/W1 settlement and reconciliation; **37.5** actual factory and recovery. Start in `research-stage-handlers.ts` and existing stage packages. **Done:** typed role results reach EvidenceFreeze; failed/missing branches remain debts and repeated callbacks do not duplicate effects. Run research/workflow/model-admission/recovery checks and W. No loop of uncheckpointed paid calls inside one retryable step.

## S38 — lanes and named verifiers · [#230](https://github.com/UnknownAlienHuman/eliot-research/pull/230)

1. Use W1 `LANE_REGISTERED`/`OBLIGATION_REGISTERED` and existing obligation fields in `ports.ts`; persist registration before the corresponding evidence exposure.
2. Wire the installed verifier to `OBLIGATION_ACCEPTED`. Require the event actor to equal the registered verifier; preserve metric and exposure state. A model can propose a claim, never certify itself.
3. **Done:** early independent verification succeeds; post-exposure metric edits require explicit deviation/supersession, mixed lanes stay separate, unsupported verifiers produce a named blocked obligation. U `ledger-commands.test.ts`, research/contracts checks and W. Missing external execution environments are not implemented by evaluating arbitrary code inside the Worker.

## S39 — controlled acquisition · [#231](https://github.com/UnknownAlienHuman/eliot-research/pull/231)

1. Bind the approved acquisition request to protocol/source mode, destination, revision expectations, disclosure policy and existing operation identity. Corpus-only returns without a network acquisition call.
2. Use current source capture/normalization/admission ports; check every redirect/destination, reject private or unauthorized destinations and authentication/error-page responses. Preserve raw bytes, media type, observed origin, extraction gaps and parser generation.
3. Only after exact immutable readback and admission may a locator enter the manifest. **Done:** real captured bytes become an admitted citation; a snippet, partial upload, unsafe redirect or post-freeze insertion cannot. Ingest/research/assurance checks plus W; no crawler framework or automatic external provider subscription.

## S40 — debts, completion, reopen · [#232](https://github.com/UnknownAlienHuman/eliot-research/pull/232)

1. Use existing `packages/research/src/coverage.ts`, `packages/domain/src/completion.ts` and W1 to calculate the existing terminal disposition from obligations, coverage, debts, waiver authority and next probes.
2. Persist runtime debt observations as immutable referenced results; do not APPEND different `debt_refs` into a protected head. Read them through the corresponding checkpoint/result. A new initial debt/portfolio/scope/protocol requires supersession through the existing atomic old/new-head operation.
3. Implement the passport's versioned reopen API: bind reason, affected claims and new input identity; preserve old result and revalidate changed premises plus dependent sections. Same-run transient recovery remains S15, not reopen. **Done:** replay makes one intended revision/run, changed input conflicts, old hashes remain unchanged, no sampled absence claim. Research/recovery checks, U ledger masks and W.

## S41 — ASK and BRIEF · [#233](https://github.com/UnknownAlienHuman/eliot-research/pull/233)

1. Register ASK/BRIEF as output profiles in the existing model/profile configuration and strict output decoder; define the public-product-to-existing-execution mapping, leaving FAST_SEARCH model-free.
2. ASK separates supported answer, inference and limitations with exact citations; follow-up references the previous investigation/result revision, not an unbounded chat log. BRIEF preserves source conditions, numbers, dissent and unknowns while shortening text.
3. **Done:** two-turn English/Russian fixtures preserve project identity and exact support; no new source silently enters a frozen result. Research/artifact/Golden checks, actual W pipeline. Real quality is S93; no separate chat backend.

## S42 — COMPARE · [#234](https://github.com/UnknownAlienHuman/eliot-research/pull/234)

1. Freeze target refs and requested axes before retrieval. Add a comparison output profile over S41's shared execution, not a new run service.
2. Each material cell has observed value, unit, conditions/time/version, exact evidence refs or explicit unknown. Unit conversion is a reproducible declared transformation; missing value is not zero and recommendation is separate from observation.
3. **Done:** differing versions/units/populations and missing fields remain distinct in the saved artifact and its citations. Foreign targets and unsupported numeric cells fail. Research/numeric/artifact/Golden checks and W; replay returns the same result.

## S43 — HYPOTHESIS_REVIEW · [#235](https://github.com/UnknownAlienHuman/eliot-research/pull/235)

1. Read S36's stored cards; dispatch required support/counter/alternative roles through S37 with the declared verifier/lane rules from S38.
2. Persist each hypothesis's support, counterevidence, rival explanation, test/falsifier and next probe, with conditions and exact source refs. Model confidence never replaces a result certificate.
3. **Done:** a confound/rival fixture retains the losing explanation and does not promote exploratory evidence to confirmation or unknown to universally false. Research/Golden checks and W result/citation/replay tests. The product does not manufacture an experiment it has not executed.

## S44 — FACT_CHECK · [#236](https://github.com/UnknownAlienHuman/eliot-research/pull/236)

1. Preserve the original input bytes/hash and map proposed material claims to exact input spans. Record unresolved splitting regions; never silently drop hard-to-check claims.
2. Reuse current retrieval→freeze→AUDIT_CLAIMS; use the existing verdict vocabulary and differentiate evidence in a whole source from support in the cited excerpt. Preserve negation, quantities, population and version.
3. **Done:** all canonical verdict cases are covered, fabricated/wrong excerpts and omitted/weakened claims fail the fixture. Replay retains input-to-claim mapping. Research/artifact/Golden checks and W; semantic splitting accuracy is evaluated independently in S93.

## S45 — project versus literature · [#237](https://github.com/UnknownAlienHuman/eliot-research/pull/237)

1. Freeze the project snapshot and external source portfolio; classify each input as specification, implementation snapshot, test/operational observation, primary literature or secondary/community claim.
2. Use the existing branch/artifact path to save a claim-to-evidence matrix: support/counterevidence, gap, severity, alternative and next probe. Missing or inaccessible code stays unresolved.
3. **Done:** an obsolete specification, unimplemented promise and independently observed result are not conflated; source-file existence never proves successful execution. Research/artifact/Golden checks and W. This product does not autonomously alter the audited client repository.

## S46 — DEEP_RESEARCH · [#238](https://github.com/UnknownAlienHuman/eliot-research/pull/238)

1. Compose the existing protocol/planning, role execution, acquisition, counter-search, freeze, audit, debt and materialization handlers under the DEEP profile; no new scheduler.
2. Run one E2 fixture requiring independent sources/counterevidence and one E3 fixture requiring pre-registered evaluation and a named verifier. Requested grade remains separate from model capability.
3. **Done:** actual obligations and output refs, not 18 stage names, justify the resulting disposition; missing requirements stay visible with next probes. Research/workflow/artifact/Golden checks and W recovery/citations; no silent grade lowering or unregistered post-freeze search.

## S47 — extraction/admission quality · [#239](https://github.com/UnknownAlienHuman/eliot-research/pull/239)

1. Use current raw capture/conversion, `packages/domain/src/source-admission.ts` and `qualification.ts`; classify supported declared formats using actual converter output and original bytes.
2. Preserve extraction completeness, unsupported structures, taint, parser identity and qualified coordinate maps before guarded canonical admission/outbox. Reuse pre-normalized bundles for approved preprocessing; do not rerun a model on them by default.
3. **Done:** valid, degraded and corrupt format cases produce the appropriate admission state without partial canonical writes, silent truncation or invented native accuracy. Ingest/source/assurance checks, W and `pnpm local:documents`. Actual format quality receipts remain distinct from controlled conversion tests.

## S48 — native/normalized navigation · [#240](https://github.com/UnknownAlienHuman/eliot-research/pull/240)

1. Start in `cloudflare-navigation/src/native-coordinate-map-adapter.ts`, `navigation-service.ts` and the existing exact evidence resolver. Bind every map/anchor to the source revision and qualified producer.
2. Complete source→DocumentMap→section→parent/neighbors→open with exact normalized byte intervals and native coordinates only where validated maps exist. Page/line numbers are never guessed from Markdown.
3. **Done:** Unicode/table/code/page fixtures resolve exact content, corrupt/foreign maps fail, and neighbors remain within authorization. Source/retrieval/assurance checks, W plus Library/Lens/citation B. Missing native maps expose the honest lower-precision path, not fake coordinates.

## S49 — ProjectAtlas · [#241](https://github.com/UnknownAlienHuman/eliot-research/pull/241)

1. Extend existing orientation/navigation materialization (`orientation-service.ts`, `orientation-materialization.ts`) using exact project membership and SourceCard/DocumentMap revisions.
2. Save one immutable Atlas with reading routes and represented/omitted members; unknown independence and omissions remain coverage/dependency inputs. Reuse S99 larger metadata scope, not a second source store.
3. **Done:** two projects sharing a source retain distinct scope/policy, unrelated changes do not invalidate both, relevant or omitted-source updates invalidate appropriate views. Source/retrieval/research checks, W and navigation B; Atlas is navigation, not an EvidenceHandle.

## S50 — LOCATE and lanes · [#242](https://github.com/UnknownAlienHuman/eliot-research/pull/242)

1. In the existing retrieval planner/service, preserve raw literal/negative/identifier input and direct-first lookup; query rewriting is not silently enabled.
2. Compose existing exact/lexical/structural/semantic lanes, section deduplication, source-family diversity and selective reranking. Use S09 for SEM, S48 for exact structural expansion; keep generations separate.
3. **Done:** ID/quote/vague/tail/diversity fixtures reach exact authorized bytes with truthful executed/skipped lane trace; no unnecessary reasoning call or top-k absence claim. Retrieval/source/Golden checks and W; do not implement BM25 or embeddings again.

## S51 — exhaustive search · [#243](https://github.com/UnknownAlienHuman/eliot-research/pull/243)

1. Use existing `exhaustive-query-service.ts` and `exhaustive-workflow-service.ts`; bind complete eligible metadata and shard boundaries to the frozen scope, including S99 larger projects.
2. Scan bounded ranges with overlap at text boundaries and persist shard counts/digests/cursors. Deduplicate identical redelivery, reject conflicting duplicates, and reconcile against all expected members before declaring complete.
3. **Done:** an independent exact oracle matches tail/page/range-boundary results; missing/failed shards never become complete absence. Retrieval/workflow/recovery checks and W; large outputs are R2 handles, not whole-corpus buffering.

## S52 — index lifecycle · [#244](https://github.com/UnknownAlienHuman/eliot-research/pull/244)

1. Connect admitted source outbox to existing per-channel projection builders/receipts. Admission ACK is not index readiness; report missing/failed channels explicitly.
2. Build shadow generation B while A serves; compare exact expected item set, model/parser/config identities and quality evidence before expected-head CAS promotion. Pin a run to its selected generation.
3. **Done:** partially built B cannot serve; duplicate/lost events reconcile; rollback never restores purged data. Retrieval/source/delivery checks and W; actual managed index readback is S95. Keep existing generation registry rather than removing or duplicating it.

## S53 — REPORT compiler/COW · [#245](https://github.com/UnknownAlienHuman/eliot-research/pull/245)

1. Implement the missing behavior behind `packages/research/src/artifact-compiler.ts::ArtifactCompiler` using current `cloudflare-research` report materialization and `cloudflare-artifacts` immutable readers. The interface alone is not an implementation.
2. Compile an ArtifactSpec into individually identified sections with exact evidence/freeze dependencies and limitations. Reconcile all required sections before writing an ArtifactRevision; missing/unaudited output remains draft.
3. Revise section B of A/B/C: reuse A/C only when premise/evidence/contract/residency dependencies are unchanged, verify changed B in the usual path, then CAS the artifact head after exact R2 readback. **Done:** lost ACK/replay/concurrent edit cannot produce a broken or duplicate head. Artifact/research/recovery checks and W; no second report engine.

## S54 — publication · [#246](https://github.com/UnknownAlienHuman/eliot-research/pull/246)

1. Apply `packages/domain/src/publication.ts` and existing Wiki/report publisher to the exact revision, freeze, claim support, section completeness and current disclosure policy.
2. Execute the documented D0–D3 review rules; explicit D1 policy is not blanket D2/D3 authority. Edited claims cannot inherit an old certificate merely because the document ID is unchanged.
3. **Done:** accepted head changes only after exact body/dependency readback and guarded D1 CAS/outbox; cropped/stale/unsupported/wrong-value citations fail. Artifact/research/Golden checks and W concurrent publish/lost-ACK tests. Editorial publication is separately labeled from factual acceptance.

## S55 — derived dependencies · [#247](https://github.com/UnknownAlienHuman/eliot-research/pull/247)

1. Complete existing `ArtifactDependencyManifest` production for source→Wiki→section→managed external copy, including omitted-source and premise dependencies, at the same canonical settlement as the derived revision.
2. Existing change/outbox consumers mark targeted historical freshness for ordinary updates and deny/redact affected data for purge/revoke. Bind replay cursors to actor/scope; unchanged unrelated projects are untouched.
3. **Done:** late notification/restart cannot miss a dependency or substitute a new source head; WIKI/ARTIFACT retrieval respects accepted state and original lineage. Artifact/delivery/erasure/retrieval checks and W. Uncontrolled prior downloads are outside enforceable deletion claims.

## S56 — selective EvidenceAtoms · [#248](https://github.com/UnknownAlienHuman/eliot-research/pull/248)

1. Use the existing `packages/research/src/distillation.ts` contract and admitted trigger policy; ordinary ingest makes no blanket atom-generation calls.
2. Decode candidates strictly and resolve exact source spans, conditions, units, modality and time before atom admission; papers/project profiles preserve their distinct field semantics.
3. **Done:** source unsupported stronger paraphrase, lost negation/unit and invented reference fail; accepted atoms reach the existing ATOM lane and purge invalidates them. Research/retrieval/Golden checks and W. Derived atoms are not independent source confirmations.

## S57 — ArgumentMap · [#249](https://github.com/UnknownAlienHuman/eliot-research/pull/249)

1. Extend the existing `packages/research/src/argument-map.ts` relation path with explicit premise/claim/objection/source-span refs and native/parser/model/human-reviewed precision classes.
2. Use current immutable navigation/dependency storage and bounded ARGUMENT traversal; source co-occurrence does not prove causal influence or entailment.
3. **Done:** a premise/objection fixture opens exact evidence, invalid/foreign/cyclic expansion is bounded or rejected, and purge removes affected disclosure. Research/retrieval/Golden checks and W; no graph database or full-corpus distillation.

## S58 — selected Workspace ingress · [#250](https://github.com/UnknownAlienHuman/eliot-research/pull/250)

1. Follow the revised passport through current `workspace-candidate-admission.ts` ports: official selected-client export→plan/observation→service capture/read→conversion→admission/status. Start with no preseeded owner capture.
2. Apply S10's one grant and allowed namespace to raw capture, read, conversion and final admission. Retain signed caller/observation/byte identity; conversion spend requires its separate existing authorization.
3. **Done:** the service creates its own capture and conversion and gets one admitted revision/outbox; wrong actor/bytes/namespace/revoke/unfunded conversion fail at their actual boundary. Google/ingest/model-admission checks and W; external official connector action is tested separately, not forged by a request body.

## S59 — Google delivery · [#251](https://github.com/UnknownAlienHuman/eliot-research/pull/251)

1. Bind canonical artifact revision, destination parent and chosen export/readback representation in the existing Workspace action plan. Google I/O belongs to the authorized selected-client connector, not Worker OAuth.
2. For an update, pin the existing object ID. For creation, retain the actual provider ID/operation evidence; do not invent unsupported ID reservation. Compare documented normalized native-Doc representation or byte-preserving export as appropriate.
3. **Done:** verified copy has the right revision/content/parent; lost creation ACK is reconciled by demonstrated connector capabilities or stays UNKNOWN without blind recreation. Canonical report remains readable through outage. Google/artifact/recovery checks and controlled transport tests, then actual action/readback receipt. Managed copies feed S55.

## S60 — federation execution · [#252](https://github.com/UnknownAlienHuman/eliot-research/pull/252)

1. Keep the existing seven-operation wire contract and actual federation service; connect reserved jobs/outbox to existing retrieval/Research execution, not a second runner.
2. Preserve server/peer fence, scope/manifest and W2/W3 identity; pack/read-only requests do not cause unnecessary synthesis. Store exact result bundle before reporting completion.
3. **Done:** independent submission→status→result/read→cancel exercises real local state; repeated/lost/revoked requests do not duplicate jobs or strengthen a PARTIAL/UNKNOWN research disposition into success. `pnpm federation:check`, delivery/research/recovery checks and W. S61 tests independently encoded wire behavior.

## S61 — independent peer test · [#253](https://github.com/UnknownAlienHuman/eliot-research/pull/253)

1. Use a fetch-based test client that does not import server codecs/services; retain independent exact request/response fixtures for all seven operations.
2. Test actor/fence/manifest, cursor/range identity, retention, truncated bytes and revocation against the actual server/storage. Inject a server encoding defect to prove the client test detects it.
3. **Done:** foreign/stale/substituted/range failures remain safe and replay retains the same job; local versus actual authenticated peer qualification are separately recorded. Federation/contracts checks and existing `pnpm federation:client-fixture`; no runtime dependency on a client database/package.

## S62 — erasure request · [#254](https://github.com/UnknownAlienHuman/eliot-research/pull/254)

1. Find and wire `prepareErasureForOwner` in existing core services to owner prepare/permission/execute/status; preserve the exact source/namespace/case identity and current permission ceiling.
2. Expose the existing lifecycle in PWA: requested/uncertain/blocked is not PURGED; Research access does not grant deletion rights.
3. **Done:** owner request/reload/replay creates one case, while changed input/expired approval/foreign source cannot delete. `pnpm erasure:check`, W and B using disposable data. This task does not authorize deletion of the owner's real library.

## S63 — full purge closure · [#255](https://github.com/UnknownAlienHuman/eliot-research/pull/255)

1. Enumerate the existing managed dependency closure from S55 and actual manifests: original/normalized/work objects, indexes, derived sections, managed copies and backups. No new deletion engine.
2. Fence late producers, invoke each existing deletion/absence adapter, preserve retention holds and collect exact object/version/domain absence evidence; duplicate observations do not cover a missing location.
3. **Done:** no affected read/search/export can disclose purged data, late replay cannot resurrect it, locked/unobserved copies stay BLOCKED with a review condition. Erasure/backup/delivery/recovery checks and W; native closure receipt separately. Never claim deletion of uncontrolled downloads.

## S64 — Queue/DLQ recovery · [#256](https://github.com/UnknownAlienHuman/eliot-research/pull/256)

1. Connect existing scheduled reconciler, outbox dispatcher and consumer inbox settlement; enqueue ACK is not consumer completion.
2. Retry known safe transport only, using original operation/message identity and lease. Re-read current authority/receipt before effects. Poison follows existing DLQ policy; authorized replay does not bypass strict decode or invent a new paid attempt.
3. **Done:** missing delivery is recovered, identical delivery is idempotent, stale lease/crash/lost ACK/revoke/purge do not strand or duplicate effects. `pnpm delivery:check`, `pnpm recovery:check` and W; actual native DLQ redelivery is S95.

## S65 — backup source/offsite adapters · [#257](https://github.com/UnknownAlienHuman/eliot-research/pull/257)

1. Reuse existing O2 `epoch.ts`, `coherent-cut.ts`, `offsite.ts` and encryption/nonce/replay authority; connect current D1/R2 source ports, including all current columns/tables.
2. Implement the existing OffsiteCopyAdapter describe/put/get/delete contract for the approved destination; verify exact ciphertext readback and authenticated decoding before success.
3. **Done:** a consistent portable epoch, no credentials/keys in export, partial/corrupt/restart/lost-ACK cases safe. `pnpm backup:check` and W source-port tests. A controlled local destination proves the adapter, not independent offsite availability; actual failure-domain/retention/delete evidence requires the real approved target.

## S66 — clean restore · [#258](https://github.com/UnknownAlienHuman/eliot-research/pull/258)

1. Reuse the epoch/manifest parsers and existing restore port on a verified isolated, non-serving target; validate all parts, schema and exact hashes.
2. Apply the independent current purge/policy frontier before revealing restored bytes or rebuilding S52 projections. Do not reactivate old credentials. Missing current purge evidence keeps readiness false.
3. **Done:** an epoch created before later purge restores permitted heads but never exposes later-purged content; interruption resumes the same operation and cannot enable traffic early. Backup/erasure/recovery checks and W; clean-target native restore and measured RPO/RTO separately. No production restore is implicit in writing the code.

## S67 — code/index rollback · [#259](https://github.com/UnknownAlienHuman/eliot-research/pull/259)

1. In existing deploy verification and expected-index-head switching, check the selected old build against current schema/config/handler/resource identities before switching.
2. Preserve current source/artifact heads, purge and policy. Distinguish proven compatible continuation from unsupported backend transitions; the latter retain saved runs/history with explicit forward repair, not replacement execution.
3. **Done:** compatible A→B→A and index B→A preserve canonical state and effect identity; wrong target/schema/CAS fails and purged data never returns. Local ordering/readback tests, workflow/recovery checks, then a separately approved native rollback. This is not restoration of an old data snapshot.

## S68 — bounded Steward · [#260](https://github.com/UnknownAlienHuman/eliot-research/pull/260)

1. Wire the existing `packages/research/src/steward.ts` checks into a bounded scheduled pass with existing cursor/operation identity; inspect actual freshness, hashes, delivery, backup, purge, routes and usage observations.
2. Persist actionable findings; semantic revalidation is a candidate only after an explicit new trigger. QueryHint/policy promotion requires the existing verifier/Golden path.
3. **Done:** unchanged pass makes zero model calls, stale Wiki produces a candidate not a published revision, repeated triggers do not rewrite content, unknown observation is not healthy. `pnpm steward:check`, Golden/delivery checks and W. No autonomous permission expansion, hard deletion or new agent daemon.

## S69 — actual security boundary · [#261](https://github.com/UnknownAlienHuman/eliot-research/pull/261)

1. Trace the existing policy/reference-manifest/context/output chain from admitted bytes to model and client; write the allow/deny matrix for viewer, model and client separately.
2. Add actual-boundary cases: revoke during I/O, source instructs erase/exfiltrate, forged citation/tool/actor, unsafe acquisition destination, PWA HTML/script injection, and secret-bearing error/log values.
3. **Done:** prohibited network/storage/disclosure effects are absent while authorized paths work; no source prose grants authority. Model-admission/assurance/contracts/erasure checks, W and security B plus existing secrets/license/dependency checks. No blanket exclusions or new security framework; native T5 separately.

## S70 — ownership and residency · [#262](https://github.com/UnknownAlienHuman/eliot-research/pull/262)

1. Use actual `packages/domain/src/source-ownership.ts`, `owner-cutover.ts`, `residency.ts` and admission adapters. Shared membership does not duplicate mutable ownership; equal bytes do not authorize cross-key/retention reuse.
2. Bind bilateral cutover to exact owners, source set/view and fence; explicit unsaved snapshots need the existing origin/view/policy receipt, never implicit buffer capture.
3. **Done:** valid cutover/restart converges to one active owner and old writers fail; unilateral/stale/wrong-residency/implicit-unsaved cases reject before writes. `pnpm owner:check`, `pnpm authority:check`, `pnpm ingest:check`, W. Preserve historical revisions, not a new ownership service.

## S71 — operational visibility · [#263](https://github.com/UnknownAlienHuman/eliot-research/pull/263)

1. Populate existing observability/readiness fields with actual operation/generation/trace/latency/error observations for model, index, outbox/DLQ, purge, backup and usage. No content/prompt/credential labels.
2. Display one actionable diagnostic origin and recovery action in current Connections/details; unknown observation or missing alert sink is explicitly unknown, not zero errors/READY.
3. **Done:** the owner diagnoses injected failures without SQL, repeated events do not double-count spend, and permitted evidence reads remain usable under model budget exhaustion. W metric/readiness tests and existing checks; actual configured sink/native control readback separately. No new monitoring/accounting backend.

## S72 — session events · [#264](https://github.com/UnknownAlienHuman/eliot-research/pull/264)

1. Implement the passport's authenticated events route over existing ResearchSession/W2/change receipts. D1 is replay authority; persist before notify, never issue a token-bearing URL.
2. Use native hibernation of the pinned runtime and actor/run-bound cursors; frames contain state and refs, not full source/model bodies. Bound slow consumers with explicit resync/status fallback.
3. **Done:** disconnect/eviction/lost notification recovers committed events without starting a run; stale/foreign cursors, revoke and late completion do not resurrect state. Workflow/recovery checks and W, then actual native hibernation proof. No broker or second task ledger.

## S73 — Library/project flow · [#265](https://github.com/UnknownAlienHuman/eliot-research/pull/265)

1. Recompose existing `main.ts` project/library/raw-file panels into one project selector, one source list and one add-document flow. Give every button a stable accessible label.
2. Keep capture, conversion, admission and index readiness distinct; multi-file work uses independent per-file operations. Reuse project CAS/membership and immutable source revisions for attach/detach/update/history.
3. **Done:** empty account→two projects→import/shared source→revision→Lens→Research works without SQL or duplicate source; partial failure/reload/stale CAS states are clear. PWA U, W project/import tests and B; keyboard/mobile/dark/light screenshots. No frontend rewrite.

## S74 — Connections · [#266](https://github.com/UnknownAlienHuman/eliot-research/pull/266)

1. Separate current server reachability, model readiness, project-client permission and selected Workspace action/readback using existing APIs and S31's grant form.
2. Display the actual checked operation/time and a specific corrective action; status refresh is not paid qualification. A local ERC grant revoke does not revoke external Google consent.
3. **Done:** wrong actor/project, expired proof, missing credential and unavailable external action are distinguishable, and permitted saved reads remain available. Google/model/authority checks, W and B. Do not enable unselected legacy OAuth routes just to increase API/UI parity.

## S75 — Wiki/report flow · [#267](https://github.com/UnknownAlienHuman/eliot-research/pull/267)

1. Reuse current report/Wiki panels/readers: clear draft versus published lists, selected revision body, claim verdicts, citations and history.
2. Connect section edit/review/publish/export to S53/S54 CAS and exact revision; browsing history never changes head, edited claims do not inherit obsolete audits, partial export is not complete.
3. **Done:** A/B/C→edit B→review→publish→v1/v2/citation/export preserves allowed unchanged hashes and honest evidence state across reconnect. Artifact/research checks, W and B; keyboard/mobile screenshots. No renderer/workflow library for layout changes.

## S76 — formatting · [#268](https://github.com/UnknownAlienHuman/eliot-research/pull/268)

1. Pin the chosen compatible local dev formatter and exclude immutable fixtures/migrations/generated evidence. First format compressed `research-session.ts` and model attempt/spend methods, separate from behavioral edits.
2. Check semantic diff, especially string/template/SQL literal values, and run affected tests. Continue in bounded file batches; installing the tool alone is not completion.
3. **Done:** product TS/JS follows one readable style without hiding long functions or minifying to satisfy source counts. Run formatter, affected tests and types. S90 owns actual build/runtime budgets; do not fragment packages merely to lower physical line counts.

## S77 — validation reuse · [#269](https://github.com/UnknownAlienHuman/eliot-research/pull/269)

1. Start with `wiki-owner-edit-proposal.ts::boundedText`; characterize units, surrogate/NUL/empty/control behavior and domain error mapping against its reader.
2. Reuse one pure Unicode/length primitive in an existing lower layer with explicit units; caller-specific allowed characters/errors remain local. Migrate only consumers whose before/after corpus proves equivalence, one caller at a time.
3. **Done:** BMP/astral/surrogate/LF/CRLF/max/max+1 inputs retain exact accepted bytes/errors and existing IDs; the repeated primitive is removed, not wrapped by another copy. Artifact/contracts/boundaries checks, U and W writer/readback regression. No validator DSL or merging incompatible serializers; S28/S78 own canonical bytes.
