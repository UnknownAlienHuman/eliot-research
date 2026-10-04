import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  admitWikiOwnerReview as admitWikiOwnerReviewInLibrary,
  type WikiOwnerReviewAdmissionResult,
} from "@eliotr/cloudflare-wiki/wiki-review-admission";
import type { Env } from "./env.js";
import { wikiRuntime, wikiVerifiedActor } from "./wiki-service.js";

export type { WikiOwnerReviewAdmissionResult };

/** Core keeps the authenticated request boundary and adapts it to the Wiki capability. */
export function admitWikiOwnerReview(
  env: Env,
  context: AuthenticatedRequestContext,
  proposalRef: VersionedRef,
): Promise<WikiOwnerReviewAdmissionResult | null> {
  return admitWikiOwnerReviewInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    proposalRef,
  );
}
