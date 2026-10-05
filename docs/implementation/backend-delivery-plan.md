# Backend delivery plan

Current execution order, refreshed on 2026-10-05 against `main`
`691c067134d1e1928229ac201aafb14e55e6297b`.

The [October 3 functional integration checkpoint](product-resume-2026-10-03.md)
records the owner configuration, immutable run capture, MCP, provisioning and
remaining real deployment/evidence checks. Assembly is in progress; no full
release or live Research acceptance is claimed. The owner-directed phase is full
product-code assembly before release and acceptance. Provider calls must remain
free. Functional and same-document acceptance follow the assembled release;
cognitive and quality evaluations are deferred by the owner. Compilation and an
existing provider receipt do not establish that acceptance.

The current assembly covers catalog-based model configuration and native BYOK
transport, durable owner/delegated policy parity, the existing AI Search evidence
path, useful bounded MCP reads and results, and the adaptive owner workspace.
The observed Research failure at RECONCILE is under diagnosis. Native MCP client
authorization remains unverified. These are open items, not completed acceptance.

The published baseline assembles native-model and capability libraries. Model
Control, Model Execution, Model Transport,
Research Branches, Research Runtime, Research Configuration, Computer Agent,
Wiki, Erasure Operations, Search Probe and browser Research Workspace now have
explicit library boundaries. They share the existing Worker/PWA deployments;
they are not new services. The workspace manifest/import audit and finite
package-boundary scan passed during assembly. Those results do not establish
its runtime behavior.

The current capability assembly keeps verified Access context creation, Worker
bindings, request liveness and HTTP response adaptation in Core. Existing
libraries now own persisted owner/project authorization, native-model use,
immutable run capture, session application operations, exact artifact evidence
and source-membership reads. A small HTTP Protocol library owns strict input
parsing and the shared request-error constructor. These libraries compile into
the existing Worker; they create no additional deployable services.
Compatibility adapters retain existing callers and canonical error identity.
Duplicate semantic-stage preparation was removed from Core so the Runtime
assembler performs it once.

The follow-up assembly removes 60 pure Core compatibility facades and redirects
their callers, including compiled-module test/operator loaders, to the existing
capability libraries. Google Exchange now owns strict OAuth transport parsing;
Workspace MCP owns diagnostic consumption, tool-operation preparation and durable
project-membership checks; Research Runtime owns the admitted Workflow application;
Cloudflare AI composes the projection delivery handler. Core retains verified
identity creation, actual Worker binding composition, artifact reauthorization,
request liveness and post-operation authority checks. Stored protocols, SQL,
error identity and execution order are preserved by source review; behavioral
regressions remain pending after the assembled checkpoint.

Configuration status now uses the canonical semantic schema, including roles
and max-effort fields. This repairs rejection by the old duplicated validator;
it is a behavior change. Positive, boundary-size and refusal regressions were
added as source, but have not been executed in the assembly phase.

Owner key use is composed through a durable operation/stage record
(migration 0110), provider-native preparation, one-shot connectivity observation,
candidate/proof/revocation records (0111), whole-project selection CAS and native
Run/COW resolution. Connectivity probes have a separate fixed server-owned
prompt, schema, parameters and deployment tuple. They must not claim execution
of the installed Research stage prompt or qualification of project answers.
Raw request/response bytes and their recomputed digests remain distinct from
corpus EvidenceHandles and residency objects. OpenRouter requests enforce zero
maximum prices and disabled provider fallback; a zero-price quote is not a
measured provider invoice or a permanent entitlement to a free model.

The guarded deployment accepts an explicit absolute `--secrets-file` path for
Wrangler's native secret upload in the final Worker deployment. Its bounded
UTF-8 JSON may contain only the string `ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN`;
the file is pinned and checked again before upload. The option does not feed
the token into generated vars, dry runs, logs or deployment receipts, and
does not change existing deployment arguments when omitted. Actual token
installation and provider-key readback remain pending.

The new, unapplied observation tables use explicitly named canonical Base64
TEXT columns for the bounded raw bodies. Readers decode them losslessly and
verify the actual decoded byte lengths and digests. This storage representation
keeps the existing portable backup protocol usable without misdeclaring binary
values as text. Backup classification and explicit column specs cover the
complete 0109-0111 operation/preparation/attempt/observation/candidate/proof/
revocation chain, including uncertain attempts and revoked proofs.
Only those ten tables receive an explicit introduction-migration map, so verified
older v1 epochs can retain their original table/vector shape while newer cuts
must include their full chain. This does not complete O3 restore: historical
imports still need its isolated authority establishment because insertion guards
require current owner/operation/pricing state. Those guards must not be bypassed
or satisfied with invented owner/selection records.

The integrated Core/PWA TypeScript build passed on Node 24.19.0 after interface,
import and exact-optional repairs. Scoped ESLint covered 152 changed source and
tooling files with zero errors, warnings or source drift. The manifest/import
audit covered 42 packages with no cycles or errors; finite package boundaries
passed. The depth-100 SQL
compiler passed on SQLite 3.50.4 including 0110/0111: 110 Core migrations and
971 recovered application SQL sites, with zero failures. Its 121 dynamic or
unresolved sites remain separately reported. Initial failed check outputs are
preserved; wrong column access, missing composite uniqueness, premature proof
binding and oversized preparation/proof guards were repaired without changing
the table columns. The ten backup column specs match the new tables.

The follow-up Core/PWA TypeScript build passed after callback/narrowing repairs.
The source-budget scan now passes: Core is 9,997 physical lines and 507,511 raw
bytes across 134 source files. Every counted file is at most 600 lines and every
package at most 10,000 lines; Worker/PWA raw-source ceilings also pass. The
follow-up dependency audit, finite boundaries, synchronized work packets and
43-contour registry passed; no contour was promoted to LIVE_QUALIFIED. The SQL
compiler again reports 971 recovered sites, zero failures and 121 dynamic or
unresolved sites. Final scoped ESLint covered 110 changed source/tooling files
with zero errors, warnings or source drift. Behavioral checks remain pending.
No emitted-size improvement is claimed. Publication uses
the captured file manifest and non-forced main push; no deployment or model call
was made for this checkpoint.
The first bounded functional pass covered 66 PWA cases, 13 provider/transport
cases and 44 deployment-verification/ordering groups. Core initially reported
126 passing cases, three failures and one TODO. The two transport failures were
invalid legacy fixtures; corrected tests preserve strict native endpoint and
credential-route refusal. The failure-retention regression exposed a real D1
contract mismatch: migration 0083's shape triggers did not admit 31 newer
canonical error codes. Forward migration 0112 aligns the three allowlists with
all 72 runtime codes without changing their other guards or historical 0083.
Its depth-100 SQL compilation and actual-D1 round-trip/refusal regression passed,
as did the original typed-diagnosis retention regression. The SQL compiler now
includes 111 Core migrations, with 971 recovered sites, zero failures and 121
dynamic/unresolved sites.

The isolated key fixture now applies its own migrations. Six key-configuration
cases passed, including replacement under a new operation with a distinct
immutable alias, preservation of the old binding, exact replay and changed-key
conflict. Two project-membership cases passed, including exact scope id/revision
and owner/project/authority refusals. The module loader now resolves the declared
extensionless projection export to compiled JavaScript; this fixes the first
Core test startup failure. The model selector retains its qualification-required
reason. Compilation and source budgets passed after these repairs. The positive
model-use test also exposed a deterministic pricing-authority mismatch: its
strict operation-key set omitted two fields returned by the canonical store.
The complete canonical row is now accepted, while unknown keys remain refused;
that focused regression passed. The resulting pre-price refusal could not be
persisted because the stage table required a pricing receipt even for BLOCKED.
Forward migration 0113 changes only that price-presence constraint, retaining
the strict table, row-copy checks and nine dependent triggers. The compiler now
includes 112 Core migrations with the same zero-failure application SQL result.
The populated-migration regression exposed SQLite's deferred foreign-key counter
after the checked parent-table copy/drop/rename. Migration 0113 now checks the
complete database with `pragma_foreign_key_check` through a strict transaction
guard before turning deferred checking off. A genuine orphan fails that guard
and rolls back; valid populated Native children and all nine dependent triggers
survive. The same-engine microprobe and those actual-D1 assertions passed. The
scoped deploy classifier still refuses 0113's table copy, deferred foreign keys
and rename under its existing schema-only profile. Live migration admission
requires a narrowly reviewed data-preserving rebuild and its cost review; no
live migration intent or apply is claimed.

Native preparation expiry is now bounded by the approved pricing expiry, so a
later preparation timestamp cannot outlive the owner operation's price fence.
The blank-project fixture compiles a complete V2 profile/spend/report baseline,
matching the prepared server configuration. Its next bounded run reached native
qualification but exposed a pre-dispatch validator mismatch: the exact
OpenRouter model was checked against a generated Dynamic Route model name.
The transport repair separates exact native-model validation from the unchanged
Dynamic Route target check, sharing strict body and parameter validation. A
private qualification mode admits the fixed single user message; Research
requests retain their leading-system and message-count guards. Stored observation
hydration now projects the original execution fields explicitly and recomputes
the probe, request and response digests before comparing canonical stored
metadata. The next actual-D1 run persisted an OBSERVED attempt, then exposed an
impossible proof guard: it required candidate references on that OBSERVED
attempt although the attempt constraint keeps those references null until
completion. Forward migration 0114 aligns only that proof-attempt join with the
existing operation/preparation/observation lineage; all remaining proof guards
and the final completion update stay in place. Independent complete-trigger
comparison found no other material delta. With all current migrations on an
empty local D1, all three model-use cases passed: authorized/refused reads, blank
project qualification/import/selection, immutable snapshot capture and replay
without another model effect. The final depth-100 compiler includes 113 Core
migrations with zero failures. No real Cloudflare credential, model response or
selected native run is established by these local fakes.

The populated regression then resumed its durable OBSERVED stage without a
second call for that stage, completed both proofs, and refused a duplicate proof.
A fresh operation after Native selection exposed a second key-use defect: the
new route version was sought only in the original installed policy list. The
builder now takes an exact stage/route policy from the authority-validated saved
Native selection and rebinds only its immutable BYOK alias. Non-Native and blank
configurations retain the installed-policy lookup. Independent source review
found the exact Bunny/free-only policy, current semantic and owner/key authority
checks preserved. The bounded test reached replacement selection revision 2,
preserved the old run pins, and captured the new alias for a later run. Its replay
assertion compares the durable data rather than trace metadata. The decoder now
allows missing pricing only for PENDING and BLOCKED, exactly matching migration
0113; independent SQL/source parity review passed. The populated migration,
genuine-orphan rollback, resumed observations, duplicate-proof refusal and
unpriced BLOCKED scenario passed on actual local D1. The two-key positive case
also passed, including replay counts and exact zero-price/no-fallback request
bodies. That case has a local 15-second timeout for its two complete operations;
the former five-second default was shorter than its observed runtime. The two
read-authorization cases passed in the preceding bounded run. No broad suite
was repeated. The final source TypeScript build passed; scoped lint covered 17
changed source/tooling files with zero errors, warnings or source drift.

The PWA and Worker builds passed. All built PWA JavaScript totals 225,678 gzip
bytes, a conservative superset below the 600 KiB initial-JavaScript ceiling;
the latest local Worker dry run reports 901.79 KiB gzip. These are build observations,
not production startup/CPU measurements. Live functional runs and same-document
NotebookLM checks remain pending. The existing live README version was read and
downloaded on October 5; its authoritative SHA-256 and the downloaded bytes match
the working README (12,688 bytes). This establishes a shared-document baseline,
not a completed NotebookLM comparison or acceptance of the new release.
Cognitive and quality evaluation remain deferred.

Browser verification is currently blocked by the computer-use tool runtime.
After the successful original-file download, the kernel failed to initialize
with a missing-path error while writing its assets. Three documented approaches,
including a session reset, did not restore it. The named plugin/runtime and
temporary directories exist; the missing internal path remains unknown. No
NotebookLM upload or subsequent browser result is claimed from this state.

The adaptive reading panels and system/light/dark theme are published in
`310628db`. The portable backup table catalog now belongs to Contracts; its
contents and order are preserved, and Contracts/O2 compilation and scoped lint
passed at that earlier relocation checkpoint. The schema-registry test is now
split with its existing coverage preserved; the source-budget failure was closed
by the capability assembly above.
No behavioral or live acceptance was run for the relocation.

The current external-model requirement is OpenRouter
`stealth/space-bunny-alpha` at `https://openrouter.ai/api/v1`, through the native
Cloudflare provider endpoint, with owner settings for key replacement. The key
settings packet creates a non-default, immutable BYOK alias through Cloudflare's
provider-config API and reads its metadata back. Access, project ownership, CSRF
defense, account/gateway binding, idempotency and uncertain-effect handling apply
before it can report configuration. It never returns or persists the provider
key. Existing aliases remain available to pinned runs. Configuration does not
establish qualification or selection.

The server management port requires the dedicated Worker secret
`ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN`. Cloudflare documents Secrets Store Write
for provider-config creation; its account scope is broader than a single
gateway. The GET permission is not explicitly enumerated in the API reference,
so successful metadata preflight is required before sending a key. No management
credential or provider key has been installed for this packet. The documented
native OpenRouter path and response decoder are implemented; a real request has
not verified them.

The owner check/select action now creates separate provider-native candidates
and connectivity proofs and uses their immutable resolver through project CAS,
readiness, run capture, per-stage spend admission, model execution and COW.
Captured owner/project bindings and the completed 0110 operation are required
for run/COW resolution. Native profile and audit reads use these exact saved
pins; stage-specific zero-price quote ports accompany them. Marker-omitted
Dynamic Route selections retain their existing path. The old Dynamic Route
qualifier continues to reject native transport policies before effects.
Snapshot-v2 may retain the initial immutable price/proof past calendar expiry;
current key/revocation checks and physical zero-price/no-fallback enforcement
remain required on execution. Real operation, replay and refusal acceptance is
pending.

Assembly also relocates ingest services into Raw Ingest, AI Search control and
generation code into Projection, exact reference manifests into Evidence,
run-configuration storage/status into Workflows, and COW product materialization
into Artifacts. Browser HTTP and Source libraries follow ADR-0015. Compatibility
exports preserve existing callers; these remain libraries in the same Worker
and static PWA deployment. Source budgets and the remaining larger capability
cuts remain open. This relocation does not prove smaller emitted bundles.

At the published `760c26b` baseline, the D1 depth-100 compiler passed against SQLite 3.50.4,
including migration 0109: 941 recovered application SQL sites compiled across
the matching schemas, with 119 dynamic or unresolved sites reported separately.
The first combined Core/PWA TypeScript build found integration typing and test
location/import issues; the assigned owners repaired those exact issues. The
final ordered Core/PWA build passed on Node 24.19.0, and scoped ESLint passed
for all 158 changed source files. The package-boundary scan also passed after
removing destination self-imports and distinguishing generated PWA type output
from source. Acceptance suites, release builds, native client
authorization, live model calls and the same-document NotebookLM comparison
remain pending. The historical RECONCILE failure cause remains unresolved.

The [product integration checkpoint](product-resume-2026-10-02.md) records actual local COW/publication/restore checks and remaining code separately from live approval. The active result remains S92 integration, not release acceptance.

This is the volatile handoff and queue. Refresh `origin/main` and the active task before editing. [PR #292](https://github.com/UnknownAlienHuman/eliot-research/pull/292) preserves the original S01–S99 passports and negative acceptance criteria; it is not a second queue.

## Completion boundaries

Keep these states separate:

1. **code delivered at an exact SHA**;
2. **known residual code**;
3. **acceptance pending**;
4. **live qualified**.

The current phase is product code first: compilation, scoped lint, the depth-100 SQL compiler when relevant, and minimal Clippy for Rust changes. Broad behavioral/browser/native/mutation/live suites follow assembly. Deferred checks remain mandatory and must not be labelled `PASS`.

## Current active checkpoint — S92 local integration

92.1 is delivered (`8db894c6`): six browser-harness scenarios in
`tests/integration/browser/s92-intake.mjs` — owner identity (RS256),
local config readiness, project admission, read-policy grant, model D1
fail-closed, Library/Lens exact readback — registered as real `node:test`
assertions in `tests/integration/browser/library.spec.ts`. Honest states:
5 PASS + 1 PENDING_OWNER_D1B in the original checkpoint (live-model
execution was deferred). Scenario code uses the existing harness (`scripts/lib/local-*.mjs`,
`owner-e2e.mjs`) against in-memory SQLite seeded with the real migration
DDL; no new browser framework.

92.2-92.6 (delegation, products, continuity, COW, negatives) are delivered
in `e5c8ec47`; registration and the [local runbook / INPUT draft](../s92/README.md)
are delivered in `9c1e4788`. Reuse the six `s92-*.mjs` modules and their
`library.spec.ts` registrations; do not start a second harness. Delivery
of these scenarios does not establish their full acceptance: the runner
explicitly permits `BLOCKED`, `NOT_EXECUTED` and `PENDING_OWNER_D1B` outcomes.
The standalone `CloudflareArtifactCowAdapter` now implements section revision over
immutable D1/R2 DRAFT artifacts in `packages/cloudflare-artifacts/src/artifact-cow.ts`.
It validates the exact parent/spec/freeze/evidence boundary, reuses unchanged section object keys,
and commits a new revision with compare-and-swap. Five unit cases and a real local Workerd D1/R2
case verify immutable reuse, refusals and a concurrent one-winner commit.
This is a local engineering follow-up to merged main `6480186e` and the deployment fixes in
[draft PR #307](https://github.com/UnknownAlienHuman/eliot-research/pull/307).
The existing owner Core section-revise/independent-verification/child materialization path is now
composed with fresh execution authority and immutable historical provenance. The current bounded
checkpoint connects the PWA revision and explicit acceptance controls to those existing routes,
reads the exact current publication CAS through the existing validator, and joins native COW children
to ACCEPTED readback. Native outcomes and remaining browser/process-restart gaps are recorded in
[the product checkpoint](product-resume-2026-10-02.md). The S92 source probe remains insufficient for
full owner-loop acceptance; parent review and complete acceptance are still pending.

Focused local checks for this adapter: `pnpm exec vitest run packages/cloudflare-artifacts/src/artifact-cow.test.ts`
and `pnpm test:artifacts-worker`. The latter uses real local D1 migrations and R2;
it is included in `test:worker` and makes no live provider calls.

At this baseline, `node scripts/check-launch-code.mjs` reports disabled
required slices `ERASURE` and `RETRIEVAL`. The implementation registry
validates 43 `IMPLEMENTED_NOT_LIVE` contours and zero `LIVE_QUALIFIED`.
These counts and blockers are dated observations; refresh both commands.

The S92 done-state requires
`pnpm test:local-launch`, `test:local-owner`, `local:prepare`,
`local:smoke`, `test:owner-e2e`, `cf:types`, `build`, `cf:dry-run` and full
F on applicable CI platforms; unexecuted checks stay pending, never PASS.
D1(a) applies to the committed local draft: configuration and readiness
fail-closed only; live-model assertions remain `PENDING_OWNER_D1B` there.
The provider/fallback and historical token installation are already
recorded in [research-runtime-configuration.md](research-runtime-configuration.md).
Verify current installed profile, qualification, budget and data permission
before real calls; do not ask for the same provider/token decision again.

After S92: S94 staging, then S93/S95/S96 on the attested build, then S97
release acceptance. S94's local implementation and preparation do not
depend on a new A/B product decision. Its actual remote effects require
an approved isolated target and explicit deployment authorization; see
the bounded staging preparation below. No such authorization is supplied
by this plan or by the historical model/token installation.

## S37 / #229 — code delivered, do not restart

Task: [S37 / #229](https://github.com/UnknownAlienHuman/eliot-research/pull/229).

### What is in `main`

| SHA | Delivered |
|---|---|
| `c25df085` | Recovered the exact historical S37 patch, published strict branch contracts, removed the obsolete writable publisher and closed #299. |
| `b98ee60f` | Added one shared governed branch executor for `READ_AND_EXTRACT`, `ANALYZE_BRANCHES` and `COUNTER_SEARCH`, with exact scope/protocol/planning/W1/stage-five revalidation and receipt-based recovery. |
| `25be3164` | Registered `research-handlers.exploratory.v7`, connected the shared executor to the stage factory and started-attempt recovery, and retained fail-closed missing-handler behavior. |
| `d252eb69` | Bound research branches into EvidenceFreeze: exact committed v7/v8 branch reconciliation required before freeze; checkpoint, W2 attempt and request identity bound into manifest/freeze refs; unresolved contradictions and open ResearchDebt derived server-side; legacy v2 freeze bytes unchanged. Refs #229. |
| `70dc0965` | Hardened branch freeze lineage: reopen exact committed Stage7/Stage8 outputs before accepting Stage9 reconciliation; exact required-role coverage, nested branch identities, canonical contradiction derivation, one-to-one canonical OPEN debt per blocked role. |
| `16ced6eb` | Passed `branch_execution` deps (database, Work R2, committed stage-five reader, role model) from semantic composition into the workflow handler factory. |
| `a3930696` | Substantive model-backed execution for v7 branch roles: per-role model calls behind W3 admission, installed prompts, model-attempt/reservation ports. |
| `b5ea49df` | Settled W1 observations after v7 branch execution, wired into the session execute path. |
| `8250ff20` | Bound COUNTER to committed read-extract bytes, not analysis output. |
| `fb1c9167` | Branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH (1/2): admission port branch-role awareness. |
| `bccd6037` | Branch-aware W3 spend admission for ANALYZE_BRANCHES/COUNTER_SEARCH (2/2): `admitBranchRole` spend-policy path and policy readers. |
| `05c3c3a1` | Gated W1 branch settling behind branch-execution handler generations, with a regression test for the legacy settling path. |
| `2d1d0ae6` | S37 branch-role unit tests: executor binding, output schema boundaries, preparation fail-closed. |
| `68678041` | S37 `model.roles` server wiring: per-role evidence packs derived only from the frozen stage-five pack (Variant A), deterministic manifest refs, roles assembled in the semantic server; registry contours. |
| `d6041be7`, `331a41b8` | Registered S37 subsystem contours in `implementation-status.json`: 43 exact contours, all `IMPLEMENTED_NOT_LIVE`, 0 `LIVE_QUALIFIED` (`scripts/check-implementation-status.mjs` exit 0). |
| `71348bb2` | T5-A erasure-restore live-gate trial runner (ingest/erase/absence-readback/purge-replay). |
| `0d796ba9` | T5-B prompt-injection trial runner (gate `T5-prompt-injection`). |
| `90f694d0` | T5-C failure-injection trial runner (gate `T5-failure-injection`). |
| `f067fe9c` | T5-D disclosure-audit trial runner (gate `T5-disclosure-audit`). |
| `178f7b25` | T6 representative-load trial runner (gate `T6-representative-load`). Gates enumerated in `tests/integration/live-gates.example.json` (13 gates). |
| `55c83038` | S96 live cost observer + settlement (`research-model-spend-observation`). |
| `b7b7d657` | S37 hardening (1/2): `admitBranchRole` role↔stage fail-closed binding in the spend policy; port-layer re-validation at write time. |
| `90dcfdff` | S37 hardening (2/2): migration `0095` adds the `role` column to `research_model_spend_admission` with a stage-tied CHECK, bound into the admission digest; new tests. |
| `8db894c6` | S92 92.1 intake scenarios + `library.spec.ts` registration (see active checkpoint above). |
| `a452494b` | Migration `0096` rebuilds model-spend admission for stages 8/9/12/13/14, preserves existing rows with a copy guard, and extends the W2 stage mapping. The old stage-8/9 widening packet is delivered. |

### Exact boundary

- `v7` (`research-handlers.exploratory.v7`) is the selected generation for new
  explicit-protocol admissions (`SERVER_OWNED_BRANCH_HANDLER_GENERATION` in
  `apps/eliotr-core/src/research-session.ts`); delegated computer-agent runs
  select `v8` (`SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION`); idempotent
  replay keeps the previously stored handler generation; persisted `v5/v6`
  (and other prior generations) remain accepted and unchanged.
- Semantic composition passes `branch_execution` deps (database, Work R2,
  committed stage-five reader, navigation, ledger, role model) into the stage
  handler factory.
- EvidenceFreeze requires the exact committed v7/v8 branch reconciliation
  before freeze: a missing or inconsistent lineage fails closed
  (`WORKFLOW_AUTHORITY_STALE`), never falling back to the legacy path;
  contradiction refs are derived server-side; a canonical OPEN ResearchDebt is
  recorded per blocked role; legacy v2 freeze bytes are unchanged.
- The branch executor performs per-role model calls behind branch-aware W3
  spend admission (`admitBranchRole`) and settles W1 observations after
  execution, gated behind branch-execution handler generations; COUNTER binds
  committed read-extract bytes.
- `model.roles` is assembled in the semantic server from the installed
  `ELIOTR_MODEL_PROFILE_DEFINITION_JSON` model policy, evidence
  authority/resolver ports and the committed stage-five reader; per-role packs
  are filtered views of the frozen pack with exact frozen digests and
  receipts; absent `config.roles` means roles are not passed at all
  (fail-closed current behavior).
- T5-A/B/C/D and T6 trial runners are code-delivered; their attested/live
  gate runs are acceptance-pending, not PASS.
- S96 cost observer is code-delivered; live qualification is pending.

Do not describe S37 as live-qualified or acceptance-complete. The remaining
work is acceptance (assembly, S93 real-model quality), not code.

### Delivered S37 stage-8/9 repair

The old widening residual is repaired by `a452494b`,
`infra/d1/core/migrations/0096_research_model_spend_admission_branch_stages.sql`.
Its replacement table accepts stages 8/9/12/13/14 and requires a role only
for branch stages. The W2 trigger maps 8/9 to ANALYZE_BRANCHES/COUNTER_SEARCH;
copy verification, all admission triggers and the lookup index are retained.
The corresponding branch-stage tests are in `packages/cloudflare-research/src/`.
Do not change historical migration 0095 or implement another rebuild.
Remote application and exact-build native/live acceptance remain separate.

## Delivered checkpoints that must not be restarted

| Area | Delivered code boundary | Remaining boundary |
|---|---|---|
| Queue/audit reconciliation | `bf1ffa2e` | Selected residual tasks still need exact current-main disposition. |
| D1 depth compiler | `fc25ee02` | #294 dynamic-query coverage and native acceptance. |
| D1 authority/grant/control repair | `7d2bb36`, `d09def61` | Native test source is delivered in `apps/eliotr-core/test/research-authority-0084-acceptance.test.ts`; executed exact-build negative/replay/concurrency evidence is a separate obligation. |
| Full lint/error retention | `eaa4efa` | #296 focused fault/replay acceptance. |
| CI independent reporting/root selection | `a76acd98`, `a348adad` | Root selection/build repair is delivered; applicable exact-build execution remains pending. CI is manual-only. |
| S37 source/contracts/executor/factory | `c25df085`, `b98ee60f`, `25be3164`, `a452494b` | v7/v8 admission, freeze binding, substantive role execution, W1 settling, branch-aware budget, `model.roles` server wiring, admission hardening through `0096` and the 43-contour registry are delivered. Remaining assembly/real-model acceptance must not restart these implementations. |
| S29 immutable semantic configuration | `ccf500e8`, `d774d66a`, `2a5d6458` | Migration `0097`, immutable revision store, digest-checked Worker resolution and installer are delivered. Legacy JSON is an explicit compatibility path; mixed/partial revision identity fails closed. Operator installation/current qualification still need verification. |
| S34 qualification renewal | `5e1552d0` | `packages/cloudflare-research/src/research-model-qualification-renewal.ts` has same-key proof replay and in-process cross-operation single-flight. Do not reimplement it in the route provisioner or infer cross-isolate coordination from this local mechanism. |
| S92 scenario/setup source | `e5c8ec47`, `9c1e4788` | Actual owner/headless/storage/browser outcomes and unresolved COW/product paths remain S92 acceptance work. |
| Browser handshake / Windows gutter | `8b747991`, `4c897429` | #305/#298 are closed with source fixes; authenticated negatives and both OS viewport results still require their own exact-build evidence. |
| Rust vector parser kill tests | `4904b30a` | #106 is closed; four parser kill-test files are delivered. This does not establish a fresh complete mutation or Miri verdict; retain #176's remaining acceptance. |

Also reuse the already delivered project/client grants, machine HTTP/MCP readers and controls, owner historical reads, long-run authority, append-only project attachment, normalized bundle ingestion, runtime failure diagnostics and reconnect intent. Their exact lineages remain in #202–#205, #209, #211, #223–#225, #290 and #291. Open planning cards do not mean those systems are wholly absent.

## Queue after S92

Finish the active checkpoint before switching. Then resume this dependency order:

| Order | Tasks | Next product result |
|---|---|---|
| A | S29/#221 and S34/#226 delivered checkpoints; verified residuals in S10-S15, S31-S33, S98-S99 | Reuse the workspace-candidate admission gate (`37ba91eb`, `5e7ed589`), immutable semantic revision (`ccf500e8`, `d774d66a`, `2a5d6458`) and renewal replay/single-flight (`5e1552d0`). Finish verified selected-profile configuration/qualification and machine-path gaps without reimplementing those delivered mechanisms. |
| B | S21–S23 and remaining S38–S46 | Complete truthful procedure reporting, protocol execution, observations, freeze/debt/supersession, verifiers and product handlers on the shared Research engine. |
| C | S47–S61 | Complete source/navigation/index boundaries, requested coverage, artifacts/publication, Workspace candidate admission/readback and federation. Prioritize dependency-ready S50–S52 and S58/S59. |
| D | S62–S72 | Complete erasure closure, outbox/DLQ/reconciliation, backup/isolated restore, rollback, Steward and durable events. |
| E | S20/#212, S73–S77, #298/#305 | Complete human Library/Connections/artifact flows and Windows layout/session-aware browser fixtures after product assembly. |
| F | S78–S89, #106/#176 | Complete deterministic Rust families, versioned Wasm promotion and removal of superseded TypeScript authority family by family. |
| G | S18/#210, S30/#222, S90/#282, S91/#283 | Reconcile composition, implementation states, emitted artifacts/runtime budgets and D1 mutation boundaries. |

After code assembly: verify the delivered root-suite fixes (`168a29f6`, `df139b47`), #305 handshake and #298 geometry independently on the exact assembled build; run S92 before S94, then S93/S95/S96 and S97. Closed Issues do not replace pending acceptance evidence.

## Cross-cutting records - current state versus historical evidence

These are not permission to interrupt the active checkpoint unless they block its code:

Only #294 and #301 are open at the baseline above; refresh `gh issue list --state open`.

- #294 (open) - one calibrated depth-100 compiler is installed. The refreshed local run compiles 96 Core migration files, 22 views and 399 generic forms with zero failures, plus four Search migrations. This is not exhaustive application/dynamic-query or native authorization proof. The previously recorded 711-shape/64-unresolved-site inventory is historical, not a current census. Reproducible source-derived application and UPDATE-OF-sensitive coverage remains required.
- #301 (open) - retain original task/passport criteria and reconcile selected residuals against exact main. This handoff corrects known stale claims; it does not migrate all tasks or close every legacy obligation.
- #293/#295/#296/#297/#300/#304/#305 (closed) - retain delivered source and the distinct pending exact-build native, fault/replay, root/browser and CI evidence; do not recreate their repairs.
- #298 (closed 2026-10-01) - stable scrollbar gutter delivered in `4c897429`; viewport assertions remain unchanged. Closure is not a retained same-SHA Windows/Ubuntu browser result.
- #106 (closed 2026-10-01) - original canonical survivors were already zero historically; vector parser kill-test source is now delivered. #176 remains the Rust acceptance/debt passport: zero unexplained load-bearing survivors and zero timeouts, with fresh complete mutation and Miri results where required. Do not reopen an old caught-ratio threshold choice.
- #302 (closed) - public-text cleanup is separate from live endpoint disposition. The refreshed public-repo privacy checker still reports six existing hits in other files, including three historical hostname references and three generic Access template/fixture origins; closure is not a clean-tree result. Closure supplies no account-wide rename, Access change, migration or deployment permission.

#299 is complete. Do not reopen or recreate the S37 payload-recovery task.

## S93-S97 - settled requirements and bounded staging preparation

The original passports remain authoritative; no new product choice is needed to
implement their stated requirements. A/B labels in an old handoff are not an ADR.

| Task | Existing contract/source | Exact remaining boundary |
|---|---|---|
| [S94 / #286](https://github.com/UnknownAlienHuman/eliot-research/pull/286) | `scripts/deploy-cloudflare.mjs`, `scripts/lib/deployment-verification.mjs`, `infra/cloudflare/resources.json`, production-readiness Phase 7 and the shared [staging checklist](launch-prs/cloudflare-handoff.md) | Local negative/ordering preparation can proceed. `readDeploymentWorker` is only inventory/export readback; it does not independently attest the actual version, every binding, both schema ledgers, assets and Wasm. Complete that existing reader/receipt path before claiming S94. Actual apply requires isolated approved target and permission. |
| [S93 / #285](https://github.com/UnknownAlienHuman/eliot-research/pull/285) | Existing Golden corpus/runner and production-readiness Phase 9, architecture 19.2-19.5/19.8 | Prepare independent tuning/holdout labels locally. Actual per-product T2/T3 quality results require the attested model/prompt/index/config/corpus generations and approved data/budget. A controlled model response is not quality acceptance. |
| [S95 / #287](https://github.com/UnknownAlienHuman/eliot-research/pull/287) | `tests/integration/d1-write-readback-runner.ts`, T5-A/B/C/D runners, `gate-state.ts`, production-readiness Phases 8/10-12 | Probe source is delivered, not native qualification. Compose/run all applicable T4/T5 storage, security, erasure/restore/rollback and selected independent-client checks against S94; preserve denied/replay/unknown-effect results. Unselected Google clients add no gate. |
| [S96 / #288](https://github.com/UnknownAlienHuman/eliot-research/pull/288) | `tests/integration/t6-representative-load-runner.ts`, model spend observation/settlement, production-readiness Phase 13 | Run 5/20/50 readers, five sessions, ten queued jobs and two long Workflows; measure per-operation latency/errors/resources and actual usage/cost. Approved maximum spend, duration and stop rules precede live load; local simulation or estimates do not qualify it. |
| [S97 / #289](https://github.com/UnknownAlienHuman/eliot-research/pull/289) | Existing release checklist/receipt and production-readiness Phase 14 | Reconcile mandatory selected-profile Slices 0-6, production-critical Rust and S92-S96 evidence, then observe canaries and obtain explicit production approval. No universal correctness claim or merge/deploy permission follows from task closure. |

### Isolation is an operational prerequisite, not an A/B coding hold

The shared staging checklist already permits **a dedicated approved staging
account OR a separately reviewed isolated resource profile**. Neither the S94
passport nor an accepted ADR chooses an account for the operator. Architecture
16.3's clean-account restore rule is an erasure-aware restore requirement,
not a blanket new-account decision for all staging work.

The shipped foundation uses fixed names: Worker `eliotr-core`; D1
`eliotr-core`/`eliotr-search`; R2 `eliotr-evidence`/`eliotr-work`; Queue/DLQ
`eliotr-jobs`/`eliotr-dlq`. The canonical Wrangler configuration also binds
ResearchSession, `eliotr-research-workflow`, AI Search `eliotr`, the reasoning
and retrieval Gateways, and `eliotr_metrics`. Access must protect the exact
chosen ingress before application exposure. `ELIOTR_ENVIRONMENT=staging`
changes a runtime label, not these identities. The generated-config validator
requires the fixed Worker/D1 names; the provisioner verifies canonical resource
names. A suffix plus a deny-list is therefore proposed implementation work,
not an installed or owner-selected staging mode.

For a first trial, an already approved dedicated staging account is the path
compatible with the shipped names. If the operator selects same-account
isolation instead, review and implement the complete profile across provisioners,
bindings, Access, search/gateways, DO/Workflow and readback; do not hand-edit
generated config or merely append `-staging`. Neither path is selected here.

Before requesting final apply approval, prepare privately one exact main
SHA/tree/build and profile; account/resource/hostname/jurisdiction identities;
owner/service identities and secret references (reuse and verify installed
secrets, never request their values); both migration-ledger deltas, including
Core rebuild `0096` and semantic revision `0097` if absent; immutable config
installation/readback; maximum spend and stop conditions; disposable data,
cleanup and rollback scope. The rebuild preserves existing admissions with a
copy guard but still changes schema; label changes can collide with production
resources, and model/index/load work can spend money. No cost is measured by a
dry-run. Obtain authorization for that concrete bundle, then read-only
`cf:preflight:remote` and the existing guarded orchestrator; no raw Wrangler bypass.
The orchestrator additionally requires fresh usage-envelope `ADMITTED` evidence
and a same-process admission capability before remote mutation; an old receipt
or a `SEALED` result cannot authorize upload, migration or provider effects.

S94's own future T4/T6 receipts cannot be prerequisites for the first staging
deployment that produces them. Missing mandatory code, S92 acceptance, exact
attestation preparation, target approval and budget authorization are real
preconditions. They do not block independent local code/documentation work.

## Agent checkpoint protocol

Every active-task comment should state:

```text
Baseline: <exact main SHA>
Delivered before this checkpoint: <SHAs and boundaries>
Residual code: <one precise result>
Owned files: <exact paths>
Static verification: <commands actually run>
Acceptance deferred: <named tests/live work not run>
```

Publication rules:

- main only, no new worktree/task branch;
- one coherent checkpoint per commit;
- refresh `main` immediately before creating the commit;
- non-forced fast-forward only;
- verify the remote ref and published commit file list after the write;
- use `Refs #NNN` with the actual task;
- update the task discussion and this plan whenever the active boundary changes;
- never claim publication from a local patch, unattached blob or prepared manifest.

## Preserved scope and safety

Mandatory baseline remains v1 and Slices 0–6. [ADR-0007](../adr/0007-external-agents-and-cloudflare-evolution.md)
makes model providers, external agents and Google tools independent choices; Muse may replace Spark.
The currently recorded `gemini-mcp` release configuration is not a mandatory vendor choice. Explicit
`disabled` is valid for a Google-free release; configuration and registry must still agree. Unselected
integration gates do not block other work. S29/profile and S10–S13/S98–S99 client work implement the
remaining selection/adapter changes without redoing delivered services. The active checkpoint is S92 local integration; S37 code is delivered (acceptance pending).

No branch deletion, force push, pushed-history rewrite, live deployment, provider spending, hostname change or remote database migration is authorized by this plan.
