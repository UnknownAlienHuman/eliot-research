import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  readProjectSourceContentFromCatalog,
  readSourceContentFromCatalog,
} from "@eliotr/cloudflare-navigation";
import type { ProjectSourceContent } from "@eliotr/cloudflare-evidence";
import type { Env } from "./env.js";

export type { ProjectSourceContent } from "@eliotr/cloudflare-evidence";

/** Compatibility adapter: Navigation owns the catalog fence and Evidence byte read. */
export async function readSourceContent(
  env: Pick<Env, "CORE_DB" | "EVIDENCE_BUCKET" | "DEPLOYMENT_GENERATION">,
  context: AuthenticatedRequestContext,
  sourceRevisionRef: string,
  now: () => number = Date.now,
): Promise<Response> {
  return readSourceContentFromCatalog(env, context, sourceRevisionRef, now);
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
  return readProjectSourceContentFromCatalog(env, context, projectId, sourceRevisionRef, now);
}
