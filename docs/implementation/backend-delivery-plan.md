# Backend delivery plan

Current execution order, reconciled on 2026-09-25 against `main` at
`12321f7721d6d59a75f0d5dd01ebcb569ca46ae0` and audit PR [#303](https://github.com/UnknownAlienHuman/eliot-research/pull/303).
Refresh main and the linked tasks before claiming a checkpoint; this is not a permanent status census.
The [independent audit review](audit-2026-09-25-review.md) separates reproduced defects, source review and unverified claims.

## One queue, two completion boundaries

This file owns execution order. [#292](https://github.com/UnknownAlienHuman/eliot-research/pull/292)
links the original S01–S99 requirement passports, not a competing implementation queue. Issues #293–#305
refine defects in those tasks; #303 is the audit PR, not an implementation assignment.
Do not restart S01 or rewrite a delivered subsystem merely because its planning PR remains open.

The owner's current phase is **finish product code first**. Perform compilation, scoped lint and,
for SQL changes, the D1-limit-aware compiler check in #294. Do not manually run broad behavioral,
browser, mutation, quality or live suites before assembly. Minimal Clippy applies to Rust edits.
This phase overrides the test-first/full-suite-before-every-push defaults in older process documents.
It does not waive correctness, permit weakened guards or turn deferred acceptance into PASS.

Record separately: **code delivered at SHA**, **known code defects**, and **acceptance pending**.
Keep full criteria on the task and leave final acceptance open. No unspecified local agent is assumed
to have run anything. Once assembled, execute the existing final gates and retain their real results.

## Immediate code-repair order

1. **#293 code/compiler checkpoint delivered: migration 0084 and grant/control repairs.**
   The existing depth-100 compiler now accepts all 325 schema shapes, including the previous 19
   failures. Source-derived EXPLAIN also accepts 711 prepared-query shapes, including declared
   query/run/artifact grant variants and the actual Stop/Recover writers. No guard, expiry, purge,
   receipt or CAS requirement was waived. Grant storage failures retain their internal cause and
   exact lost-ACK readback rather than defaulting to 403. See #293 for exact commit/results and
   [the D1 repair notes](../../infra/d1/README.md). Native behavioral acceptance remains pending;
   #294's remaining dynamic-query coverage is not claimed complete. Do not repeat this repair or
   rebuild the installed compiler.
2. **#296 code/static checkpoint delivered: full ESLint is clean.** Script globals are declared only
   in the existing Node environment; no lint rule or path was suppressed. Qualification cleanup retains
   the primary failure and secondary cleanup causes, including an undefined rejection. Wiki storage
   causes are preserved internally; replay/readback branches remain intact. Full TypeScript compilation
   passes. Fault-injection and replay acceptance remain pending in #296, not silently marked PASS.
   For #297, inspect existing failure logs now and repair confirmed production defects in their owning
   modules; the33 reported failures are not automatically33 production bugs. Fixture expansion stays later.
3. **NEXT: #295 + #304, coordinated with S90/#282: repair verification wiring.** Keep budget failures visible
   without suppressing independent checks. Cover all root Vitest files; the existing CI filters omit27.
   Separate source-maintainability metrics from emitted artifacts. Do not raise limits or shuffle files
   merely to obtain green; full-suite execution is still the later assembly phase.
4. **#299 + S37/#229: reconcile retained S37 source before cleanup or reimplementation.** Verify the
   original payload hash, compare every hunk with current main, preserve useful work and integrate only
   reviewed missing code. Do not execute the old publisher or delete the payload as assumed garbage.
5. **#300/#301 and PR#303: finish bounded documentation/privacy reconciliation alongside code.**
   Preserve full task contracts and one queue; do not spend the implementation phase generating99 new
   tickets, building a tracker framework or mass-closing/deleting planning branches. #302 operator/domain
   changes require separate explicit authorization and do not block writing application code.

## Continue product code in dependency order

| Order | Existing tasks | Concrete next result |
| --- | --- | --- |
| A | S29/#221, S34/#226; residual S10–S15, S31–S33, S98–S99 | Complete remaining selected-profile configuration/qualification and machine-path contract items. Reuse the delivered grants, controls, normalized importer and readers; do not reimplement them. Broader discovery or non-exploratory execution is only claimed when its actual caller is composed. |
| B | S21–S23, S37–S46 | Truthful procedure reporting; real branch factory; protocol execution, W1 observations, freeze/debt/supersession, verifiers and product handlers. Reuse S35/S36 contracts and the S37 salvage disposition. One shared checkpointed executor, not an engine per role. |
| C | S47–S61 | Complete source/navigation/index boundaries, requested coverage, artifacts/publication, selected Workspace capture/readback and federation. Prioritize dependency-ready S50–S52 (RETRIEVAL) and S58/S59 (Workspace candidate admission), without bypassing their authority prerequisites. |
| D | S62–S72 | Erasure closure, outbox/DLQ/reconciliation, backup/isolated restore, rollback, Steward and durable events. S62/S63 address ERASURE. Write code without inventing live credentials or treating unavailable live receipts as coding blockers. |
| E | S20/#212, S73–S77; #298 | Targeted source-change invalidation, complete human Library/Connections/artifact flows and proven-equivalent formatting/reuse. Inspect/fix the Windows layout code independently; its browser proof waits for #305. UI work may advance with its actual backend dependency, not after every Rust family. |
| F | S78–S89, #106/#176 | Stabilize canonical consumers; implement deterministic Rust families; make the first real versioned Wasm call as soon as one family is ready; promote callers and remove superseded TS authority family by family. Managed Cloudflare I/O stays TypeScript. |
| G | S18/#210, S30/#222, S90/#282, S91/#283 | Reconcile actual composed code, truthful implementation states, emitted artifacts and D1 mutation boundaries. Compiler/guard fixes land with their owner changes; do not postpone known broken SQL to this final reconciliation. |

S01–S06, S08/S09, S14/S16, S24–S28 and S35/S36 were historically closed. Preserve their code and
receipts, but link current regressions rather than assuming historical acceptance proves current main.
S03/S04/S08 regression repair belongs to #293; S26 layout/fixture consequences belong to #298/#305.
S07's historical-read obligations remain in #199; preserve its exact-version/citation acceptance.
The original passports remain the source of all mandatory criteria, including tasks with partial code.

## Delivered code that must not be scheduled from scratch

These are checkpoint references, **not proof of current runtime correctness or complete acceptance**.

| Capability | Current lineage |
| --- | --- |
| Project/client grants and Connections | `dd77b311`, `6f904052`; #202/#223. |
| HTTP/MCP query, report/evidence, status and controls | `da18c864`, `cb23b55d`, `db848b33`, `53f9efc1`, `9a1d3275`, `debb53cb`; #203–#205/#224. |
| Machine admission, machine controls, historical/owner reads and PWA controls | `b66298ee`, `3df3db06`, `ab16f5d1`, `6dee770b`, `b3620e10`; exact original grants/execution deadlines remain distinct from current read authority. |
| Server execution lifetime and larger recorded scope | `0a480772`, `e09e9ef4`; #225/#291. Existing member/byte ceilings remain, not universal capacity guarantees. |
| Append-only attachment and normalized machine ingestion | `a99e18a6`, `82766f3e`; #290. Raw conversion is separate S58 work, not permission to duplicate the importer. |
| First runtime cause and transient reconnect intent | `eee6f976`, `12321f77`; #209/#211. #293 still owns grant-write error mapping; #305 owns stale browser fixtures. |

The earlier detailed checkpoint ledger remains in the [pre-review plan](https://github.com/UnknownAlienHuman/eliot-research/blob/12321f7721d6d59a75f0d5dd01ebcb569ca46ae0/docs/implementation/backend-delivery-plan.md)
and task histories. Its old “next” and owner-only statements are not the current queue.
The checked migration chain now includes0084. Allocate the next number from refreshed main. The SQL
repair is source/compiler-complete for the reviewed shapes, not native or deployment acceptance. No
remote migration was applied; deployment still requires the later assembled-product gates.

## After code assembly: acceptance, not another implementation loop

Reconcile #297 fixtures versus production fixes and #305 session-aware browser fixtures, then accept
#298 viewport behavior independently. Execute **S92/#284 local integrated acceptance before S94/#286
staging**. On the attested staged build, complete S93/#285 corpus quality, S95/#287 native/security/
restore/client conformance and S96/#288 workload/cost, then S97/#289 release acceptance. Resolved local
fixture failures do not establish native D1/R2 behavior or model quality. Keep exact build/config identities.

Only selected mandatory v1/Slices0–6 and `gemini-mcp` are baseline obligations. Unselected managed
OAuth, Slice7 or another client's local runtime are not added as release blockers. Live deployment,
provider spending, external restore destinations and hostname changes require their own authorization.

## Legacy records and publication

Launch01/#98 maps to S03/S47/S70/S73/S98; Launch02/#90 to S08/S09/S23/S48/S50–S52/S99;
Launch03/#91 to S48/S49; Launch04/#92 to S05–S17/S21–S22/S31–S46/S72;
Launch05/#93 to S60/S61; Launch06/#94 to S07/S53–S57/S75; Launch07/#95 to S10–S13/S31/S58/S59/S74;
Launch08/#96 to S62–S72/S91–S97. These are traceability umbrellas, not duplicate work queues.
#106 is concrete Rust debt under #176; retain its unresolved obligations. Salvage #121/#173/#174
remain protected until their unique code has an explicit disposition. Mapping is not completion.

Work only on main, one claimed checkpoint at a time, without worktrees or new task branches.
Use normal authenticated Git or authorized GitHub blob/tree/commit/non-forced ref actions. Refresh
main before publication and reconcile concurrent changes. Reference actual task numbers in commits.
Do not create writable transport workflows for routine publication. No branch deletion or history rewrite
is authorized by this plan; original passports and evidence must remain reachable.
