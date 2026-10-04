import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  proposeWikiFromOwnerEdit as proposeWikiFromOwnerEditInLibrary,
  readCanonicalBase as readCanonicalBaseInLibrary,
  type CanonicalBase,
  type OwnerEditInput,
} from "@eliotr/cloudflare-wiki/wiki-owner-edit-proposal";
import type { WikiProposalResult } from "@eliotr/cloudflare-wiki/wiki-service";
import type { Env } from "./env.js";
import { wikiRuntime, wikiVerifiedActor } from "./wiki-service.js";

export {
  WIKI_OWNER_EDIT_EVIDENCE_PROTOCOL,
  WIKI_OWNER_EDIT_GENERATOR,
  WIKI_OWNER_EDIT_PROTOCOL,
  loadEditBinding,
  loadProposalByIdempotency,
  loadPublishedRevision,
  parseEditEvidenceObject,
  parseInput,
  parseMetadata,
  sameProposalPage,
  validateEditEvidence,
  validateEditProposalRow,
  verifyBinding,
} from "@eliotr/cloudflare-wiki/wiki-owner-edit-proposal";
export type {
  CanonicalBase,
  EditBindingRow,
  EditMetadata,
  OwnerEditInput,
  PublishedRevisionRow,
} from "@eliotr/cloudflare-wiki/wiki-owner-edit-proposal";

export function readCanonicalBase(
  env: Env,
  context: AuthenticatedRequestContext,
  input: OwnerEditInput,
  idempotencyKey: string,
): Promise<CanonicalBase> {
  return readCanonicalBaseInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    input,
    idempotencyKey,
  );
}

export function proposeWikiFromOwnerEdit(
  env: Env,
  context: AuthenticatedRequestContext,
  raw: unknown,
  idempotencyKey: string,
): Promise<WikiProposalResult> {
  return proposeWikiFromOwnerEditInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    raw,
    idempotencyKey,
  );
}
