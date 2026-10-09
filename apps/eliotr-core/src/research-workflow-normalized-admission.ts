import type { RawNormalizedAdmissionRequest } from "@eliotr/interfaces";
import { readRawMarkdownCandidate } from "@eliotr/cloudflare-markdown";
import {
  createRawCaptureWorkflowOwnerServiceWithServerReadback,
  createRawNormalizedAdmissionService,
  type RawNormalizedAdmissionRequestPorts,
} from "@eliotr/cloudflare-raw-ingest";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { Env } from "./env.js";
import { createResearchWorkflowIngestOwner } from "./research-workflow-ingest-owner.js";
import { createResearchWorkflowOwnerAuthorityReader } from "./research-workflow-owner-authority.js";

/**
 * Trusted server composition for an existing conversion and one ACTIVE owner run.
 * The selected conversion profile is mandatory; this factory does not select
 * conversion bounds, execute conversion, or extend the run's frozen scope.
 */
export function createResearchWorkflowNormalizedAdmission(input: {
  readonly env: Env;
  readonly operation_id: string;
  readonly principal: WorkflowPrincipal;
  readonly signal: AbortSignal;
  readonly conversion_profile_generation: string;
}) {
  const { env, operation_id: operationId, signal } = input;
  const principal = Object.freeze({ ...input.principal, signal });
  const readAuthority = createResearchWorkflowOwnerAuthorityReader(env, operationId, principal);
  const assertCurrentAuthority = async (): Promise<void> => {
    signal.throwIfAborted();
    await readAuthority(operationId, principal);
    signal.throwIfAborted();
  };
  const capture = createRawCaptureWorkflowOwnerServiceWithServerReadback(env, {
    operation_id: operationId,
    principal,
    read_current_authority: readAuthority,
  });
  const conversionContext = Object.freeze({
    credential_generation: principal.credential_generation,
    deployment_generation: principal.deployment_generation,
    profile_generation: input.conversion_profile_generation,
  });
  const ports: RawNormalizedAdmissionRequestPorts = {
    owner: createResearchWorkflowIngestOwner(env, operationId, principal),
    assertCurrentAuthority,
    readCapture: (captureId) => capture.readRawCaptureForServer(captureId),
    readConversion: (receipt, conversionOperationId, assertCurrent, currentSignal) =>
      readRawMarkdownCandidate(
        env.CORE_DB,
        env.EVIDENCE_BUCKET,
        principal,
        receipt,
        conversionOperationId,
        { assertCurrent, signal: currentSignal },
        conversionContext,
      ),
  };
  const capability = createRawNormalizedAdmissionService({ database: env.CORE_DB });
  const actor = { principal_ref: principal.principal_ref, signal };
  return {
    admit: (captureId: string, request: RawNormalizedAdmissionRequest) =>
      capability.admit(actor, captureId, request, ports),
    getStatus: (captureId: string, admissionOperationId: string) =>
      capability.getStatus(actor, captureId, admissionOperationId, ports),
  };
}
