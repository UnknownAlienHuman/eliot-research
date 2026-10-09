# #325 READ_AND_EXTRACT proposal cutover — owner review

**Review basis:** live open PR [#325](https://github.com/UnknownAlienHuman/eliot-research/pull/325), local `main` HEAD `a064cfb2b4719fef9ed160c1d0ea93e76ef3968a`, and the shared working-tree source read on 2026-10-09. This is a bounded proposal-call policy note, not #325 completion or activation evidence.

## Owner decision: call cardinality is not specified

#325 authorizes server-validated model query proposals and says a simple/direct branch does not fan out. Its acceptance list explicitly requires zero model calls for an optional missing role. It does **not** require a positive proposal call for a required role, nor say whether READ_AND_EXTRACT may make zero or one proposal call per stage or one per required role. “Does not fan out” describes the direct retrieval path; it does not settle proposal-call cardinality.

The existing generic W3 note says the governed handler has at most one expensive provider boundary per stage (`docs/implementation/workflow-checkpoints.md`, lines 275–280). Existing branch-role W3 behavior is separately role-scoped for ANALYZE_BRANCHES/COUNTER_SEARCH (`docs/implementation/backend-delivery-plan.md`, lines 1091–1098). Neither document extends that role-scoped exception to READ_AND_EXTRACT. The code comment in `research-branch-query-proposal.ts` says one call **per helper invocation**; it is implementation commentary, not a task-level decision.

Please choose and record one policy before activating proposals:

- **No READ_AND_EXTRACT proposal call:** retain deterministic direct plans for every required role.
- **One stage-scoped proposal attempt:** specify whether it is eligible for every required stage and define the strict output shape for multiple roles. The current v1 proposal contract is for one role, so a single multi-role call would need a separately versioned batch contract.
- **One proposal attempt per required role:** retain the current role-scoped v1 shape and define a separate W3 attempt/admission identity per role. The present admission store is keyed by `(operation_id, stage_index)`, so it cannot persist several READ_AND_EXTRACT admissions at stage index 7.

The existing #325 zero-call rule for an optional missing role remains in force under any choice. No model, route, prompt, token limit, byte limit, spend amount, or fallback rule is selected by this note.

## What the current source does

- `packages/contracts/src/research-branch-query.ts` defines strict `BranchQueryProposalSchema` v1 with one `role`, bound root/branch question refs and digests, and bounded query legs. `packages/cloudflare-research-branches/src/research-branch-query-plan.ts` already validates/binds a candidate and otherwise builds a deterministic direct query plan.
- `packages/cloudflare-research-branches/src/research-branch-query-proposal.ts` exports `produceResearchBranchQueryProposal`. It validates a READ_AND_EXTRACT request, returns without a call when its single role plan is not required, and otherwise makes one call through the injected handler for that role. Its caller supplies the selected W3 handler, attempt ref, and budget receipt ref. No production caller was found.
- `readExtractCheckpointV2` in `packages/cloudflare-research-branches/src/research-branch-execution.ts` iterates the required roles, creates a plan without a proposal, and calls `execute_query_plan` for each. The READ_AND_EXTRACT handler currently destructures only `request` and `principal`; it does not forward its W2 attempt ref or budget receipt ref to a proposal path. The runtime callback in `packages/cloudflare-research-runtime/src/research-branch-query-execution.ts` performs bounded retrieval, not model proposal generation.
- W2 indexes READ_AND_EXTRACT as 7; ANALYZE_BRANCHES and COUNTER_SEARCH are 8 and 9 (`infra/d1/core/migrations/0020_research_workflow_checkpoints.sql`, stage mapping). W3 spend admission currently permits only indexes 8, 9, 12, 13, and 14; its role binding is limited to indexes 8/9 (`packages/cloudflare-model-execution/src/research-model-spend-admission.ts`, lines 38, 73–86, 317–333; `infra/d1/core/migrations/0096_research_model_spend_admission_branch_stages.sql`). Index 7 has no W3 admission. The migration’s primary key is `(operation_id, stage_index)`.

## Existing immutable selection and policy seams

The immutable per-run configuration is `eliotr.research-run-configuration.v1`. `packages/cloudflare-research-configuration/src/research-run-configuration.ts` captures model selections, semantic configuration, model profile, spend policy, and report policy; migration `infra/d1/core/migrations/0104_research_run_configuration.sql` stores the canonical snapshot and forbids update/delete. Retries resolve that capture. A generic `stage: string` field in the run-selection codec is not evidence that the provider-selection or spend path supports a stage.

The current provider-key model-use plan is explicitly four-stage: `ANALYZE_BRANCHES`, `COUNTER_SEARCH`, `SYNTHESIZE`, `AUDIT_CLAIMS` (`packages/cloudflare-research-configuration/src/research-provider-key-model-use-store.ts`, lines 8, 23; `research-provider-key-model-use-plan.ts`, line 37; migration `infra/d1/core/migrations/0110_research_provider_key_model_use.sql`). Its stage plan records route/deployment, prompt/schema/parameter digests, transport policy, and input/output byte bounds. READ_AND_EXTRACT is absent from that plan and persisted stage set.

Branch model dependencies in `packages/cloudflare-research-branches/src/research-branch-role-model.ts` and `packages/cloudflare-research-runtime/src/research-semantic-composition-contract.ts` restrict selected gateway, prompt, and pricing callbacks to ANALYZE_BRANCHES or COUNTER_SEARCH. `packages/cloudflare-research-runtime/src/research-semantic-server.ts` builds those selections and the branch-role W3 preparation/admission. The semantic config’s optional `roles.trusted_parameters` is the existing branch-finding prompt input; it is not a proposal-specific prompt/schema generation. The model profile and spend policy are captured in the run snapshot, but no READ_AND_EXTRACT selection binds them to a proposal call.

## Cutover seams after the decision

Keep V1 snapshots and direct-plan behavior readable and unchanged. Add an explicitly versioned, immutable READ_AND_EXTRACT capability only after the owner sets cardinality. It must bind the chosen stage/role identity to the exact selected route and qualification, provider transport policy, proposal prompt and output schema generations/digests, parameters, profile, and spend admission. Do not inherit ANALYZE_BRANCHES settings or fill absent settings with defaults. A missing selection/admission must remain a no-call or fail-closed result according to the owner’s recorded policy.

The smallest affected implementation surfaces are:

- **Shared contract/prompt:** `packages/contracts/src/research-branch-query.ts` (only if a batch protocol is chosen); a dedicated proposal prompt/schema compiler in `packages/cloudflare-research-branches/src/` (none exists today).
- **Immutable selection/profile:** `packages/cloudflare-research-configuration/src/research-run-model-selection-codec.ts`, `research-run-configuration.ts`, `research-provider-key-model-use-store.ts`, and `research-provider-key-model-use-plan.ts`; corresponding immutable persistence/versioning is root-owned (`infra/d1/core/migrations/0104_research_run_configuration.sql`, `0110_research_provider_key_model_use.sql`).
- **Spend authority:** `packages/cloudflare-research-configuration/src/research-owner-spend-policy.ts`, `packages/cloudflare-model-execution/src/research-model-spend-admission.ts`, and the admission schema/migration currently ending at `infra/d1/core/migrations/0096_research_model_spend_admission_branch_stages.sql`. A per-role choice also needs admission identity/storage that can distinguish multiple attempts within stage 7.
- **Role/runtime handoff:** `packages/cloudflare-research-branches/src/research-branch-role-model.ts`, `packages/cloudflare-research-runtime/src/research-semantic-composition-contract.ts`, `research-semantic-composition.ts`, and `research-semantic-server.ts` for the selected gateway, proposal prompt, pricing, and W3 preparation. The W2 caller is `packages/cloudflare-research-branches/src/research-branch-execution.ts`; its retrieval callback remains `packages/cloudflare-research-runtime/src/research-branch-query-execution.ts`.

The missing implementation that does not require choosing call count is a pure, dormant prompt renderer for the existing single-role v1 proposal schema. A bounded next write set is a new private `packages/cloudflare-research-branches/src/research-branch-query-proposal-prompt.ts` plus its focused test: consume the already server-bound one-role question/plan context and render instructions matching the existing `BranchQueryProposalSchema`; do not add a caller, export, provider invocation, selection, spend rule, or new contract. This compiles the existing v1 shape without choosing whether or how often the stage calls it. A stage-wide multi-role batch schema is not documented by #325 and is not a safe preparatory contract change.

No production proposal-call write set can be completed safely until the owner resolves stage-wide versus per-role cardinality and the corresponding W3 receipt identity. The current deterministic direct plan already provides the bounded no-proposal behavior. After that decision, the cutover above is one cohesive caller/selection/admission checkpoint, not a second planner or service.

## Still unproven

No READ_AND_EXTRACT proposal prompt, selected provider stage, W3 admission, durable proposal-attempt identity, or production caller is established by the current source. No model call or runtime acceptance was performed for this note. #325’s proposal behavior, replay semantics, required-role blocking, and full workflow/native acceptance remain separate and pending.