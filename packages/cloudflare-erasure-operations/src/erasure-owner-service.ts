import type { ErasureReceipt, ErasureRequest, VersionedRef } from "@eliotr/contracts";
import {
  createErasureAdmissionPolicyStore,
} from "@eliotr/cloudflare-erasure";
import type {
  ErasureOperationsActor,
  ErasureOwnerService,
} from "./erasure-runtime.js";
import type { ErasureCoordinator } from "./erasure-coordinator.js";

export interface ErasureOwnerServiceInput {
  readonly database: D1Database;
  readonly permission_ref: VersionedRef;
  readonly coordinator: ErasureCoordinator;
}

/** Admission and coordinator behavior remain in the capability; Core supplies the authenticated actor. */
export function createErasureOwnerService(
  input: ErasureOwnerServiceInput,
): ErasureOwnerService {
  const admission = createErasureAdmissionPolicyStore({ database: input.database });
  const permissionRef = Object.freeze({
    id: input.permission_ref.id,
    revision: input.permission_ref.revision,
  });

  return Object.freeze({
    async execute(
      context: ErasureOperationsActor,
      request: ErasureRequest,
    ): Promise<ErasureReceipt> {
      const actor = Object.freeze({
        principal_ref: context.principal_ref,
        credential_generation: context.credential_generation,
      });
      const admittedRequest = await admission.admit(actor, permissionRef, request);
      return input.coordinator.execute(admittedRequest);
    },
  });
}
