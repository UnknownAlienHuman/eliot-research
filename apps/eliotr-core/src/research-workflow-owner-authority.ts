import type { createRawCaptureWorkflowOwnerService } from "@eliotr/cloudflare-raw-ingest";
import {
  readResearchRunStatus,
  WorkflowCheckpointError,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { loadHeldResearchScope } from "@eliotr/cloudflare-research-runtime/research-retrieval-composition.js";
import type { Env } from "./env.js";
import { loadResearchExecutionAccess } from "./research-client-execution.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";

type ExistingOwnerAuthorityReader =
  Parameters<typeof createRawCaptureWorkflowOwnerService>[1]["read_current_authority"];

export type ResearchWorkflowOwnerAuthorityReader = (
  operationId: Parameters<ExistingOwnerAuthorityReader>[0],
  principal: Parameters<ExistingOwnerAuthorityReader>[1],
) => Promise<Awaited<ReturnType<ExistingOwnerAuthorityReader>> & {
  readonly deployment_generation: string;
}>;

function authorityStale(): never {
  throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
}

/** Re-read canonical ACTIVE owner authority and held scope for one Workflow run. */
export function createResearchWorkflowOwnerAuthorityReader(
  env: Env,
  operationId: string,
  principal: WorkflowPrincipal,
): ResearchWorkflowOwnerAuthorityReader {
  return async (currentOperationId, currentPrincipal) => {
    if (currentOperationId !== operationId ||
        currentPrincipal.principal_ref !== principal.principal_ref ||
        currentPrincipal.credential_generation !== principal.credential_generation ||
        currentPrincipal.deployment_generation !== principal.deployment_generation) {
      return authorityStale();
    }

    const status = await readResearchRunStatus({
      database: env.CORE_DB,
      operation_id: currentOperationId,
      principal: currentPrincipal,
      recheck_authority: async () => {
        await requireResearchDeploymentCompatibility(
          env.CORE_DB,
          currentPrincipal.deployment_generation,
          env.DEPLOYMENT_GENERATION,
        );
        const access = await loadResearchExecutionAccess(env, currentOperationId, currentPrincipal);
        if (access.principal_ref !== currentPrincipal.principal_ref ||
            access.credential_generation !== currentPrincipal.credential_generation ||
            access.client_class !== "owner_pwa") {
          return authorityStale();
        }
        const held = await loadHeldResearchScope(
          env,
          access,
          currentOperationId,
          currentPrincipal.deployment_generation,
        );
        if (held.operation_id !== currentOperationId ||
            held.deployment_generation !== currentPrincipal.deployment_generation) {
          return authorityStale();
        }
        return {
          investigation_id: held.investigation_id,
          scope_snapshot_id: held.scope_snapshot_ref.id,
          scope_snapshot_revision: held.scope_snapshot_ref.revision,
        };
      },
    });
    if (status === null || status.state !== "ACTIVE" ||
        status.operation_id !== currentOperationId ||
        status.principal_ref !== currentPrincipal.principal_ref ||
        status.credential_generation !== currentPrincipal.credential_generation ||
        status.deployment_generation !== currentPrincipal.deployment_generation) {
      return authorityStale();
    }
    return {
      principal_ref: currentPrincipal.principal_ref,
      client_class: "owner_pwa",
      credential_generation: currentPrincipal.credential_generation,
      deployment_generation: status.deployment_generation,
      workflow_state: "ACTIVE",
    };
  };
}
