import type { ErasureReceipt, ErasureRequest, VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createErasureAdmissionPolicyStore,
  ErasureAdmissionError,
} from "@eliotr/cloudflare-erasure";
import type { Env } from "./env.js";
import { createConfiguredErasureCoordinator } from "./erasure-runtime.js";

export interface ErasureOwnerService {
  execute(
    context: AuthenticatedRequestContext,
    request: ErasureRequest,
  ): Promise<ErasureReceipt>;
}

export interface ErasureOwnerServiceInput {
  readonly env: Env;
  /** The server-owned policy revision to use for this owner operation. */
  readonly permission_ref: VersionedRef;
}

/**
 * Build the owner-only erasure application bridge.
 *
 * Admission performs the durable permission readback and admission replay
 * checks. The configured coordinator remains the sole owner of erasure
 * effects, closure, and terminal receipt persistence.
 */
export function createErasureOwnerService(
  input: ErasureOwnerServiceInput,
): ErasureOwnerService {
  const admission = createErasureAdmissionPolicyStore({ database: input.env.CORE_DB });
  const coordinator = createConfiguredErasureCoordinator(input.env);
  const permissionRef = Object.freeze({
    id: input.permission_ref.id,
    revision: input.permission_ref.revision,
  });

  return Object.freeze({
    async execute(
      context: AuthenticatedRequestContext,
      request: ErasureRequest,
    ): Promise<ErasureReceipt> {
      if (context.client_class !== "owner_pwa") {
        throw new ErasureAdmissionError(
          "ERASURE_PERMISSION_DENIED",
          "erasure requires an owner session",
        );
      }

      // Capture the authenticated identity before the first await. Admission
      // re-reads the durable policy and source ownership for this identity.
      const actor = Object.freeze({
        principal_ref: context.principal_ref,
        credential_generation: context.credential_generation,
      });
      const admittedRequest = await admission.admit(actor, permissionRef, request);
      return coordinator.execute(admittedRequest);
    },
  });
}
