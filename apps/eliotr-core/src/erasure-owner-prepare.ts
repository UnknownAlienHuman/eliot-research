import type {
  AuthenticatedRequestContext,
  OwnerErasurePreparation,
  OwnerErasurePreparationInput,
} from "@eliotr/interfaces";
import { ErasureAdmissionError } from "@eliotr/cloudflare-erasure";
import {
  prepareErasureForOwner as prepareErasureForOwnerInLibrary,
  type ErasureOperationsActor,
} from "@eliotr/cloudflare-erasure-operations";
import type { Env } from "./env.js";

export type ErasureOwnerPreparationInput = OwnerErasurePreparationInput;
export type ErasureOwnerPreparation = OwnerErasurePreparation;

export function prepareErasureForOwner(
  env: Env,
  context: AuthenticatedRequestContext,
  input: ErasureOwnerPreparationInput,
): Promise<ErasureOwnerPreparation> {
  if (context.client_class !== "owner_pwa") {
    throw new ErasureAdmissionError("ERASURE_PERMISSION_DENIED", "erasure preparation requires an owner session");
  }
  const actor: ErasureOperationsActor = Object.freeze({
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
  });
  return prepareErasureForOwnerInLibrary({ database: env.CORE_DB }, actor, input);
}
