import { describe, expect, it, vi } from "vitest";
import { createProjectGuideApi } from "./project-guide.js";
import { PROJECT_GUIDE_PROTOCOL, type ProjectGuideView } from "@eliotr/contracts/project-guide";

const missing: ProjectGuideView = { protocol: PROJECT_GUIDE_PROTOCOL, project_id: "project", language: "en", state: "MISSING",
  corpus_digest: "a".repeat(64), identity_digest: "b".repeat(64), source_count: 2,
  workflow_instance_id: null, artifact_ref: null, guide: null, reason_code: null };
function fixture(data: unknown = missing, generation = "deployment") {
  let active = true; const token = {};
  const request = vi.fn(async (_path: string, _init?: RequestInit, _statuses?: readonly number[]) =>
    ({ data, trace_id: "trace-1", deployment_generation: generation }));
  const api = createProjectGuideApi({ requestApiWithStatuses: request }, details => Object.assign(new Error(details.message), details),
    { capture: () => active ? token : undefined, isCurrent: value => active && value === token });
  return { api, request, close: () => { active = false; } };
}
describe("owner project guide transport", () => {
  it("reads authorized guide metadata across compatible deployments but fences ensure mutations", async () => {
    const f = fixture(missing, "new-deployment");
    expect((await f.api.read("project", "en", "old-deployment")).state).toBe("MISSING");
    await expect(f.api.ensure("project", "en", "old-deployment")).rejects.toMatchObject({ code: "API_GENERATION_MISMATCH" });
    expect(f.request.mock.calls[0]?.[0]).toBe("/api/v1/research/projects/project/guide?language=en");
  });
  it("uses protected POST ensure without provider, budget, byte or scope overrides", async () => {
    const f = fixture(); await f.api.ensure("project", "en", "deployment");
    const [, init] = f.request.mock.calls[0] ?? [];
    expect(init).toMatchObject({ method: "POST", headers: { "x-eliotr-csrf": "1" } });
    expect(JSON.parse(String(init?.body))).toEqual({ protocol: PROJECT_GUIDE_PROTOCOL, language: "en" });
  });
  it("rejects wrong project identities, unknown wire fields and stale owner responses", async () => {
    for (const invalid of [{ ...missing, project_id: "other" }, { ...missing, extra: true }]) {
      await expect(fixture(invalid).api.read("project", "en", "deployment")).rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    }
    const f = fixture(); f.close();
    await expect(f.api.ensure("project", "en", "deployment")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
