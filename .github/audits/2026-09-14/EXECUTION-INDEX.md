# Eliot Research — v1 execution index, audit mapping, and readiness limitations

**99 assignments: S01–S99, PRs #193–#291. PR #292 is this index, not another implementation.** The assignment specifications and PR descriptions are maintained in English. Original source audits and historical discussion are preserved in their original language.

Reviewed application baseline: `main@a2aca1277b0edbbed04de66e0d44e383e1b815ef`. Source audits are dated 2026-09-14; this language/readiness correction is dated 2026-09-15. Editing these planning PRs does not change application code, implement the fixes, run application tests, or deploy anything.

## 1. What this plan establishes — and what it does not

This index maps the known consolidated audit findings and mandatory selected-profile work to assignments. **Coverage of requirements is not proof that every assignment is fully implementation-ready, atomic, mutually compatible under every future change, or sufficient for unattended success.** Earlier descriptions of all 99 as small, completely verified tasks were too strong.

The series contains different kinds of work:

| Kind | Examples | How to execute |
|---|---|---|
| Focused defect repair | S01–S04, S08/S09, S28 | Start from the named failure/caller; implement and verify one bounded change. These are reasonable starting points, not preaccepted implementations. |
| Shared-contract or multi-component implementation | S05/S10/S31/S33, S35–S40, S58/S59/S98/S99 | Follow the specified common contract, inspect all affected actual callers, preserve migration/currentness behavior, and prove the boundary. Do not invent a competing framework. |
| Multi-checkpoint family completion | S78/S89; related grouped domain ports and S91 transaction coverage | Execute separate named family checkpoints. A short Markdown file does not make the whole task a small commit. Do not close the aggregate after the first family. |
| Integrated, external, or release acceptance | S92–S97 | Run only after the necessary code/configuration exists. Local fixtures cannot replace actual platform/client observations. |

The plan still requires implementation-level reasoning, code review, and real tests. Some aggregate tasks require identification of exact current callers and schema transitions before editing. They are not a literal patch recipe or a certification that an agent can execute the entire queue without investigation. Known ambiguity must be resolved in the existing owning assignment, not silently filled with a new architecture.

**Permitted starting point:** the focused stabilization work, followed by dependency-ordered implementation. **Not supported:** launch the entire queue blindly, treat every card as independent, or declare the product ready because all planning cards were closed.

## 2. Target and authoritative documentation

The target remains mandatory **v1, Slices 0–6, selected gemini-mcp profile**, under:

- [ELIOT_RESEARCH](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), architecture 29.1.
- [LANGUAGE_RUNTIME_CONTRACT](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/LANGUAGE_RUNTIME_CONTRACT.md), version 1.0.
- [ADR-0006](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/adr/0006-google-external-transport-profiles.md), selected versus legacy transport applicability.
- [Production readiness plan](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md) and [execution contract](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/launch-prs/execution-contract.md).

Keep one Worker with PWA, HTTP/MCP, Queue, DO, and Workflows. D1 Core/R2 are canonical; D1 Search/AI Search are rebuildable projections. TypeScript owns Cloudflare effects/control-plane integration, promoted Rust owns the specified pure deterministic decisions, and SQL owns final atomic invariants. Do not introduce another backend, policy DSL, agent framework, or runtime status registry.

Do not silently add unselected legacy drive-exchange/custom OAuth, a Google Cloud project, client-side ELIOT runtime, Slice 7 specialist profiles, optional Browser Rendering, or optional large-tabular infrastructure as mandatory release prerequisites. Ordinary scientific documents, tables, and conversation exports do not imply every specialist product.

Application implementation and focused regression/negative/replay tests come first. Larger corpus, native-platform, workload, and release acceptance follow the relevant completed paths. Final selected-version acceptance is S97/#289, not a PR count.

## 3. Execution order and dependencies

**Stabilize first:** S01–S04. S02 does not need S01 to be closed; priority is not permission. Exact browser failure diagnosis precedes guessing at an assertion or changing product behavior.

**Core backend:** S05–S15, S31–S34, with S17 diagnostics where needed. Include **S98/S99 early**: machine ingestion and project scope beyond the first 64 sources are not post-release extras.

**Substantive Research:** S35–S46 with S21–S23, plus source/navigation/retrieval S47–S52. Then artifact/publication/dependency and external-client work S53–S61. Compile/export and source intake can be developed before the entire DEEP product is complete when their specific input contracts are available.

**Data safety and operation:** S62–S72. **Human UI:** S26 and S73–S75, using the same application services as headless clients, not a second implementation hidden in the browser.

**Language and maintainability:** S76–S91. Stabilize each family's semantics before porting it. A ready identity family can establish the real ABI/shadow earlier; do not wait for all Rust families before testing the bridge. Proceed parity→shadow→actual caller promotion→removal separately per family.

**Acceptance:** S92 local integration→S94 approved complete staging→S93 quality plus S95 native/security plus S96 workload→S97 canary/release. Prepare probes/corpora earlier. Do not require the future live receipts of a staging environment before allowing its first complete deployment.

Implementation is on current **main, without local worktrees**, as directed by the owner. Coordinate shared routes, composition, contracts, migrations, lockfiles, and CI edits. Remote planning branches hold specifications; merging their Markdown is not implementing the task. Old Launch theme branches are not safe wholesale code merges.

### Known technical dependency chains

```text
S10 common authorizer -> S31 owner grant management
S10 -> S11 query/run/status + S12 report/evidence -> S13 MCP
S14 cancellation + S15 recovery + S13 -> S32 client controls
S10/S31 + existing normalized admission -> S98 machine ingest/attach
S05/S06 -> S33 long-run authority; S29 -> S34 model-proof lifecycle
S35 protocol -> S36 portfolio -> S37 actual branch execution
S35 + S09 -> S22 counter-search -> S37 integration
S35/S36 -> S38 verifier/lane -> S40 debts/reopen
S37/S38/S39/S40 -> S46 DEEP orchestration
S47 admission -> S48 navigation -> S49 Atlas
S47 -> S51 exhaustive + S52 projection lifecycle
S53 compiler + S38 -> S54 publication; S53 -> S55 dependencies
S62 erasure request + S55 -> S63 erasure closure
S65 epoch + S63 purge + S52 projection rebuild -> S66 restore
S05 + S52 -> S67 code/index rollback, independent of data restore
accepted S78 identity family -> S88 product ABI/shadow
accepted domain family + S88 -> S89 per-family promotion/removal
integrated required product, including S98/S99 -> S92
S92 + required code/config/build readiness -> S94
S94 -> S93/S95/S96 -> S97
```

These are known contract/data dependencies, not an exhaustive proof about every future implementation edge. A dependency means available accepted code/interface and its applicable local regression, not closure of an entire card including later live acceptance. Do not execute 99 writers concurrently against shared main.

## 4. Shared decisions and corrected instructions

**Deployment:** S05 separates exact build provenance from reproducible backend execution compatibility. Its initial safe case is identical backend inputs with PWA-only changes; that is not a general proof for arbitrary schema/handler upgrades. Unknown compatibility must not be hidden behind a permanent generation ID or SHA allowlist. S67 handles explicit supported rollback cases.

**Service authorization:** S10 chooses one project_client_grant table/strict DTO and verified actor identity. S31 uses the existing `/api/v1/research/projects/:project_id/client-grants` namespace, not a second `/api/v1/projects` API. Consumers share operation vocabulary, namespace restrictions, grantor ceilings, and spend references. Configured Client ID is not verified connection evidence. Services never impersonate owner_pwa.

**Import and attachment:** S58 includes the whole service capture/read/conversion/admission chain, not only its final call against a privileged fixture. S98 uses existing normalized-bundle operations and append-only service attachment through the current project PUT/UpdateProjectRequest. Ingest permission does not grant broad project editing, namespace-wide reading, paid processing, or ownership cutover.

**Execution lifetime:** owner reauthentication, historical read permission, operation execution grants, model-proof expiry, and source revision changes are distinct. Frozen input and receipts are not rewritten to fix access. S15/S32 preserve committed SYNTHESIZE while allowing the first legitimate subsequent AUDIT_CLAIMS under its own reservation. Count paid effects per stage; an unchanged global count is not the correct recovery criterion.

**Protocol compatibility:** S35 preserves legacy accepted E0/E1/E2 behavior; it must not silently downgrade older E1/E2 requests to E0. The new protocol identity is explicit and versioned, not an expansion of an old strict schema.

**Large scope:** S99 reuses existing larger generic scope handling. A UI preview, result limit, and complete authorized membership denominator differ. Preserve actual canonical byte/member bounds rather than raising every constant or inventing another store. S51 uses this scope work, not an unrelated Rust port as a blanket prerequisite.

**Google delivery:** S59 requires the actually supported connector's readback and creation-reconciliation behavior. Do not assume preallocated IDs or provider idempotency absent evidence. An unreconcilable lost creation response remains UNKNOWN; filename matching cannot prove unique creation. Missing external capability is not solved by fabricating a success receipt.

**Cloudflare AI:** preserve the canon-required Budget Governor and AI Search generation registry. S09 repairs wiring; S29/S34 address configuration/proof lifecycle. Adapter size alone is not evidence of reimplementing a managed product.

**Rust:** S88 specifies the shared canonical byte envelope and wasm-bindgen glue for the imported Wasm module in the existing TS Worker. It does not authorize workers-rs rewriting or another service. S89 uses the required per-family evidence and actual caller switch before deleting replaced TS authority; no more-permissive silent fallback.

**Replay:** identical duplicate shard/receipt delivery is deduplicated, not counted twice and not by itself a failed complete result. Conflicting duplicates fail; extra receipts cannot replace missing members. This clarification is explicit in S84/S86.

**Maintainability:** S28/S77 merge only proven compatible algorithms/contracts; preserve hashes and domain errors. S76 uses one development formatter. S90 replaces source-count runtime proxies with actual build/runtime measurement; do not minify or manufacture package boundaries merely to meet line counts. S27 removes artificial branch caps/dated exceptions without deleting unmerged user work.

## 5. Complete assignment directory

Each linked PR contains the five requested sections and a full task file. Titles below are navigation labels, not readiness certifications.

| Task | PR | Intended result |
|---|---|---|
| S01 | [#193](https://github.com/UnknownAlienHuman/eliot-research/pull/193) | Repair five package-boundary failures. |
| S02 | [#194](https://github.com/UnknownAlienHuman/eliot-research/pull/194) | Preserve safe primary browser-failure diagnostics. |
| S03 | [#195](https://github.com/UnknownAlienHuman/eliot-research/pull/195) | Repair actual upload/admission/reload acceptance. |
| S04 | [#196](https://github.com/UnknownAlienHuman/eliot-research/pull/196) | Run Project/Wiki mutations on real local D1. |
| S05 | [#197](https://github.com/UnknownAlienHuman/eliot-research/pull/197) | Preserve runs across proven-compatible deployment. |
| S06 | [#198](https://github.com/UnknownAlienHuman/eliot-research/pull/198) | Preserve historical reads after owner JWT renewal. |
| S07 | [#199](https://github.com/UnknownAlienHuman/eliot-research/pull/199) | Accept historical report/Wiki/citations after source update. |
| S08 | [#200](https://github.com/UnknownAlienHuman/eliot-research/pull/200) | Bind query replay to original scope expression. |
| S09 | [#201](https://github.com/UnknownAlienHuman/eliot-research/pull/201) | Wire AI_SEARCH into RETRIEVE_BRANCHES. |
| S10 | [#202](https://github.com/UnknownAlienHuman/eliot-research/pull/202) | Implement common project-scoped service authorization. |
| S11 | [#203](https://github.com/UnknownAlienHuman/eliot-research/pull/203) | Complete machine query/run/status. |
| S12 | [#204](https://github.com/UnknownAlienHuman/eliot-research/pull/204) | Complete machine report/section/exact-evidence reads. |
| S13 | [#205](https://github.com/UnknownAlienHuman/eliot-research/pull/205) | Add thin Research tools to existing MCP. |
| S14 | [#206](https://github.com/UnknownAlienHuman/eliot-research/pull/206) | Expose durable ordinary-run cancellation. |
| S15 | [#207](https://github.com/UnknownAlienHuman/eliot-research/pull/207) | Recover without duplicate completed paid effects. |
| S16 | [#208](https://github.com/UnknownAlienHuman/eliot-research/pull/208) | Fix false DO cancellation and reproduce terminal races. |
| S17 | [#209](https://github.com/UnknownAlienHuman/eliot-research/pull/209) | Preserve primary runtime failure reasons. |
| S18 | [#210](https://github.com/UnknownAlienHuman/eliot-research/pull/210) | Repair existing launch-checker blind spots. |
| S19 | [#211](https://github.com/UnknownAlienHuman/eliot-research/pull/211) | Preserve user intent and run ID on transient disconnect. |
| S20 | [#212](https://github.com/UnknownAlienHuman/eliot-research/pull/212) | Avoid closing reports after unrelated admissions. |
| S21 | [#213](https://github.com/UnknownAlienHuman/eliot-research/pull/213) | Distinguish technical checkpoints from research procedures. |
| S22 | [#214](https://github.com/UnknownAlienHuman/eliot-research/pull/214) | Execute corpus counter-search before evidence freeze. |
| S23 | [#215](https://github.com/UnknownAlienHuman/eliot-research/pull/215) | Distinguish leading-section fallback from relevant retrieval. |
| S24 | [#216](https://github.com/UnknownAlienHuman/eliot-research/pull/216) | Support multiline research input with real envelopes. |
| S25 | [#217](https://github.com/UnknownAlienHuman/eliot-research/pull/217) | Verify Wiki writer/reader Unicode/reference parity. |
| S26 | [#218](https://github.com/UnknownAlienHuman/eliot-research/pull/218) | Make Research question/answer/citation oriented. |
| S27 | [#219](https://github.com/UnknownAlienHuman/eliot-research/pull/219) | Remove artificial branch caps and dated exceptions. |
| S28 | [#220](https://github.com/UnknownAlienHuman/eliot-research/pull/220) | Remove a verified canonical-JSON duplicate safely. |
| S29 | [#221](https://github.com/UnknownAlienHuman/eliot-research/pull/221) | Replace split semantic configuration with one immutable revision. |
| S30 | [#222](https://github.com/UnknownAlienHuman/eliot-research/pull/222) | Reconcile implemented/deployed/partial-live status. |
| S31 | [#223](https://github.com/UnknownAlienHuman/eliot-research/pull/223) | Issue/revoke client grants through owner API and UI. |
| S32 | [#224](https://github.com/UnknownAlienHuman/eliot-research/pull/224) | Connect Stop/Recover to PWA and MCP. |
| S33 | [#225](https://github.com/UnknownAlienHuman/eliot-research/pull/225) | Separate long-run authority from browser/snapshot TTL. |
| S34 | [#226](https://github.com/UnknownAlienHuman/eliot-research/pull/226) | Complete model-proof renewal and credential diagnostics. |
| S35 | [#227](https://github.com/UnknownAlienHuman/eliot-research/pull/227) | Persist inquiry protocol and obligations compatibly. |
| S36 | [#228](https://github.com/UnknownAlienHuman/eliot-research/pull/228) | Persist QuestionGraph, SourcePortfolio, and hypotheses. |
| S37 | [#229](https://github.com/UnknownAlienHuman/eliot-research/pull/229) | Execute and reconcile required research branches. |
| S38 | [#230](https://github.com/UnknownAlienHuman/eliot-research/pull/230) | Bind lanes/preregistration/named-verifier certificates. |
| S39 | [#231](https://github.com/UnknownAlienHuman/eliot-research/pull/231) | Connect authorized acquisition to frozen admitted bytes. |
| S40 | [#232](https://github.com/UnknownAlienHuman/eliot-research/pull/232) | Complete debt/disposition/next-probe/reopen lifecycle. |
| S41 | [#233](https://github.com/UnknownAlienHuman/eliot-research/pull/233) | Complete ASK/BRIEF and grounded follow-up. |
| S42 | [#234](https://github.com/UnknownAlienHuman/eliot-research/pull/234) | Complete dimension/condition/evidence-based COMPARE. |
| S43 | [#235](https://github.com/UnknownAlienHuman/eliot-research/pull/235) | Complete HYPOTHESIS_REVIEW with rivals and falsifiers. |
| S44 | [#236](https://github.com/UnknownAlienHuman/eliot-research/pull/236) | FACT_CHECK all original input claims without substitution. |
| S45 | [#237](https://github.com/UnknownAlienHuman/eliot-research/pull/237) | Complete PROJECT_VS_LITERATURE_AUDIT evidence matrices. |
| S46 | [#238](https://github.com/UnknownAlienHuman/eliot-research/pull/238) | Integrate DEEP_RESEARCH over actual procedures. |
| S47 | [#239](https://github.com/UnknownAlienHuman/eliot-research/pull/239) | Qualify raw-to-normalized admission for supported formats. |
| S48 | [#240](https://github.com/UnknownAlienHuman/eliot-research/pull/240) | Complete coordinate-bound structural navigation. |
| S49 | [#241](https://github.com/UnknownAlienHuman/eliot-research/pull/241) | Complete scope-bound ProjectAtlas and omissions. |
| S50 | [#242](https://github.com/UnknownAlienHuman/eliot-research/pull/242) | Complete LOCATE/literal/structural/semantic retrieval. |
| S51 | [#243](https://github.com/UnknownAlienHuman/eliot-research/pull/243) | Reconcile exhaustive shards and complete denominators. |
| S52 | [#244](https://github.com/UnknownAlienHuman/eliot-research/pull/244) | Complete import-fed projection/readiness/shadow/rollback. |
| S53 | [#245](https://github.com/UnknownAlienHuman/eliot-research/pull/245) | Complete REPORT compiler/COW/verified export. |
| S54 | [#246](https://github.com/UnknownAlienHuman/eliot-research/pull/246) | Complete accepted publication and D0–D3 decisions. |
| S55 | [#247](https://github.com/UnknownAlienHuman/eliot-research/pull/247) | Track derived dependencies/freshness/change replay. |
| S56 | [#248](https://github.com/UnknownAlienHuman/eliot-research/pull/248) | Complete selective EvidenceAtoms and source profiles. |
| S57 | [#249](https://github.com/UnknownAlienHuman/eliot-research/pull/249) | Complete evidence-bound typed ArgumentMap. |
| S58 | [#250](https://github.com/UnknownAlienHuman/eliot-research/pull/250) | Complete Workspace export/capture/conversion/admission. |
| S59 | [#251](https://github.com/UnknownAlienHuman/eliot-research/pull/251) | Deliver artifacts with supported Google readback/reconciliation. |
| S60 | [#252](https://github.com/UnknownAlienHuman/eliot-research/pull/252) | Connect federation operations to actual execution. |
| S61 | [#253](https://github.com/UnknownAlienHuman/eliot-research/pull/253) | Verify federation through an independent wire client. |
| S62 | [#254](https://github.com/UnknownAlienHuman/eliot-research/pull/254) | Complete owner erasure authorization/request/status. |
| S63 | [#255](https://github.com/UnknownAlienHuman/eliot-research/pull/255) | Complete managed erasure closure/holds/late-producer fencing. |
| S64 | [#256](https://github.com/UnknownAlienHuman/eliot-research/pull/256) | Complete outbox/Queue/DLQ recovery. |
| S65 | [#257](https://github.com/UnknownAlienHuman/eliot-research/pull/257) | Connect coherent backup to real source/offsite adapters. |
| S66 | [#258](https://github.com/UnknownAlienHuman/eliot-research/pull/258) | Restore in isolation with current purge before disclosure. |
| S67 | [#259](https://github.com/UnknownAlienHuman/eliot-research/pull/259) | Verify code/index rollback without reverting authority data. |
| S68 | [#260](https://github.com/UnknownAlienHuman/eliot-research/pull/260) | Complete bounded Steward checks and candidate-only feedback. |
| S69 | [#261](https://github.com/UnknownAlienHuman/eliot-research/pull/261) | Verify actual disclosure/injection/XSS/secret boundaries. |
| S70 | [#262](https://github.com/UnknownAlienHuman/eliot-research/pull/262) | Verify ownership/cutover/residency/explicit snapshots. |
| S71 | [#263](https://github.com/UnknownAlienHuman/eliot-research/pull/263) | Complete content-free operational diagnostics and usage visibility. |
| S72 | [#264](https://github.com/UnknownAlienHuman/eliot-research/pull/264) | Complete event replay/backpressure/hibernation. |
| S73 | [#265](https://github.com/UnknownAlienHuman/eliot-research/pull/265) | Complete Library/project/import/revision UX. |
| S74 | [#266](https://github.com/UnknownAlienHuman/eliot-research/pull/266) | Provide truthful model/agent/Workspace Connections. |
| S75 | [#267](https://github.com/UnknownAlienHuman/eliot-research/pull/267) | Complete Wiki/report review/edit/publication/history UX. |
| S76 | [#268](https://github.com/UnknownAlienHuman/eliot-research/pull/268) | Pin a development formatter and improve source readability. |
| S77 | [#269](https://github.com/UnknownAlienHuman/eliot-research/pull/269) | Share Unicode primitives without merging incompatible contracts. |
| S78 | [#270](https://github.com/UnknownAlienHuman/eliot-research/pull/270) | Complete remaining M2 identity parity by family. |
| S79 | [#271](https://github.com/UnknownAlienHuman/eliot-research/pull/271) | Port pure owner lifecycle/cutover decisions. |
| S80 | [#272](https://github.com/UnknownAlienHuman/eliot-research/pull/272) | Port pure scope algebra/currentness. |
| S81 | [#273](https://github.com/UnknownAlienHuman/eliot-research/pull/273) | Port pure policy/disclosure/residency/budget decisions. |
| S82 | [#274](https://github.com/UnknownAlienHuman/eliot-research/pull/274) | Port admission/qualification and expose offline verification. |
| S83 | [#275](https://github.com/UnknownAlienHuman/eliot-research/pull/275) | Port bounded structural projection transforms. |
| S84 | [#276](https://github.com/UnknownAlienHuman/eliot-research/pull/276) | Port exact-evidence and coverage invariants. |
| S85 | [#277](https://github.com/UnknownAlienHuman/eliot-research/pull/277) | Port Research acceptance/reopen/publication decisions. |
| S86 | [#278](https://github.com/UnknownAlienHuman/eliot-research/pull/278) | Port erasure closure and hold decisions. |
| S87 | [#279](https://github.com/UnknownAlienHuman/eliot-research/pull/279) | Port federation fence/candidate/disposition mapping. |
| S88 | [#280](https://github.com/UnknownAlienHuman/eliot-research/pull/280) | Implement actual product Wasm ABI/shadow. |
| S89 | [#281](https://github.com/UnknownAlienHuman/eliot-research/pull/281) | Complete per-family runtime promotion and TS removal. |
| S90 | [#282](https://github.com/UnknownAlienHuman/eliot-research/pull/282) | Replace source proxies with measured build/runtime budgets. |
| S91 | [#283](https://github.com/UnknownAlienHuman/eliot-research/pull/283) | Verify every active authority transaction family on D1. |
| S92 | [#284](https://github.com/UnknownAlienHuman/eliot-research/pull/284) | Run one-build integrated owner/headless local acceptance. |
| S93 | [#285](https://github.com/UnknownAlienHuman/eliot-research/pull/285) | Run adjudicated T2/T3 per-product quality acceptance. |
| S94 | [#286](https://github.com/UnknownAlienHuman/eliot-research/pull/286) | Attest exact private staging build/resources. |
| S95 | [#287](https://github.com/UnknownAlienHuman/eliot-research/pull/287) | Run native T4/T5 and selected-client conformance. |
| S96 | [#288](https://github.com/UnknownAlienHuman/eliot-research/pull/288) | Run T6 workload/overload/performance/cost acceptance. |
| S97 | [#289](https://github.com/UnknownAlienHuman/eliot-research/pull/289) | Complete mandatory release evidence and canary acceptance. |
| S98 | [#290](https://github.com/UnknownAlienHuman/eliot-research/pull/290) | Complete machine ingestion and append-only project attachment. |
| S99 | [#291](https://github.com/UnknownAlienHuman/eliot-research/pull/291) | Use full authorized Research scope and compatible historical reads. |

## 6. Consolidated audit coverage: F01–F26

Source: uploaded `eliot-research-consolidated-audit-2026-09-14.md`, SHA-256 `9460d84cb0da21a6ab4553dc573e79652c532da749532fbb1db9176f5359fad5`. The local uploaded bytes and finding headings were rechecked on 2026-09-15. This source is not assumed to exist inside the repository.

| Finding | Subject | Assigned implementation/acceptance |
|---|---|---|
| F01 | Deployment identity blocks historical execution | S05/S67 |
| F02 | JWT rotation differs from a change of owner | S06/S33 |
| F03 | Historical-read fix lacks complete acceptance | S07/S92/S95 |
| F04 | AI Search binding lost inside Workflow | S09 |
| F05 | Replay ignores new scope expression | S08 |
| F06 | Technical stages replace required procedures | S21/S22/S35–S46 |
| F07 | Leading fallback and coverage semantics | S23/S50–S52/S93 |
| F08 | Research input/scope restrictions | S24/S99 |
| F09 | PWA/HTTP parity does not imply service authority | S10–S13/S31/S32/S58/S60/S61/S98 |
| F10 | Incomplete public run lifecycle | S14/S15/S32 |
| F11 | Uniform zero retries prevent safe recovery | S15/S64/S95 |
| F12 | False cancellation and possible terminal race | S16/S72 |
| F13 | Primary failure reasons are lost | S02/S17/S71 |
| F14 | node:sqlite does not establish D1 compatibility | S04/S91 |
| F15 | SQL/TS predicates differ; actual writer reachability matters | S25/S77/S91 |
| F16 | SQL complexity without permission to remove atomic guards | S04/S91 and relevant pure decision ports |
| F17 | Transient disconnect clears user intent | S19/S72 |
| F18 | Unrelated admission resets a report | S20/S55 |
| F19 | Console-oriented interface | S26/S73–S75 |
| F20 | No complete green main acceptance | S01–S04/S76/S90–S92 |
| F21 | Launch-checker blind spots | S18/S94/S97 |
| F22 | Registry/deployment/partial-live statuses are conflated | S30/S97 |
| F23 | Canonical serialization/text duplication | S28/S77/S78/S89 |
| F24 | Long lines and misleading source budgets | S76/S90 |
| F25 | Configuration/route-proof operational complexity | S29/S34/S71/S95 |
| F26 | Rust migration not connected to product runtime | S78–S89 and existing mutation work #176 |

Every listed finding has assigned work, but none becomes FIXED merely from this map. F12's race and F15's ordinary-writer exploit are not promoted from static risk to reproduced incidents. Applicable tasks must establish actual reachability and failure before claiming a fix. A single finding can span several implementations; an aggregate acceptance card does not fill an unspecified implementation gap automatically.

## 7. Claude/Antigravity reconciliation

Source: uploaded `audit-2026-09-14.md`, SHA-256 `230bd4c9cb762cf044db1c0ef7ced49b07837fec71f1e95ce557b337374e72e6`; local bytes rechecked 2026-09-15. [Repository audit copy](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/audit-2026-09-14.md). The source audit is retained, not silently rewritten to match this plan.

| Audit group | Treatment |
|---|---|
| AUTH-01/02/03 | S05/S06/S33/S34 separate current request identity, owner authority, deployment, scope TTL, and model proof. A new JWT by itself does not delete a SQL row. |
| D1-TEST/LIMIT-01 and D1-AUTH-01/02 | S04/S25/S91 use actual workerd-D1 and supported-writer tests. node:sqlite is not the local D1 runtime. Predicate differences alone do not prove ordinary HTTP exploitation. |
| CI-01/GATE-01 | S01–S04/S18/S90–S97 address actual checks and observed outcomes, not another gate framework. |
| DUP-01/OVR-05/RT-01 | S28/S76–S78/S89/S90 distinguish equivalent algorithms from different byte contracts and source bytes from shipped artifacts. |
| RT-02/CONF-DR/AI-03 | S29/S34/S71 target configuration/proof lifecycle and observed overhead. Adapter LOC is not sufficient evidence for deletion. |
| PIPE-DO-01/PIPE-CFG-01 | S16/S72/S94 check actual callers, races, and bindings. A nonatomic reread alone is not a race fix. |
| FRONT-UI/03/04/05 | S26/S73–S75/S92 add user flows while preserving security negatives. Unused legacy routes do not imply the selected profile must enable them. |
| OVR-04 | Bounded fixes with regression and main integration; no new quota, registry, or endless rewrite cycle. |
| CONF-03 | S78–S89 implement the adopted language contract through actual runtime promotion, not language percentage. |
| CONF-04 | S30/S97 check behavior and evidence, not just file presence. |
| OVR-01 and broad codec/error/LOC counts | Do not infer safe deletions from grep counts. Inspect actual definitions, consumers, and semantic duplication. |

Do not implement refuted recommendations: Budget Governor and AI Search generation registry are canon-required; separate model-qualification layers are not automatically duplicate engines; sampled coverage cannot prove complete absence; W2 run and W3 model IDs correctly differ; absence of tests inside a package folder does not prove no coverage; historical SQLITE_NOMEM is not automatically the current CI cause. SQL atomic guards are explicitly covered by the language contract. Missing secrets in Git do not establish missing deployment secrets. The owner's main-only workflow and permitted workers.dev hosting are not defects. There is no supported mandate to delete 35–40 thousand lines from the audit's withdrawn estimate.

## 8. Mandatory-product coverage beyond defect repair

| Requirement | Main task groups | Required observable outcome |
|---|---|---|
| Foundation, authority, single Worker | S01/S05/S10/S27/S33/S69/S70/S90/S94 | Correct current actor/ownership/bindings and actual build identity. |
| Ingestion, qualification, residency | S39/S47/S70/S82/S98 | Admitted exact revisions and outbox; candidates/partial data never silently enter context. |
| Retrieval, exact evidence, exhaustive coverage | S08/S09/S23/S48/S50–S52/S84/S99 | Authorized requested scope, actual serving generation, exact bytes, honest denominator. |
| Corpus Lens/Atlas | S36/S48/S49/S56/S57/S73 | Usable navigation, qualified maps, explicit omissions. |
| Governed Research products | S21/S22/S35–S46/S53/S85 | Required protocol/obligation/lane/verifier/freeze/debt/disposition behavior. |
| Artifact/Wiki/distillation | S07/S25/S53–S57/S75 | COW revisions, correct risk-tier review and exact support/dependencies. |
| HTTP/MCP/federation | S10–S15/S31/S32/S60/S61/S72/S98 | Actually connectable scoped clients, not owner-cookie or manual-SQL fixtures. |
| Selected Workspace | S58/S59/S74 | Supported actual external action, transferred bytes, and independently observed readback. |
| Model/budget lifecycle | S15/S29/S33/S34/S71/S81 | Lawful renewal/spend/UNKNOWN handling, no duplicate completed effects. |
| Security/privacy | S10/S25/S69/S70/S81/S95 | Verified denials, no authority from source prose, no secret/XSS disclosure. |
| Queue/DO/Workflow failures | S14–S17/S32/S64/S72/S95 | Durable replay/cancel/recovery with bounded buffering and pressure. |
| Erasure, backup, restore, exit, rollback | S55/S62–S67/S86/S95 | Full managed closure and purge-first restore on approved targets. |
| Steward and diagnostics | S17/S68/S71/S74 | Content-free actionable findings and candidate-only semantic changes. |
| Rust M1–M7/native verifier | S78–S89, preserved K1/K2a/#176 | Real ABI/caller promotion/removal, not CI-only code. |
| Combined UX, quality, performance | S26/S73–S76/S90/S92–S96 | Integrated local loops, independent corpus, native receipts, measured workload. |
| Release acceptance | S30/S97 | Consistent existing status and exact approved canary/release evidence. |

This is a coverage map of intended work, not a claim that every normative clause has already been dynamically tested or that no finer-grained implementation task can emerge.

## 9. Execution discipline without architectural guesswork

Read this index, the task's five sections, the referenced canonical section, and actual callers on current main. The pinned baseline identifies inspected code; it is not an instruction to revert later fixes. Reuse completed admission, backup, identity, and storage components; implement the missing delta.

For a focused change: reproduce the named failure→change the existing path→run positive/negative/replay tests at the real boundary→read back state/bytes/IDs→record exact commit/results. Shared schema/API changes require checking consumers and upgrade behavior together. Do not equate helper success, compilation, file creation, or Markdown merge with user-visible completion.

Before beginning a multi-family or underspecified implementation checkpoint, make its concrete input/output, caller, migration, and test target explicit in the same existing assignment. This is still engineering work: the queue is not certified as a no-reasoning autopilot script. Preserve the agreed architecture instead of silently choosing a new store, authentication system, scheduler, or publishing engine.

After two failed approaches to the same issue, record the exact failure and observed state, identify the first cause, and choose a different testable strategy. Do not continue unchanged retries or hide failures through looser assertions. New demonstrated defects return to their owning assignment; they do not justify unlimited expansion into optional products.

## 10. External inputs and actual completion

Local code and tests must not depend on invented secrets or live receipts. Actual deployment/qualification needs approved account/resource identities, isolated disposable targets, real Access/model credentials, a budget, authorized selected Google actions, an approved independent offsite destination, and applicable independent federation access. Only the affected live case waits for such an input; unrelated local work continues. Provider limitations or ambiguous creation outcomes remain explicit rather than being declared fixed by fictional idempotency.

Release-owner approval follows the observed canary window. An agent cannot invent approval, delete uncontrolled downloaded copies, or report a future monthly bill as already measured.

**Current result of this review:** the assignments have been translated and their known coverage/cross-task issues documented or corrected. The local audit files and finding headings were checked. The application implementation, complete test suite, actual Cloudflare/client execution, and release canary were not performed as part of this documentation change. Therefore neither all tasks' effortless execution nor product readiness has been proven.

**Completion condition:** implemented mandatory selected-profile behavior in one integrated main, actual fixes for confirmed findings, demonstrated language/data/security/runtime guarantees, and applicable T0–T6 plus canary acceptance under S97. Readiness applies to the accepted version/profile/tested operating envelope; it is not an absolute guarantee against every future defect.
