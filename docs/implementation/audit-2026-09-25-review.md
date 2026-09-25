# Independent review of the 2026-09-25 audit

Reviewed source: the attached Claude audit and [PR#303](https://github.com/UnknownAlienHuman/eliot-research/pull/303),
head `7371e81d453bbe905e514cdd135399019d4cf446`. Independent code baseline:
`12321f7721d6d59a75f0d5dd01ebcb569ca46ae0` (S19), newer than the audit's final `eee6f976` (S17).
This review is a disposition of the alternative opinion, not a new whole-program correctness guarantee.
Use [backend-delivery-plan.md](backend-delivery-plan.md) for the updated queue.

## Verification boundary

Read the full audit, the eight-file PR patch, all open issue/task records returned by GitHub, current
CI job results, relevant source/SQL and the existing execution pack. Independently ran static source
budgets, full ESLint, registry/ownership, public-tree privacy scan and empty-schema SQL compilation.
Environment: Node22.16.0, TypeScript6.0.3, SQLite3.46.1; frozen dependency archive matches the current lockfile.
No behavioral, browser, Rust, workerd or live suites were manually invoked. No deployed Worker,
operator account, remote database or model was accessed. Existing CI logs are observations, not new runs.

## Confirmed and extended findings

| Finding | Independent result on12321f77 | Disposition |
| --- | --- | --- |
| D1-depth regression | All82 migrations load. At depth1000, all312 mutation shapes and12 view reads compile. At depth100,15 original-shape mutations fail; all-column UPDATE adds the same attempt-update failure. Three view reads also fail. | #293 first; #294 compiler guard alongside it. |
| Hidden grant-write error | `grantWithLoader` catches INSERT failure, attempts readback, then emits403 when no grant row exists. S17 did not repair this branch. | #293; preserve unknown-write reconciliation, distinguish SQL/storage failure from actual denial. |
| Lint |26 errors independently reproduced, including Node globals, unused values, no-empty-object-type, non-null assertion and no-unsafe-finally. | #296. A lint warning is not automatically a demonstrated runtime/security bug. |
| Source budgets |15 violations:10 files,4 package totals,1 Worker source-byte total. Core25961 lines; PWA15488; Worker source1297105 bytes. | #295/S90. This is not emitted Worker size or cold-start measurement; the scanner includes test files under src. |
| Current CI | Run36176774337 on12321f77:11 jobs,10 failures, only rust succeeds. verify skips26 later steps after its budget failure. | #295. This updates the audit's older job arithmetic/status; no full-green claim. |
| Missing CI selection | Root config selects133 tracked files; explicit CI root filters omit27:11 infra/ai-search,11 backup-o2,5 cloudflare-research. | New #304. Independent of the budget early exit. |
| S19 browser fixture | Current Ubuntu research-screen log requests GET system/session, fails session verification, then times out on history. Existing fixture dispatch has no session response. | New #305, separate from old Windows overflow #298. Do not weaken production auth. |
| Privacy on main | Redacted static scan reports5 hits in5 files. PR303 removes the exposed operator descriptions and uses a neutral Access placeholder; no auth algorithm changes. | PR303/#300/#302. Patch review is not a claim that main is already clean or git history erased. |
| Code gates |39 contours:38 IMPLEMENTED_NOT_LIVE,1 IN_PROGRESS,0 LIVE_QUALIFIED; ownership46 packets/560 claims. launch:code still lists RETRIEVAL, ERASURE and Workspace candidate admission/readback. | Preserve states; prioritize actual code owners, not cosmetic READY labels. |
| Stranded S37 source | Publisher/payload still tracked; no expected S37 feature checkpoint in main history. | #299/#229. Recover/checksum/reconcile useful code before cleanup or duplicate implementation. |

### SQL failure inventory and limits of the check

At depth100, INSERT fails for artifact_draft_reservation, evidence_handle,
evidence_resolution_receipt, investigation_ledger_command, investigation_ledger_head,
research_model_spend_admission, research_report_admission, research_workflow_attempt,
research_workflow_checkpoint, research_workflow_citation_binding, research_workflow_run,
retrieval_query_result, retrieval_query_trace and scope_access_grant. UPDATE of
research_workflow_attempt also fails. Generic research_workflow_run UPDATE no longer fails in this
0083 inventory; recheck actual column-sensitive statements rather than freezing the older list.

SELECT also fails for scope_access_grant_effective, research_workflow_current and
research_workflow_recovery_authorized. CREATE VIEW success alone does not prove its consumers compile.
The check sets SQLITE_LIMIT_EXPR_DEPTH before applying migrations, disables statement caching and
uses EXPLAIN of no-row INSERT, first/all-column UPDATE, DELETE and view SELECT. It inspects78
trigger-bearing tables. It executes no product-data mutation. This confirms a compiler defect under
the100-depth condition reported by the audit's native D1 failure, not full D1 semantic equivalence.
Other engine limits, actual UPDATE OF triggers, prepared bindings and native transaction behavior
remain separate obligations under #294/S91. Earlier default1000 compilation was an insufficient check.

Sources: current migration chain through0083; orientation-authority.ts; issue#293 comment5838263584;
issue#294 comment5838276323. Public Cloudflare [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
separately document100 bound parameters and32 function arguments; do not infer complete platform parity
from changing one local SQLite limit.

### Existing CI observations

The [current CI run](https://github.com/UnknownAlienHuman/eliot-research/actions/runs/36176774337)
was read rather than rerun. Ubuntu research-screen job108209511633 reports an unhandled required
session GET and “The owner session could not be verified”, followed by the S26 history deadline.
The earlier Windows scrollbar overflow is a distinct audited observation; this review did not rerun
or independently prove its precise geometry. Both current screen jobs fail, but one shared red label
does not establish an identical cause. #305 must unmask initialization before #298's browser proof.

The audit's33 root test failures on eee6f976 remain reported evidence, not an independently rerun
current count. #297 must separate stale fixtures from real production defects and preserve security
assertions. #304 was found by comparing actual root include rules, CI filters and the federation
package command; provisioner aliases select different files, not the missing27 root files.

## Corrections to the audit's conclusions and recommendations

The audit's central SQL/visibility finding is valid and more important than an open-PR count.
However, “20–25% ready” is an estimate from task/phase counts, not a defensible measurement of remaining
code or effort. An open draft PR can contain delivered code awaiting acceptance; it cannot be counted
as entirely unwritten. S17/S19 and recent machine/import checkpoints must not be scheduled from scratch.

LIVE_QUALIFIED=0 means no contour has the registry's complete qualifying evidence. It does not prove
that no limited historical live round trip occurred: the repository contains dated owner-loop records.
Likewise,0066 is the latest deployment recorded in the cited documents, not an independently inspected
current deployment. Keep the recorded-vs-observed distinction; no public hostname or account check was made.

Later regressions do not invalidate every historical focused result or prove all closed tasks were
never accepted. Link S03/S04/S08 to the shared SQL regression and S26 to #298/#305 instead of silently
reopening every delivered feature. #106 and #176 are debt plus umbrella, not an automatic duplicate pair.
Launch and salvage records need mappings and preserved unique work, not wholesale deletion or merging.

The owner's code-first instruction supersedes the proposed stop-all-features-until-full-tests-green
procedure. Fix known broken production SQL now; compile/lint the code; retain full negative/native
criteria for assembled-product acceptance. No absent local agent is assumed to perform hidden tests.
Do not weaken policies, treat compilation as behavioral proof, or close unresolved acceptance as done.

Correct release order is S92 local integration before S94 staging, then applicable S93/S95/S96 on the
attested build, then S97. Managed OAuth and unselected transport profiles are not extra baseline blockers.
Hostname retirement is an explicit operator decision, not authorization for account changes or a git
history rewrite. Exposed hostname/model metadata is not evidence of leaked credentials or Access bypass.

## Tracker actions and remaining scope

Kept #293–#302 rather than duplicating Claude's ten issues. Added #304 for incomplete CI selection and
#305 for session-aware browser fixtures. Extended #293/#294 with current SQL/view evidence. Refined
#295 to preserve independent checks without inventing a full-test-before-code freeze; #299 to protect
stranded source and permit direct authorized Git API publication; #301 to preserve passports, criteria
and legacy obligations without destructive mass migration. #296/#297/#298 keep their distinct scopes.

The current queue and process entrypoints replace stale next-step/worktree instructions. The long
prior implementation ledger remains reachable at its immutable pre-review main URL. Full task-body
restoration and moving every passport remain #301 work; this review does not claim99 cards rewritten.
Other README/architecture/profile heading corrections remain #300 and the privacy patch remains PR303.
No application defect, UI overflow, emitted-size target or live qualification is declared fixed by this
planning change. No branch, old passport, source payload or history was deleted.
