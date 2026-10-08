import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { EvidenceSourcePageError, readMcpSourcePage as readCapability } from "@eliotr/cloudflare-evidence";
import { CatalogInputError, decodeCatalogCursor, encodeCatalogCursor, validateRequestIdentifier } from "@eliotr/cloudflare-navigation";
import { readProjectSourceContent } from "./source-content.js";
import type { Env } from "./env.js";

export { MCP_SOURCE_PAGE_DEFAULT_BYTES, MCP_SOURCE_PAGE_MAX_BYTES } from "@eliotr/cloudflare-evidence";

/** Core keeps authentication/catalog authority and supplies only the exact admitted source readback. */
export async function readMcpSourcePage(
  env: Pick<Env, "CORE_DB" | "EVIDENCE_BUCKET" | "DEPLOYMENT_GENERATION">,
  context: AuthenticatedRequestContext,
  input: {
    readonly project_id: string;
    readonly source_revision_ref: string;
    readonly page_bytes?: number;
    readonly cursor?: string;
  },
  now: () => number = Date.now,
) {
  try {
    return await readCapability({
      readProjectSourceContent: (projectId, sourceRevisionRef) => readProjectSourceContent(env, context, projectId, sourceRevisionRef, now),
      validateRequestIdentifier,
      encodeCursor: encodeCatalogCursor,
      decodeCursor: decodeCatalogCursor,
    }, input);
  } catch (error) {
    if (error instanceof EvidenceSourcePageError) {
      throw new CatalogInputError(error.code, error.message, error.status, error.retryable);
    }
    throw error;
  }
}
