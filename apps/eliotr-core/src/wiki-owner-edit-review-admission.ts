import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  admitWikiOwnerEditReview as admitWikiOwnerEditReviewInLibrary,
  type WikiOwnerEditReviewAdmissionResult,
} from "@eliotr/cloudflare-wiki/wiki-owner-edit-review-admission";
import type { Env } from "./env.js";
import { wikiRuntime, wikiVerifiedActor } from "./wiki-service.js";

export type { WikiOwnerEditReviewAdmissionResult };

export function admitWikiOwnerEditReview(
  env: Env,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<WikiOwnerEditReviewAdmissionResult | null> {
  return admitWikiOwnerEditReviewInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    proposalRef,
  );
}
