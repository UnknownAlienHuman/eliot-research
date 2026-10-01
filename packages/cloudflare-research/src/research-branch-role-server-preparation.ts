import { fail as workflowFail, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  ResearchBranchRoleSchema,
  type ResearchBranchRole,
  type ResearchReadExtractCheckpoint,
} from "@eliotr/contracts";
import type { EvidencePack } from "@eliotr/retrieval";
import { evidenceForRole } from "./research-branch-execution-results.js";
import { buildBranchRoleEvidencePack } from "./research-branch-role-evidence-pack.js";
import { recoverBranchStageRequest } from "./research-branch-role-preparation.js";
import type { createResearchBranchRolePreparation } from "./research-branch-role-preparation.js";
import type { ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { ModelAttemptError, type ModelAttemptReservationInput } from "./model-attempt-types.js";
import type {
  ResearchBranchRoleSpendAdmissionInput,
  ResearchModelSpendPolicy,
} from "./research-model-spend-policy.js";
import type { ResearchModelSpendAdmissionRecord } from "./research-model-spend-admission.js";

/**
 * Server-owned 2-arg preparation seam for branch role model attempts.
 *
 * The role model executor calls this as `prepare(context, role)`. It
 * performs, in order:
 *
 * (a) recovers the stage-level stage request from the role-scoped request;
 * (b) reads the frozen stage-five evidence pack (committed, app-reader
 *     revalidated — never in-memory planning state);
 * (c) reads the COMMITTED read-extract checkpoint bytes and selects the
 *     role's pre-selected evidence (recovery-before-redispatch);
 * (d) builds the Variant A per-role pack: the frozen stage-five pack
 *     filtered to the role's selected handles;
 * (e) selects the installed policy rule + deployment for the role's branch
 *     stage. The stage comes from the role-scoped request itself
 *     (`ANALYZE_BRANCHES` for analysis roles, `COUNTER_SEARCH` for the
 *     counter) — it is never inferred from the role name;
 * (f) records the branch-role spend admission through the same W3 regime as
 *     synthesis/audit;
 * (g) feeds context, role, admission and pack into the W3 preparation seam.
 *
 * Every expensive call stays behind the W3 admission: the model attempt is
 * never prepared without a recorded, read-back spend admission bound to the
 * role-scoped attempt identity.
 */

export interface ResearchBranchRoleStageFiveReaderInput {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: WorkflowPrincipal;
}

export interface ResearchBranchRoleServerPreparationDependencies {
  /**
   * Committed, authority-revalidated frozen stage-five read. The app owns the
   * reader implementation; this seam only declares the port so the package
   * never reaches into app composition.
   */
  readonly read_stage_five: (
    input: ResearchBranchRoleStageFiveReaderInput,
  ) => Promise<{ readonly evidence_pack: EvidencePack }>;
  /** Committed read-extract checkpoint; the app reads it from the checkpoint store + work bucket. */
  readonly read_read_extract: (
    operation_id: string,
    investigation_id: string,
  ) => Promise<ResearchReadExtractCheckpoint>;
  /** Installed spend policy rules; the role's branch stage must have one. */
  readonly policy_rules: ResearchModelSpendPolicy["rules"];
  /** Records the branch-role spend decision and returns the durable admission. */
  readonly admit_branch_role: (
    input: ResearchBranchRoleSpendAdmissionInput,
  ) => Promise<ResearchModelSpendAdmissionRecord>;
  /** The W3 preparation seam: builds intent, quote, authority and model call. */
  readonly prepare_attempt: ReturnType<typeof createResearchBranchRolePreparation>;
}

function invalid(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_INPUT_INVALID", message, false);
}

export function createResearchBranchRoleServerPreparation(
  deps: ResearchBranchRoleServerPreparationDependencies,
): (
  context: ModelAttemptPreparationContext,
  role: ResearchBranchRole,
) => Promise<ModelAttemptReservationInput> {
  if (typeof deps !== "object" || deps === null || typeof deps.read_stage_five !== "function" ||
      typeof deps.read_read_extract !== "function" || !Array.isArray(deps.policy_rules) ||
      typeof deps.admit_branch_role !== "function" || typeof deps.prepare_attempt !== "function") {
    invalid("branch role server preparation dependencies are invalid");
  }
  return async (rawContext, rawRole): Promise<ModelAttemptReservationInput> => {
    if (typeof rawContext !== "object" || rawContext === null) {
      invalid("branch role server preparation context is invalid");
    }
    const context = rawContext as ModelAttemptPreparationContext;
    const role = ResearchBranchRoleSchema.parse(rawRole);
    const recovered = await recoverBranchStageRequest(context.request, role);
    const stage = context.request.stage;
    if (stage !== "ANALYZE_BRANCHES" && stage !== "COUNTER_SEARCH") {
      workflowFail("WORKFLOW_CONFIGURATION_MISSING");
    }
    const rule = deps.policy_rules.find((candidate) => candidate.stage === stage);
    if (rule === undefined) workflowFail("WORKFLOW_CONFIGURATION_MISSING");
    const stageFive = await deps.read_stage_five({
      operation_id: context.request.operation_id,
      investigation_id: context.request.investigation_ref.id,
      principal: context.principal,
    });
    const read = await deps.read_read_extract(
      context.request.operation_id,
      context.request.investigation_ref.id,
    );
    const selected = evidenceForRole(role, read.evidence);
    if (selected.length === 0) workflowFail("WORKFLOW_CONFIGURATION_MISSING");
    const pack = await buildBranchRoleEvidencePack(
      stageFive.evidence_pack,
      role,
      selected.map((item) => item.handle_ref),
    );
    const admission = await deps.admit_branch_role({
      stage_request: recovered.request,
      stage_request_sha256: recovered.sha256,
      role_context: context,
      role,
      deployment: rule.deployment,
    });
    return deps.prepare_attempt(context, role, admission, pack);
  };
}
