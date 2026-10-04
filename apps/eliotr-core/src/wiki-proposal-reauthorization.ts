import type { ScopeSnapshot, VersionedRef, WikiPageRevision } from "@eliotr/contracts";
import type { EvidenceAccessContext } from "@eliotr/cloudflare-evidence";
import {
  prepareOwnerScopeHistoricalReadAuthorization as prepareOwnerScopeHistoricalReadAuthorizationInLibrary,
  prepareOwnerScopeReadAuthorization as prepareOwnerScopeReadAuthorizationInLibrary,
  prepareOwnerScopeReauthorization as prepareOwnerScopeReauthorizationInLibrary,
  prepareWikiProposalHistoricalReadAuthorization as prepareWikiProposalHistoricalReadAuthorizationInLibrary,
  prepareWikiProposalReadAuthorization as prepareWikiProposalReadAuthorizationInLibrary,
  prepareWikiProposalReauthorization as prepareWikiProposalReauthorizationInLibrary,
  type WikiProposalReadAuthorization,
} from "@eliotr/cloudflare-wiki/wiki-proposal-reauthorization";
import type { WikiDatabaseRuntime, WikiVerifiedActor } from "@eliotr/cloudflare-wiki/wiki-runtime";
import type { Env } from "./env.js";

export type { WikiProposalReadAuthorization };

function runtime(env: Pick<Env, "CORE_DB">): WikiDatabaseRuntime {
  return { database: env.CORE_DB };
}

function verifiedActor(context: EvidenceAccessContext): WikiVerifiedActor {
  return {
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
  };
}

export function prepareOwnerScopeReauthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
): Promise<WikiProposalReadAuthorization> {
  return prepareOwnerScopeReauthorizationInLibrary(runtime(env), verifiedActor(context), scopeRef);
}

export function prepareWikiProposalReauthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  page: WikiPageRevision,
): Promise<WikiProposalReadAuthorization> {
  return prepareWikiProposalReauthorizationInLibrary(runtime(env), verifiedActor(context), page);
}

export function prepareOwnerScopeReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
): Promise<WikiProposalReadAuthorization> {
  return prepareOwnerScopeReadAuthorizationInLibrary(runtime(env), verifiedActor(context), scopeRef);
}

export function prepareOwnerScopeHistoricalReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  scopeRef: VersionedRef,
): Promise<WikiProposalReadAuthorization> {
  return prepareOwnerScopeHistoricalReadAuthorizationInLibrary(runtime(env), verifiedActor(context), scopeRef);
}

export function prepareWikiProposalReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  page: WikiPageRevision,
): Promise<WikiProposalReadAuthorization> {
  return prepareWikiProposalReadAuthorizationInLibrary(runtime(env), verifiedActor(context), page);
}

export function prepareWikiProposalHistoricalReadAuthorization(
  env: Pick<Env, "CORE_DB">,
  context: EvidenceAccessContext,
  page: WikiPageRevision,
): Promise<WikiProposalReadAuthorization> {
  return prepareWikiProposalHistoricalReadAuthorizationInLibrary(runtime(env), verifiedActor(context), page);
}

export type { ScopeSnapshot };
