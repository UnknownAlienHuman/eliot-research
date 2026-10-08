import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  readOwnerEditReviewProof as readOwnerEditReviewProofInLibrary,
  type OwnerEditReviewProof,
} from "@eliotr/cloudflare-wiki/wiki-owner-edit-review-proof";
import type { Env } from "./env.js";
import { wikiRuntime, wikiVerifiedActor } from "./wiki-service.js";

export type { OwnerEditReviewProof };

export function readOwnerEditReviewProof(
  env: Env,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<OwnerEditReviewProof> {
  return readOwnerEditReviewProofInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    proposalRef,
  );
}
