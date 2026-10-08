import type { ErasureReceipt, ErasureRequest, VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ErasureAdmissionError } from "@eliotr/cloudflare-erasure";
import {
  createErasureOwnerService as createErasureOwnerServiceInLibrary,
  type ErasureOwnerService as ErasureOperationOwnerService,
} from "@eliotr/cloudflare-erasure-operations";
import { createConfiguredErasureCoordinator } from "./erasure-runtime.js";
import type { Env } from "./env.js";

export interface ErasureOwnerService {
  execute(context: AuthenticatedRequestContext, request: ErasureRequest): Promise<ErasureReceipt>;
}

export interface ErasureOwnerServiceInput {
  readonly env: Env;
  /** The server-owned policy revision to use for this owner operation. */
  readonly permission_ref: VersionedRef;
}

/** Keep owner-session authorization in Core and delegate admission/execution to the erasure capability. */
export function createErasureOwnerService(input: ErasureOwnerServiceInput): ErasureOwnerService {
  const operationService: ErasureOperationOwnerService = createErasureOwnerServiceInLibrary({
    database: input.env.CORE_DB,
    permission_ref: input.permission_ref,
    coordinator: createConfiguredErasureCoordinator(input.env),
  });
  return Object.freeze({
    async execute(context: AuthenticatedRequestContext, request: ErasureRequest): Promise<ErasureReceipt> {
      if (context.client_class !== "owner_pwa") {
        throw new ErasureAdmissionError("ERASURE_PERMISSION_DENIED", "erasure requires an owner session");
      }
      const actor = Object.freeze({
        principal_ref: context.principal_ref,
        credential_generation: context.credential_generation,
      });
      return operationService.execute(actor, request);
    },
  });
}
