import type { RawFileCaptureRequest, RawFileCaptureResult } from "@eliotr/interfaces";
import { RawCaptureError, type RawCaptureReceipt } from "./raw-ingest-types.js";

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
  readonly deployment_generation?: string;
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

export interface RawCaptureWorkflowServerReadAuthoritySnapshot extends RawCaptureWorkflowOwnerAuthoritySnapshot {
  readonly deployment_generation: string;
}

export type RawCaptureWorkflowServerReadAuthorityInput =
  Omit<RawCaptureWorkflowOwnerAuthorityInput, "read_current_authority"> & {
    readonly read_current_authority: (
      operation_id: string,
      principal: Omit<RawCaptureWorkflowPrincipal, "signal">,
    ) => Promise<RawCaptureWorkflowServerReadAuthoritySnapshot>;
  };

export interface RawCaptureWorkflowOwnerPort {
  captureRawFile(request: RawFileCaptureRequest): Promise<RawFileCaptureResult>;
  readRawFileByIdempotency(idempotencyKey: string): Promise<RawFileCaptureResult | null>;
}

/** Full receipt readback is reserved for trusted server-side Workflow composition. */
export interface RawCaptureWorkflowServerReadPort {
  readRawCaptureForServer(captureId: string): Promise<RawCaptureReceipt | null>;
}

export type RawCaptureWorkflowOwnerServerReadPort =
  RawCaptureWorkflowOwnerPort & RawCaptureWorkflowServerReadPort;

export interface RawCaptureWorkflowOwnerActorAuthority {
  readonly principal_ref: string;
  assertCurrent(): Promise<void>;
}

/** Existing public owner operations remain the two-method sanitized port. */
export type RawCaptureWorkflowOwnerOperations = RawCaptureWorkflowOwnerPort;

function createWorkflowOwnerActorAuthority(
  input: RawCaptureWorkflowOwnerAuthorityInput,
  requireDeploymentGeneration: boolean,
): RawCaptureWorkflowOwnerActorAuthority {
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
        access.credential_generation !== input.principal.credential_generation ||
        (requireDeploymentGeneration &&
          access.deployment_generation !== input.principal.deployment_generation)) {
      throw new RawCaptureError("RAW_CAPTURE_OWNER_NOT_CURRENT", "raw capture requires current owner Workflow authority");
    }
  };
  return { principal_ref: input.principal.principal_ref, assertCurrent };
}

function bindWorkflowOwnerOperations(
  operations: RawCaptureWorkflowOwnerOperations,
  authority: RawCaptureWorkflowOwnerActorAuthority,
): RawCaptureWorkflowOwnerPort {
  return {
    async captureRawFile(request) {
      await authority.assertCurrent();
      const result = await operations.captureRawFile(request);
      await authority.assertCurrent();
      return result;
    },
    async readRawFileByIdempotency(idempotencyKey) {
      await authority.assertCurrent();
      const result = await operations.readRawFileByIdempotency(idempotencyKey);
      await authority.assertCurrent();
      return result;
    },
  };
}

/** Public Workflow owner port returns only the sanitized receipt. */
export function bindRawCaptureWorkflowOwnerOperations(
  input: RawCaptureWorkflowOwnerAuthorityInput,
  createOperations: (authority: RawCaptureWorkflowOwnerActorAuthority) => RawCaptureWorkflowOwnerOperations,
): RawCaptureWorkflowOwnerPort {
  const authority = createWorkflowOwnerActorAuthority(input, false);
  return bindWorkflowOwnerOperations(createOperations(authority), authority);
}

/** Server-only Workflow readback requires and rechecks the exact deployment generation. */
export function bindRawCaptureWorkflowServerReadOperations(
  input: RawCaptureWorkflowServerReadAuthorityInput,
  createOperations: (authority: RawCaptureWorkflowOwnerActorAuthority) => RawCaptureWorkflowOwnerServerReadPort,
): RawCaptureWorkflowOwnerServerReadPort {
  const authority = createWorkflowOwnerActorAuthority(input, true);
  const operations = createOperations(authority);
  const ownerOperations = bindWorkflowOwnerOperations(operations, authority);
  return {
    ...ownerOperations,
    async readRawCaptureForServer(captureId) {
      await authority.assertCurrent();
      const receipt = await operations.readRawCaptureForServer(captureId);
      await authority.assertCurrent();
      return receipt;
    },
  };
}
