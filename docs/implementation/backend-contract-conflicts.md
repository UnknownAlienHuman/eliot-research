# Backend contract conflicts awaiting owner review

Recorded 2026-10-09; refreshed against main `73612d40c915006cbb6bd0d818ded5edd9b732fc` and the shared uncommitted implementation. These conflicts block only their named acceptance criteria. Independent backend work continues; the overall Goal remains active.

## C1 — D1 lexical execution order versus managed hybrid primary

Status: **OWNER_DECISION_PENDING**. Published main has not adopted the unresolved
managed-primary cutover; neither regression assertion has been weakened. The
unpublished working-tree service already selects SEM-primary behavior through
`queryWithBudgetSettlement()`, so it cannot be published as a dormant API.

The current specifications disagree about actual lane execution when a plan contains both LEX and SEM:

| Source | Required behavior |
| --- | --- |
| [PR #322](https://github.com/UnknownAlienHuman/eliot-research/pull/322), updated 2026-10-08T23:18:53Z | “The Q3 invariant requires every IDENT/EXACT/LEX direct lane to precede every SEM occurrence.” Its stated scope is planner/tests, without provider behavior changes. |
| [PR #242](https://github.com/UnknownAlienHuman/eliot-research/pull/242), updated 2026-10-08T23:12:08Z | IDENT/EXACT → one scoped Cloudflare AI Search hybrid ranked list → Eliot diversity/currentness → bounded exact resolution/backfill. “D1 phrase-only LEX is not a second primary relevance engine.” It explicitly references #322. |
| [Architecture §6.1](../architecture/ELIOT_RESEARCH.md), line 1567 | Lists lexical fallback. |
| Architecture §6.7, lines 1786–1787 | Lists exact/lexical candidates before semantic/literal lanes. |

The implementation exposes the disagreement rather than merely describing two compatible plan representations:

- `packages/retrieval/src/service.ts`, lines 230–267: the plan is checked for direct-before-semantic order, but LEX is skipped when managed SEM is primary. D1 LEX executes after SEM only if SEM is unavailable. The public `query()` calls this path at line 609.
- `packages/retrieval/src/retrieval.test.ts`, line 289: Q3 asserts actual `IDENT → LEX → SEM` calls.
- `packages/retrieval/src/managed-hybrid.test.ts`, line 437: managed hybrid asserts SEM primary and D1 LEX only after SEM becomes unavailable.

The prior focused consolidation run reported four passing checks and one failure at this lane-order assertion. It is not accepted as a passing retrieval gate.

Owner review needs to settle whether the Q3 requirement governs planned lane order only, or mandates actual D1 LEX execution before SEM even for the managed hybrid product. The selected rule must identify any product-specific exception and align #242, #322, architecture prose, execution behavior and both regressions in one coherent change.

Until that review, this acceptance criterion is deferred. Other retrieval, Session, acquisition, deployment and authority work can proceed independently.

## C2 — READ_AND_EXTRACT proposal call cardinality

Status: **OWNER_DECISION_PENDING** before activation. The concrete contract and stage-7 admission mismatch, normative sources and possible cutovers are recorded in [read-extract-proposal-cutover.md](read-extract-proposal-cutover.md). The existing deterministic direct plan continues without invented model calls, profiles or budgets; preparatory source work remains independent.

## C3 — Selected Workflow conversion request

Status: **INPUT_PENDING**, rather than a choice between contradictory policies.
Native acquisition selection does not carry the separate converter's output,
token and timeout bounds/options. The inspected Workflow has no documented
producer of that selected request. The concrete missing inputs, reusable
authority/policy seams and explicit subsequent scope cutover are recorded in
[workflow-conversion-admission-cutover.md](workflow-conversion-admission-cutover.md).
Automatic conversion is deferred; current-authority and admission infrastructure
work continues independently.

## C4 — Complete managed-generation membership

Status: **IMPLEMENTATION_PENDING**. The prepared manifest proves equality to a
selected retrieval snapshot, while #244 requires the complete target-wide
required set. This is missing implementation evidence, not authorization to
replace the SEARCH_DB pointer owner. The exact cutover, denominator and authority
boundaries are recorded in [managed-generation-promotion-fence.md](managed-generation-promotion-fence.md).

New item keys must be built in a selected shadow generation before promotion.
The ACTIVE-target dispatch defect and exact configured-target preflight are
source-published in `eda91106`; full required-set and promotion acceptance
remain pending. The October 9 audit found no published rule assigning the
complete canonical source/revision set to a managed target. The gap note
records the exact tables and missing membership/revision fence for owner review.
