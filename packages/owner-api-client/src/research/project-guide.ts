import { IdentifierSchema } from "@eliotr/contracts";
import { PROJECT_GUIDE_PROTOCOL, ProjectGuideLanguageSchema, ProjectGuideViewSchema,
  type ProjectGuideLanguage, type ProjectGuideView } from "@eliotr/contracts/project-guide";
import type { LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http.js";
import type { EpochPort } from "../transport/client.js";
export type { ProjectGuideLanguage, ProjectGuideView } from "@eliotr/contracts/project-guide";

export interface ProjectGuideApi {
  read(project: string, language: ProjectGuideLanguage, generation: string, signal?: AbortSignal): Promise<ProjectGuideView>;
  ensure(project: string, language: ProjectGuideLanguage, generation: string, signal?: AbortSignal): Promise<ProjectGuideView>;
}
export function createProjectGuideApi(http: Pick<LegacyHttpAdapter, "requestApiWithStatuses">,
  errors: LegacyErrorFactory, epoch: EpochPort): ProjectGuideApi {
  function fail(code: string, status: number): never {
    throw errors({ code, status, message: "Project guide could not be read", traceId: null, retryable: false });
  }
  async function call(project: string, language: ProjectGuideLanguage, generation: string, ensure: boolean, signal?: AbortSignal) {
    if (!IdentifierSchema.safeParse(project).success || !IdentifierSchema.safeParse(generation).success ||
        !ProjectGuideLanguageSchema.safeParse(language).success) fail("PROJECT_GUIDE_INPUT_INVALID", 400);
    const captured = epoch.capture();
    const current = () => { if (captured === undefined || !epoch.isCurrent(captured) || signal?.aborted) fail("API_SESSION_CLOSED", 503); };
    current();
    const path = `/api/v1/research/projects/${encodeURIComponent(project)}/guide`;
    const raw = await http.requestApiWithStatuses(ensure ? path : `${path}?language=${language}`, {
      method: ensure ? "POST" : "GET", ...(signal === undefined ? {} : { signal }),
      ...(ensure ? { headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
        body: JSON.stringify({ protocol: PROJECT_GUIDE_PROTOCOL, language }) } : {}),
    }, [200]);
    current();
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("API_RESPONSE_SCHEMA_MISMATCH", 502);
    const envelope = raw as Record<string, unknown>;
    if (Object.keys(envelope).sort().join(",") !== "data,deployment_generation,trace_id" ||
        !IdentifierSchema.safeParse(envelope.deployment_generation).success ||
        typeof envelope.trace_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(envelope.trace_id)) {
      fail("API_RESPONSE_SCHEMA_MISMATCH", 502);
    }
    if (ensure && envelope.deployment_generation !== generation) fail("API_GENERATION_MISMATCH", 409);
    const parsed = ProjectGuideViewSchema.safeParse(envelope.data);
    if (!parsed.success || parsed.data.project_id !== project || parsed.data.language !== language) fail("API_RESPONSE_SCHEMA_MISMATCH", 502);
    current(); return parsed.data;
  }
  return { read: (p, l, g, s) => call(p, l, g, false, s), ensure: (p, l, g, s) => call(p, l, g, true, s) };
}
