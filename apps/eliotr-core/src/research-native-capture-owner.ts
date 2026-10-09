import { createRawCaptureWorkflowOwnerService } from "@eliotr/cloudflare-raw-ingest";
import {
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import type { NativeWebSearchRawCaptureOwnerPort } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { createResearchWorkflowOwnerAuthorityReader } from "./research-workflow-owner-authority.js";

/** Bind raw capture to the existing durable owner actor, held scope and Workflow run. */
export function createResearchNativeCaptureOwner(
  env: Env,
  operationId: string,
  principal: WorkflowPrincipal,
): NativeWebSearchRawCaptureOwnerPort {
  return createRawCaptureWorkflowOwnerService(
    { CORE_DB: env.CORE_DB, EVIDENCE_BUCKET: env.EVIDENCE_BUCKET },
    {
      operation_id: operationId,
      principal,
      read_current_authority: createResearchWorkflowOwnerAuthorityReader(env, operationId, principal),
    },
  );
}
