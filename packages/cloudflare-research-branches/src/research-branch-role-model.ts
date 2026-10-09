// IMPLEMENTED_NOT_LIVE: S37 per-role branch model execution derives role-scoped stage requests and dispatches role-bound model stage handlers through the server-owned W3 preparation seam; role prompt compilation wiring and live model qualification remain separate.
import {
  StageRequestSchema,
  type StageRequest,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import {
  ResearchBranchRoleSchema,
  type BranchQueryPlan,
  type BranchQueryResult,
  type ResearchBranchRole,
} from "@eliotr/contracts";
import {
  createResearchModelStageHandler,
  type ResearchModelStageHandler,
  type ResearchModelStageHandlerDependencies,
} from "@eliotr/cloudflare-model-execution";
import type { ResearchModelPromptCompilerDependencies } from "@eliotr/cloudflare-model-control";
import type { ModelAttemptReservationInput } from "@eliotr/cloudflare-model-execution";
import type { ModelAttemptPreparationContext } from "@eliotr/cloudflare-model-execution";

export interface ResearchBranchRoleModelDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly gateway: ResearchModelStageHandlerDependencies["gateway"];
  /** Installed per-role prompt compiler dependencies. */
  readonly prompt: (role: ResearchBranchRole) => ResearchModelPromptCompilerDependencies;
  /** Snapshot runs select a distinct pinned gateway and prompt policy per actual W2 stage. */
  readonly gateway_for_stage?: (stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH") => ResearchModelStageHandlerDependencies["gateway"];
  readonly prompt_for_stage?: (role: ResearchBranchRole, stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH") => ResearchModelPromptCompilerDependencies;
  /** Dynamic v2 prompt seam: context is derived from the exact committed read/extract bytes. */
  readonly prompt_for_stage_input?: (
    role: ResearchBranchRole,
    stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH",
    input_bytes: Uint8Array,
    branch_query?: { readonly plan: BranchQueryPlan; readonly result: BranchQueryResult },
  ) => ResearchModelPromptCompilerDependencies;
  /**
   * Server-owned W3 preparation seam. Builds the intent, quote, authority and
   * model call for one role attempt. The spend admission for branch stages is
   * owned by the duration/budget checkpoint; until it lands this must fail closed.
   */
  readonly prepare: (
    context: ModelAttemptPreparationContext,
    role: ResearchBranchRole,
  ) => Promise<ModelAttemptReservationInput>;
  readonly spend_authorization: ResearchModelStageHandlerDependencies["spend_authorization"];
  readonly pricing: ResearchModelStageHandlerDependencies["pricing"];
  /** Selects pricing for the exact W2 stage; Native zero pricing cannot leak across stages. */
  readonly pricing_for_stage?: (stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH") => ResearchModelStageHandlerDependencies["pricing"];
  readonly native_model_authority?: ResearchModelStageHandlerDependencies["native_model_authority"];
  readonly deployment_environment?: ResearchModelStageHandlerDependencies["deployment_environment"];
  readonly expected_deployment?: ResearchModelStageHandlerDependencies["expected_deployment"];
  readonly now?: () => number;
}

export interface ResearchBranchRoleModelInput {
  readonly role: ResearchBranchRole;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly attempt_ref: string;
  readonly budget_receipt_ref: string;
  readonly input_bytes: Uint8Array;
  /** Server-only exact query provenance; input_bytes remains the committed stage input. */
  readonly branch_query?: { readonly plan: BranchQueryPlan; readonly result: BranchQueryResult };
}

export interface ResearchBranchRoleModelExecutor {
  /** Executes one governed RESEARCH model attempt for the role. Returns raw model output bytes. */
  readonly executeRole: (input: ResearchBranchRoleModelInput) => Promise<Uint8Array>;
}

/**
 * Derives the role-scoped stage request. The idempotency key is suffixed per
 * role so every required role gets exactly one governed model attempt, an
 * absent role costs zero calls, and a restart replays the same attempt instead
 * of dispatching a duplicate.
 */
export function deriveBranchRoleStageRequest(
  request: StageRequest,
  role: ResearchBranchRole,
): StageRequest {
  const parsedRole = ResearchBranchRoleSchema.parse(role);
  return StageRequestSchema.parse({
    ...request,
    idempotency_key: `${request.idempotency_key}:branch-role:${parsedRole}`,
  });
}

export function createResearchBranchRoleModelExecutor(
  dependencies: ResearchBranchRoleModelDependencies,
): ResearchBranchRoleModelExecutor {
  if (dependencies.native_model_authority !== undefined && dependencies.pricing_for_stage === undefined) {
    throw new Error("Native branch execution requires stage-specific model pricing");
  }
  const handlers = new Map<string, ResearchModelStageHandler>();
  const handlerFor = (
    role: ResearchBranchRole,
    stage: "ANALYZE_BRANCHES" | "COUNTER_SEARCH",
    inputBytes: Uint8Array,
    branchQuery?: { readonly plan: BranchQueryPlan; readonly result: BranchQueryResult },
  ): ResearchModelStageHandler => {
    const key = `${stage}:${role}`;
    const cached = dependencies.prompt_for_stage_input === undefined ? handlers.get(key) : undefined;
    if (cached !== undefined) return cached;
    const stagePromptMismatch = dependencies.prompt_for_stage_input === undefined &&
      ((dependencies.gateway_for_stage === undefined) !== (dependencies.prompt_for_stage === undefined));
    const missingStagePrompt = dependencies.gateway_for_stage !== undefined &&
      dependencies.prompt_for_stage === undefined && dependencies.prompt_for_stage_input === undefined;
    if (stagePromptMismatch || missingStagePrompt) {
      throw new Error("research branch role stage transport and prompt must be configured together");
    }
    const created = createResearchModelStageHandler({
      database: dependencies.database,
      work_bucket: dependencies.work_bucket,
      operation_kind: "RESEARCH",
      gateway: dependencies.gateway_for_stage?.(stage) ?? dependencies.gateway,
      prompt: dependencies.prompt_for_stage_input?.(role, stage, inputBytes, branchQuery) ??
        dependencies.prompt_for_stage?.(role, stage) ?? dependencies.prompt(role),
      pricing: dependencies.pricing_for_stage?.(stage) ?? dependencies.pricing,
      ...(dependencies.native_model_authority === undefined ? {} : { native_model_authority: dependencies.native_model_authority }),
      prepare: (context) => dependencies.prepare(context, role),
      spend_authorization: dependencies.spend_authorization,
      ...(dependencies.deployment_environment === undefined
        ? {}
        : { deployment_environment: dependencies.deployment_environment }),
      ...(dependencies.expected_deployment === undefined
        ? {}
        : { expected_deployment: dependencies.expected_deployment }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
    if (dependencies.prompt_for_stage_input === undefined) handlers.set(key, created);
    return created;
  };
  return Object.freeze({
    async executeRole(input: ResearchBranchRoleModelInput): Promise<Uint8Array> {
      const role = ResearchBranchRoleSchema.parse(input.role);
      const stage = input.request.stage;
      if (stage !== "ANALYZE_BRANCHES" && stage !== "COUNTER_SEARCH") {
        throw new Error("research branch role request stage is invalid");
      }
      const roleRequest = deriveBranchRoleStageRequest(input.request, role);
      return handlerFor(role, stage, input.input_bytes, input.branch_query).handler({
        request: roleRequest,
        principal: input.principal,
        input_bytes: input.input_bytes,
        attempt_ref: input.attempt_ref,
        budget_receipt_ref: input.budget_receipt_ref,
      });
    },
  });
}
