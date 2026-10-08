import type { ArtifactRevision, VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  GENERATOR,
  proposeWikiFromResearchRun as proposeWikiFromResearchRunInLibrary,
  readDependencyManifest as readDependencyManifestInLibrary,
  readSection as readSectionInLibrary,
  requireFreshOwnerScope as requireFreshOwnerScopeInLibrary,
  type DependencyManifestRead,
  type SectionRead,
} from "@eliotr/cloudflare-wiki/wiki-proposal-from-research-run";
import type { WikiProposalResult } from "@eliotr/cloudflare-wiki/wiki-service";
import type { Env } from "./env.js";
import { wikiRuntime, wikiVerifiedActor } from "./wiki-service.js";

export { GENERATOR };
export type { DependencyManifestRead, SectionRead };

export function requireFreshOwnerScope(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
): Promise<void> {
  return requireFreshOwnerScopeInLibrary(wikiRuntime(env, context), wikiVerifiedActor(context), operationId);
}

export function readDependencyManifest(
  env: Pick<Env, "CORE_DB" | "WORK_BUCKET">,
  artifact: ArtifactRevision,
): Promise<DependencyManifestRead> {
  return readDependencyManifestInLibrary(
    { database: env.CORE_DB, work_bucket: env.WORK_BUCKET },
    artifact,
  );
}

export function readSection(
  env: Env,
  context: AuthenticatedRequestContext,
  artifact: ArtifactRevision,
  expectedScope: VersionedRef,
  section: ArtifactRevision["sections"][number],
): Promise<SectionRead> {
  return readSectionInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    artifact,
    expectedScope,
    section,
  );
}

export function proposeWikiFromResearchRun(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
  idempotencyKey: string,
): Promise<WikiProposalResult> {
  return proposeWikiFromResearchRunInLibrary(
    wikiRuntime(env, context),
    wikiVerifiedActor(context),
    operationId,
    idempotencyKey,
  );
}
