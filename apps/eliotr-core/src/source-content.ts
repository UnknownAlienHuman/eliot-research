import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalEvidenceJson, readSettledAdmittedNormalizedMarkdown } from "@eliotr/cloudflare-evidence";
import type { ProjectSourceContent } from "@eliotr/cloudflare-evidence";
import { catalogEligibility } from "./catalog-queries.js";
import { beginCatalogRead, CatalogInputError, validateRequestIdentifier } from "./catalog-service.js";
import type { Env } from "./env.js";

export type { ProjectSourceContent } from "@eliotr/cloudflare-evidence";

/** Owner document reading is independent of search projections and citation handles. */
export async function readSourceContent(
  env: Pick<Env, "CORE_DB" | "EVIDENCE_BUCKET" | "DEPLOYMENT_GENERATION">,
  context: AuthenticatedRequestContext,
  sourceRevisionRef: string,
  now: () => number = Date.now,
): Promise<Response> {
  const revision = validateRequestIdentifier(sourceRevisionRef, "source revision");
  const fence = await beginCatalogRead(env.CORE_DB, context, env.DEPLOYMENT_GENERATION, now);
  await fence.authority.requireReadPolicy();
  const eligible = await env.CORE_DB.prepare(`${catalogEligibility()}
    SELECT source_revision_ref FROM eligible WHERE source_revision_ref=?3 LIMIT 1`)
    .bind(context.principal_ref, new Date(fence.started).toISOString(), revision)
    .first<{ source_revision_ref: string }>();
  if (eligible?.source_revision_ref !== revision) {
    throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "The current document is not available", 404);
  }
  const [source] = await fence.authority.sources([revision]);
  if (source === undefined) {
    throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "The current document is not available", 404);
  }
  // The evidence package performs the bounded R2 read and then invokes this Core-owned D1 authority recheck.
  const content = await readSettledAdmittedNormalizedMarkdown(env.EVIDENCE_BUCKET, source.authority, async () => {
    const [settled] = await fence.authority.sources([revision]);
    if (settled === undefined || canonicalEvidenceJson(settled) !== canonicalEvidenceJson(source)) {
      throw new CatalogInputError("DOCUMENT_AUTHORITY_CHANGED", "The document changed; refresh the source", 409, true);
    }
  });
  await fence.finish();
  return new Response(content.bytes.slice().buffer, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(content.size_bytes),
      "cache-control": "no-store, no-transform",
      "x-content-type-options": "nosniff",
      "x-eliotr-source-revision": revision,
      "x-eliotr-content-sha256": content.readback_sha256,
      "x-eliotr-deployment-generation": env.DEPLOYMENT_GENERATION,
    },
  });
}

/** Read an exact currently authorized project member revision, including retained history.
 * This deliberately uses D1 owner/read-policy and R2 admission authority only; Search readiness
 * or projection state is not evidence that source bytes are available or authorized.
 */
export async function readProjectSourceContent(
  env: Pick<Env, "CORE_DB" | "EVIDENCE_BUCKET" | "DEPLOYMENT_GENERATION">,
  context: AuthenticatedRequestContext,
  projectId: string,
  sourceRevisionRef: string,
  now: () => number = Date.now,
): Promise<ProjectSourceContent> {
  if (context.client_class !== "owner_pwa") {
    throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "The current document is not available", 404);
  }
  const project = validateRequestIdentifier(projectId, "project_id");
  const revision = validateRequestIdentifier(sourceRevisionRef, "source revision");
  const fence = await beginCatalogRead(env.CORE_DB, context, env.DEPLOYMENT_GENERATION, now, project);
  await fence.authority.requireReadPolicy();
  const observed = new Date(fence.started).toISOString();
  interface MembershipRow {
    readonly source_id: string;
    readonly source_revision_ref: string;
    readonly project_generation: number;
    readonly membership_generation: number;
    readonly role: string;
    readonly valid_from: string;
    readonly valid_to: string | null;
  }
  const membershipQuery = `${catalogEligibility(true)}
    SELECT e.source_id, e.source_revision_ref, p.generation AS project_generation,
      m.membership_generation, m.role, m.valid_from, m.valid_to
    FROM eligible e JOIN project_source_membership m ON m.source_id=e.source_id AND m.project_id=?4
      AND julianday(m.valid_from)<=julianday(?2)
      AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?2))
    JOIN project p ON p.project_id=m.project_id
    WHERE e.source_revision_ref=?3 LIMIT 1`;
  const readMembership = () => env.CORE_DB.prepare(membershipQuery)
    .bind(context.principal_ref, observed, revision, project)
    .first<MembershipRow>();
  const membership = await readMembership();
  if (membership?.source_revision_ref !== revision) {
    throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "The current document is not available", 404);
  }
  const [source] = await fence.authority.sources([revision]);
  if (source === undefined || source.authority.source_id !== membership.source_id ||
      source.revision.source_revision_ref !== revision) {
    throw new CatalogInputError("LIBRARY_SOURCE_NOT_FOUND", "The current document is not available", 404);
  }
  const content = await readSettledAdmittedNormalizedMarkdown(env.EVIDENCE_BUCKET, source.authority, async (readback) => {
    await fence.authority.requireReadPolicy();
    const [settled] = await fence.authority.sources([revision]);
    const settledMembership = await readMembership();
    if (settled === undefined || settledMembership?.source_id !== membership.source_id ||
        settledMembership.source_revision_ref !== revision ||
        canonicalEvidenceJson(settledMembership) !== canonicalEvidenceJson(membership) ||
        canonicalEvidenceJson(settled) !== canonicalEvidenceJson(source) ||
        readback.readback_sha256 !== source.revision.content_sha256) {
      throw new CatalogInputError("DOCUMENT_AUTHORITY_CHANGED", "The document changed; refresh the source", 409, true);
    }
  });
  await fence.finish();
  return {
    project_id: project,
    source_id: source.authority.source_id,
    source_revision_ref: revision,
    content_sha256: content.readback_sha256,
    bytes: content.bytes,
    size_bytes: content.size_bytes,
    context_sha256: fence.identity,
    authority_generation: fence.generation,
    observed_at: fence.started,
    expires_at: Math.min(fence.frontier, fence.started + 300_000),
  };
}
