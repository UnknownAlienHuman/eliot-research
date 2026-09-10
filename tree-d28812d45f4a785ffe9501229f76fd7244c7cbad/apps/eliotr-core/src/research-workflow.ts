import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { CompletionDisposition, VersionedRef } from "@eliotr/contracts";
import type { Env } from "./env.js";

export interface ResearchWorkflowParams {
  readonly investigation_ref: VersionedRef;
  readonly idempotency_key: string;
  readonly requested_by_principal_ref: string;
}

export interface ResearchWorkflowSkeletonResult {
  readonly investigation_ref: VersionedRef;
  readonly state: "IMPLEMENTATION_PENDING";
  readonly completion_disposition: CompletionDisposition;
  readonly receipt_ref: string;
}

// SCAFFOLD_FAIL_CLOSED: ER-09 Research Workflow returns explicit pending state until governed execution is implemented.
export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchWorkflowParams> {
  public override async run(event: WorkflowEvent<ResearchWorkflowParams>, step: WorkflowStep): Promise<ResearchWorkflowSkeletonResult> {
    return step.do("fail-closed-until-er-09", async () => ({
      investigation_ref: event.payload.investigation_ref,
      state: "IMPLEMENTATION_PENDING" as const,
      completion_disposition: "INCONCLUSIVE" as const,
      receipt_ref: `pending:${event.payload.idempotency_key}`,
    }));
  }
}
