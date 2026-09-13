import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalEvidenceJson, readAdmittedNormalizedMarkdown } from "@eliotr/cloudflare-evidence";
import { catalogEligibility } from "./catalog-queries.js";
import { beginCatalogRead, CatalogInputError, validateRequestIdentifier } from "./catalog-service.js";
import type { Env } from "./env.js";

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
  const content = await readAdmittedNormalizedMarkdown(env.EVIDENCE_BUCKET, source.authority);
  // Re-read owner policy, admission and source authority after the bounded R2 read.
  // The catalog fence additionally detects head changes, revocation and time expiry.
  const [settled] = await fence.authority.sources([revision]);
  if (settled === undefined || canonicalEvidenceJson(settled) !== canonicalEvidenceJson(source)) {
    throw new CatalogInputError("DOCUMENT_AUTHORITY_CHANGED", "The document changed; refresh the source", 409, true);
  }
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
