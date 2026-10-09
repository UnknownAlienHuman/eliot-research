# Branch-query budget selection gap

Reviewed 2026-10-09 against `main` `6b03fe89d2da2d2213e6221d831788b1ccc9e6bb`
and the prepared #325 source. This is an implementation/input gap, not permission
to select a new budget or evidence of V9 runtime acceptance.

## Required selection

[PR #325](https://github.com/UnknownAlienHuman/eliot-research/pull/325) requires a
versioned question-bound plan with explicit candidate, scan, evidence and byte
budgets. `BranchQueryPlanSchema` in
`packages/contracts/src/research-branch-query.ts` additionally binds the maximum
query-leg count. Its structural ceilings are not selected operating limits.

The previously uncommitted `research-branch-query-plan.ts` chose 16 candidates,
64 scans, eight evidence items, 16 KiB and four legs. No inspected current
passport, architecture or profile producer specifies that tuple. The prepared
source now requires explicit strict-schema-validated budgets instead of those
defaults. `readExtractCheckpointV2` requires `query_plan_budgets` before calling
`execute_query_plan`; absence yields `WORKFLOW_CONFIGURATION_MISSING`. Historical
generations retain their existing path. No model/provider call was made.

## Existing authority and missing producer

The existing `ScopeProfileBinding` stores `version`, `max_sources` and
`max_results`, with readback against the scope snapshot. It cannot establish
the selected scan, candidate, byte or query-leg limits. The runtime composition
receives that binding as `retrieval_profile`; the current immutable run
configuration/model selection does not supply the new complete budget tuple.

The internal optional dependency preserves older callers and leaves V9 closed
when no immutable selection exists. Passing new values through an arbitrary
composition input would not establish an owner-selected frozen profile. The
pending producer must bind the complete tuple and its profile/version to the
immutable run/scope configuration and preserve it on retry/replay. A profile
change needs explicit versioned capture; it must not rewrite older snapshots.
No migration, wire version, operating value or fallback policy is selected by
this note.

## Other dependencies

C1 still blocks the unresolved managed-primary lane cutover and its service
publication. C2 independently blocks READ_AND_EXTRACT proposal-call activation.
Budget selection does not authorize proposal calls, settle their W3 identity,
or qualify paid/native retrieval. Branch finding/freeze source work can continue,
but full #325/#214 assembly and actual V9 activation remain pending.
