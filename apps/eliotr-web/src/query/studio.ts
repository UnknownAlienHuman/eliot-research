/**
 * Studio query owns remote Wiki proposal and publication state. It reads only.
 *
 * The already composed runtime APIs are consumed as they are: no factory, privacy type, epoch or
 * query client is created here, and no decoder is copied. Starting a proposal, minting intent and
 * publishing stay with the root controller.
 *
 * Every body read is fenced on the exact proposal view the caller holds. `currentProposal` must
 * return that same view before and after the read, so a stale holder, a swapped proposal or a
 * foreign page can never be presented as the requested body.
 */
import { queryOptions } from "@tanstack/react-query";
import type { VersionedRef, WikiProposalReadView } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

export interface StudioQueryApis {
  readonly read: BoundWorkspaceApis["studio"]["read"];
  readonly artifact: BoundWorkspaceApis["studio"]["artifact"];
}

export function studioQueryOptions(
  apis: StudioQueryApis,
  privacy: PrivacyController,
  context: SessionContext,
  currentProposal: () => WikiProposalReadView | undefined,
) {
  const generation = context.deploymentGeneration;
  const key = protectedQueryKey(context, "studio");

  return {
    proposals() {
      return queryOptions({
        queryKey: [...key, "proposals"],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
          readSignal => apis.read.readWikiProposals(generation, readSignal)),
      });
    },

    proposal(ref: VersionedRef) {
      return queryOptions({
        queryKey: [...key, "proposal", "full", ref.id, ref.revision],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
          readSignal => apis.read.readWikiProposal(ref, generation, readSignal)),
      });
    },

    body(view: WikiProposalReadView) {
      const page = view.page;
      return queryOptions({
        queryKey: [...key, "body", "full", view.proposal_ref.id, view.proposal_ref.revision,
          page.page_ref.id, page.page_ref.revision, page.body_object_ref, page.body_sha256],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          // Object identity, not id equality: the holder must still be the very view requested.
          const held = currentProposal();
          if (held !== view) throw new Error("Studio body read requires the exact current proposal");
          const value = await apis.read.readWikiProposalBody(
            held.proposal_ref,
            page.page_ref,
            page.body_sha256,
            generation,
            readSignal,
          );
          // Re-check after the await: a swap during the request must not adopt this body.
          if (currentProposal() !== view) {
            throw new Error("Studio proposal changed during the body read");
          }
          return value;
        }),
      });
    },

    publication(artifactRef: VersionedRef) {
      return queryOptions({
        queryKey: [...key, "publication", "full", artifactRef.id, artifactRef.revision],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
          async readSignal => apis.artifact.readArtifactPublication(artifactRef, generation, readSignal)),
      });
    },
  };
}

/** The truthful continuation note the panel shows when the server reports more proposals. */
export const STUDIO_PROPOSALS_MORE_NOTE =
  "More proposals exist only the first page is available.";
