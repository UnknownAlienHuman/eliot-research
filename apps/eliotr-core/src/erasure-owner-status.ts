import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, OwnerErasureStatus } from "@eliotr/interfaces";
import { ErasureAdmissionError } from "@eliotr/cloudflare-erasure";
import {
  readErasureOwnerStatus as readErasureOwnerStatusInLibrary,
  type ErasureOperationsActor,
} from "@eliotr/cloudflare-erasure-operations";
import type { Env } from "./env.js";

export function readErasureOwnerStatus(
  env: Env,
  context: AuthenticatedRequestContext,
  erasureRef: VersionedRef,
): Promise<OwnerErasureStatus | null> {
  if (context.client_class !== "owner_pwa") {
    throw new ErasureAdmissionError("ERASURE_PERMISSION_DENIED", "erasure status requires an owner session");
  }
  const actor: ErasureOperationsActor = Object.freeze({
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
  });
  return readErasureOwnerStatusInLibrary({ database: env.CORE_DB }, actor, erasureRef);
}
