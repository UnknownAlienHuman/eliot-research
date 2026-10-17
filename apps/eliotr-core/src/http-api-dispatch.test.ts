import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext, ApplicationLifecycle } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { dispatchHttpApiRoute, parseResearchMethodReadinessQuery, type HttpRouteMatch } from "./http-api-dispatch.js";

const f = vi.hoisted(() => ({ legacy: vi.fn(), method: vi.fn() }));

vi.mock("./research-project-configuration-composition.js", () => ({
  readOwnerProjectResearchReadiness: f.legacy,
  readOwnerProjectResearchMethodReadiness: f.method,
}));

const projectId = "project-1";
const pin = Object.freeze({ configuration_project_id: projectId,
  configuration_ref: `rpmc-${"a".repeat(64)}`, configuration_sha256: "b".repeat(64), selection_revision: 3 });
const routeMatch = { route: { operation: "system.research.configuration" }, params: {} } as unknown as HttpRouteMatch;
const env = { DEPLOYMENT_GENERATION: "deployment-1" } as unknown as Env;
const context = { principal_ref: "owner-1" } as unknown as AuthenticatedRequestContext;

function requestFor(query: string): Request {
  return new Request(`https://owner.invalid/api/v1/system/research-configuration${query}`);
}

async function dispatch(query: string): Promise<Response> {
  const request = requestFor(query);
  return dispatchHttpApiRoute(request, env, {} as ApplicationLifecycle, context, routeMatch, new URL(request.url));
}

describe("research method readiness HTTP opt-in", () => {
  beforeEach(() => {
    f.legacy.mockReset().mockResolvedValue({ protocol: "eliotr.research-configuration-readiness.v1" });
    f.method.mockReset().mockResolvedValue({ protocol: "eliotr.research-configuration-method-readiness.v1",
      project_id: projectId, selected_pin: pin, evidence_review_ready: false,
      evidence_review_handler_generation: null, evidence_review_unavailable_reason: "MODEL_READINESS_UNAVAILABLE",
      checked_at: "2026-10-17T12:00:00.000Z" });
  });

  it("preserves the legacy V1 response when the opt-in capability is absent", async () => {
    const response = await dispatch(`?project_id=${projectId}`);
    const body = await response.json() as { data: { protocol: string } };
    expect(response.status).toBe(200);
    expect(body.data.protocol).toBe("eliotr.research-configuration-readiness.v1");
    expect(f.legacy).toHaveBeenCalledExactlyOnceWith(env, context, projectId);
    expect(f.method).not.toHaveBeenCalled();
  });

  it("dispatches the exact opt-in pin to method readiness", async () => {
    const response = await dispatch(`?project_id=${projectId}&capability=research-methods-v1` +
      `&configuration_project_id=${pin.configuration_project_id}&configuration_ref=${pin.configuration_ref}` +
      `&configuration_sha256=${pin.configuration_sha256}&selection_revision=3`);
    const body = await response.json() as { data: { protocol: string; selected_pin: typeof pin } };
    expect(response.status).toBe(200);
    expect(body.data.protocol).toBe("eliotr.research-configuration-method-readiness.v1");
    expect(body.data.selected_pin).toEqual(pin);
    expect(f.method).toHaveBeenCalledExactlyOnceWith(env, context, pin);
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it.each([
    "?project_id=project-1&capability=research-methods-v1&configuration_project_id=project-1&configuration_ref=x&configuration_sha256=b&selection_revision=3",
    `?project_id=${projectId}&capability=research-methods-v1&configuration_ref=${pin.configuration_ref}` +
      `&configuration_project_id=${pin.configuration_project_id}&configuration_sha256=${pin.configuration_sha256}&selection_revision=3&extra=1`,
    `?project_id=${projectId}&capability=research-methods-v1&configuration_project_id=${pin.configuration_project_id}` +
      `&configuration_ref=${pin.configuration_ref}&configuration_ref=${pin.configuration_ref}` +
      `&configuration_sha256=${pin.configuration_sha256}&selection_revision=3`,
  ])("rejects malformed opt-in requests without entering either readiness path", async query => {
    await expect(dispatch(query)).rejects.toMatchObject({ status: 400 });
    expect(f.method).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it("rejects incomplete opt-in pins in the parser", () => {
    expect(() => parseResearchMethodReadinessQuery(new URL(
      `https://owner.invalid/api/v1/system/research-configuration?project_id=${projectId}&capability=research-methods-v1`)))
      .toThrow("complete valid project selection pin");
  });
});
