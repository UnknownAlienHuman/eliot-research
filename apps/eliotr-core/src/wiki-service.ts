import type { SemanticApi, WikiProposalListResult, WikiProposalReadResult } from "@eliotr/interfaces";
import type { VersionedRef } from "@eliotr/contracts";
import {
  listProposals,
  parseWikiProposalFromResearchRunRequest,
  parseWikiProposalRef,
  proposeWiki,
  publishWikiProposal as publishWikiProposalInLibrary,
  readProposal,
  readProposalBody,
  WIKI_PROPOSAL_LIST_PROTOCOL,
  WIKI_PROPOSAL_PROTOCOL,
  WIKI_PROPOSAL_READ_PROTOCOL,
  WIKI_PUBLICATION_PROTOCOL,
  type WikiProposalResult,
  type WikiPublicationResult,
  type WikiRuntime,
  type WikiStorageRuntime,
  type WikiVerifiedActor,
} from "@eliotr/cloudflare-wiki";
import { CatalogInputError } from "./catalog-service.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import {
  reopenOwnerArtifactDraft,
  reopenOwnerArtifactSectionCitations,
} from "./research-artifact-reauthorization-http.js";

export {
  parseWikiProposalFromResearchRunRequest,
  parseWikiProposalRef,
  WIKI_PROPOSAL_LIST_PROTOCOL,
  WIKI_PROPOSAL_PROTOCOL,
  WIKI_PROPOSAL_READ_PROTOCOL,
  WIKI_PUBLICATION_PROTOCOL,
};
export type { WikiProposalResult, WikiPublicationResult };

/** Pass only the authenticated actor fields into the capability library. */
export function wikiVerifiedActor(context: AuthenticatedRequestContext): WikiVerifiedActor {
  return Object.freeze({
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  });
}

/** Adapt Cloudflare bindings and Core-owned reauthorization callbacks for one authenticated request. */
export function wikiRuntime(
  env: Env,
  context: AuthenticatedRequestContext,
): WikiRuntime {
  return Object.freeze({
    database: env.CORE_DB,
    work_bucket: env.WORK_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    request_signal: context.request.signal,
    reopen_owner_artifact_draft: (artifactRef: VersionedRef, sectionRef?: VersionedRef) =>
      reopenOwnerArtifactDraft(env, context, artifactRef, sectionRef),
    reopen_owner_artifact_section_citations: (artifactRef: VersionedRef, sectionRef: VersionedRef) =>
      reopenOwnerArtifactSectionCitations(env, context, artifactRef, sectionRef),
  });
}

function wikiStorageRuntime(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
): WikiStorageRuntime {
  return Object.freeze({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET });
}

/** HTTP idempotency remains owned by the authenticated Core request boundary. */
export function requireWikiIdempotencyKey(context: AuthenticatedRequestContext): string {
  const value = context.request.headers.get("idempotency-key");
  if (value === null || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new CatalogInputError("WIKI_INPUT_INVALID", "idempotency-key header is required");
  }
  return value;
}

export function createWikiProposalReaderService(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
): Pick<SemanticApi, "readWikiProposal" | "listWikiProposals" | "readWikiProposalBody"> {
  const runtime = wikiStorageRuntime(env);
  return {
    readWikiProposal: (context, proposalRef): Promise<WikiProposalReadResult> =>
      readProposal(runtime, wikiVerifiedActor(context), proposalRef),
    listWikiProposals: (context): Promise<WikiProposalListResult> =>
      listProposals(runtime, wikiVerifiedActor(context)),
    readWikiProposalBody: (context, proposalRef) =>
      readProposalBody(runtime, wikiVerifiedActor(context), proposalRef),
  };
}

export function createWikiProposalService(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
): SemanticApi["proposeWiki"] {
  const runtime = wikiStorageRuntime(env);
  return (context, raw) => proposeWiki(
    runtime,
    wikiVerifiedActor(context),
    raw,
    requireWikiIdempotencyKey(context),
  );
}

/** Owner/manual review path; auth and request access remain in this Core facade. */
export async function publishWikiProposal(
  env: Env,
  context: AuthenticatedRequestContext,
  raw: unknown,
): Promise<WikiPublicationResult> {
  return publishWikiProposalInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    raw,
    requireWikiIdempotencyKey(context),
  );
}