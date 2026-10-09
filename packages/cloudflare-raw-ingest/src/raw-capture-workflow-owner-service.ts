import type { RawFileCaptureRequest, RawFileCaptureResult } from "@eliotr/interfaces";
import { RawCaptureError } from "./raw-ingest-types.js";

export interface RawCaptureWorkflowPrincipal {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly signal?: AbortSignal;
}

export interface RawCaptureWorkflowOwnerAuthoritySnapshot {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
  readonly workflow_state: "ACTIVE";
}

export interface RawCaptureWorkflowOwnerAuthorityInput {
  readonly operation_id: string;
  readonly principal: RawCaptureWorkflowPrincipal;
  /**
   * Must re-read the canonical run status and execution actor for this exact operation/principal,
   * returning workflow_state only when current state is ACTIVE and rejecting stale scope/credential.
   */
  readonly read_current_authority: (
    operation_id: string,
    principal: Omit<RawCaptureWorkflowPrincipal, "signal">,
  ) => Promise<RawCaptureWorkflowOwnerAuthoritySnapshot>;
}

export interface RawCaptureWorkflowOwnerPort {
  captureRawFile(request: RawFileCaptureRequest): Promise<RawFileCaptureResult>;
  readRawFileByIdempotency(idempotencyKey: string): Promise<RawFileCaptureResult | null>;
}

export interface RawCaptureWorkflowOwnerActorAuthority {
  readonly principal_ref: string;
  assertCurrent(): Promise<void>;
}

export type RawCaptureWorkflowOwnerOperations = RawCaptureWorkflowOwnerPort;

export function bindRawCaptureWorkflowOwnerOperations(
  input: RawCaptureWorkflowOwnerAuthorityInput,
  createOperations: (authority: RawCaptureWorkflowOwnerActorAuthority) => RawCaptureWorkflowOwnerOperations,
): RawCaptureWorkflowOwnerPort {
  const assertCurrent = async (): Promise<void> => {
    input.principal.signal?.throwIfAborted();
    const access = await input.read_current_authority(input.operation_id, {
      principal_ref: input.principal.principal_ref,
      credential_generation: input.principal.credential_generation,
      deployment_generation: input.principal.deployment_generation,
    });
    input.principal.signal?.throwIfAborted();
    if (access.workflow_state !== "ACTIVE" || access.client_class !== "owner_pwa" ||
        access.principal_ref !== input.principal.principal_ref ||
        access.credential_generation !== input.principal.credential_generation) {
      throw new RawCaptureError("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires current owner Workflow authority");
    }
  };
  const operations = createOperations({ principal_ref: input.principal.principal_ref, assertCurrent });
  return {
    async captureRawFile(request) {
      await assertCurrent();
      const result = await operations.captureRawFile(request);
      await assertCurrent();
      return result;
    },
    async readRawFileByIdempotency(idempotencyKey) {
      await assertCurrent();
      const result = await operations.readRawFileByIdempotency(idempotencyKey);
      await assertCurrent();
      return result;
    },
  };
}
