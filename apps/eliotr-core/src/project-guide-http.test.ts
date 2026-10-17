import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROUTES } from "@eliotr/interfaces";
import { RESEARCH_REQUEST_MAX_BYTES } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { handleProjectGuideHttp } from "./project-guide-http.js";

const service = vi.hoisted(() => ({ read: vi.fn(), ensure: vi.fn() }));
vi.mock("./project-guide-composition.js", () => ({ createOwnerProjectGuideService: () => service }));
vi.mock("./http.js", () => ({ apiResult: (_request: Request, _env: unknown, data: unknown) => Response.json(data) }));
vi.mock("./http-errors.js", async () => await import("@eliotr/cloudflare-http-protocol/http-request-error.js"));
const actor = { client_class: "owner_pwa", principal_ref: "owner", credential_generation: "credential" } as AuthenticatedRequestContext;
beforeEach(() => { service.read.mockReset(); service.ensure.mockReset(); service.read.mockResolvedValue({ state: "EMPTY" }); service.ensure.mockResolvedValue({ state: "EMPTY" }); });
describe("registered project-guide owner routes", () => {
  it("registers only owner GET/POST guide operations with the inherited request envelope", () => {
    expect(ROUTES.filter(route => route.path === "/api/v1/research/projects/:project_id/guide").map(route => ({
      method: route.method, auth: route.auth, bound: route.maximum_request_bytes,
    }))).toEqual([{ method: "GET", auth: "owner", bound: 0 }, { method: "POST", auth: "owner", bound: RESEARCH_REQUEST_MAX_BYTES }]);
  });
  it("GET remains read-only; only protected POST enters ensure", async () => {
    await handleProjectGuideHttp(new Request("https://owner.invalid/api/v1/research/projects/project/guide?language=en"), {} as Env, actor, "project");
    expect(service.read).toHaveBeenCalledWith(actor, "project", "en"); expect(service.ensure).not.toHaveBeenCalled();
    const request = new Request("https://owner.invalid/api/v1/research/projects/project/guide", { method: "POST",
      headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
      body: JSON.stringify({ protocol: "eliotr.project-guide.v1", language: "en" }) });
    await handleProjectGuideHttp(request, {} as Env, actor, "project");
    expect(service.ensure).toHaveBeenCalledWith(actor, "project", "en");
  });
  it("refuses non-owners and caller-supplied generation controls before admission", async () => {
    await expect(handleProjectGuideHttp(new Request("https://owner.invalid/?language=en"), {} as Env,
      { ...actor, client_class: "trusted_agent" }, "project")).rejects.toMatchObject({ code: "PROJECT_GUIDE_OWNER_REQUIRED" });
    const request = new Request("https://owner.invalid/guide", { method: "POST",
      headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
      body: JSON.stringify({ protocol: "eliotr.project-guide.v1", language: "en", provider_id: "override" }) });
    await expect(handleProjectGuideHttp(request, {} as Env, actor, "project")).rejects.toMatchObject({ code: "PROJECT_GUIDE_INPUT_INVALID" });
    expect(service.ensure).not.toHaveBeenCalled();
  });
});
