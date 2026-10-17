import { IdentifierSchema, RESEARCH_REQUEST_MAX_BYTES } from "@eliotr/contracts";
import { ProjectGuideLanguageSchema, ProjectGuideRequestSchema } from "@eliotr/contracts/project-guide";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createOwnerProjectGuideService } from "./project-guide-composition.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { apiResult } from "./http.js";
import { HttpRequestError } from "./http-errors.js";
import type { Env } from "./env.js";

/** Register GET and POST /api/v1/research/projects/:project_id/guide as owner-only routes. */
export async function handleProjectGuideHttp(request: Request, env: Env, context: AuthenticatedRequestContext,
  projectId: string): Promise<Response> {
  if (!IdentifierSchema.safeParse(projectId).success || context.client_class !== "owner_pwa") {
    throw new HttpRequestError("PROJECT_GUIDE_OWNER_REQUIRED", 403, "An authenticated owned project is required");
  }
  const service = createOwnerProjectGuideService(env), url = new URL(request.url);
  if (request.method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "language") || url.searchParams.getAll("language").length !== 1) {
      throw new HttpRequestError("PROJECT_GUIDE_INPUT_INVALID", 400, "A guide language is required");
    }
    const language = ProjectGuideLanguageSchema.safeParse(url.searchParams.get("language"));
    if (!language.success) throw new HttpRequestError("PROJECT_GUIDE_INPUT_INVALID", 400, "Guide language is invalid");
    return apiResult(request, env, await service.read(context, projectId, language.data));
  }
  if (request.method !== "POST") throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Guide method is unsupported");
  if (url.search !== "" || request.headers.get("x-eliotr-csrf") !== "1") {
    throw new HttpRequestError("PROJECT_GUIDE_INPUT_INVALID", 400, "Guide ensure requires its protected owner request");
  }
  const parsed = ProjectGuideRequestSchema.safeParse(await readJsonBodyWithinBytes(request, RESEARCH_REQUEST_MAX_BYTES));
  if (!parsed.success) throw new HttpRequestError("PROJECT_GUIDE_INPUT_INVALID", 400, "Guide request is invalid");
  return apiResult(request, env, await service.ensure(context, projectId, parsed.data.language));
}
