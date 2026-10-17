import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { handleResearchConfigurationReadiness, parseResearchMethodReadinessQuery } from "./research-method-readiness-http.js";

const f = vi.hoisted(() => ({ legacy: vi.fn(), method: vi.fn(), envelopes: [] as unknown[] }));
vi.mock("./research-project-configuration-composition.js", () => ({
  readOwnerProjectResearchReadiness: f.legacy,
  readOwnerProjectResearchMethodReadiness: f.method,
}));
vi.mock("./http-response.js", () => ({
  apiResult: (_request: Request, _env: Env, data: unknown) => {
    f.envelopes.push(data);
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  },
}));

const projectId = "project-1";
const pin = { configuration_project_id: projectId, configuration_ref: `rpmc-${"a".repeat(64)}`,
  configuration_sha256: "a".repeat(64), selection_revision: 17 } as const;
const params = () => new URLSearchParams({ project_id: projectId, capability: "research-methods-v1",
  configuration_project_id: pin.configuration_project_id, configuration_ref: pin.configuration_ref,
  configuration_sha256: pin.configuration_sha256, selection_revision: String(pin.selection_revision) });
const context = { principal_ref: "owner-1", credential_generation: "credential-1", client_class: "owner_pwa",
  request: new Request("https://owner.invalid/api/v1/system/research-configuration") } as unknown as AuthenticatedRequestContext;
const env = {} as Env;

beforeEach(() => {
  f.legacy.mockReset().mockResolvedValue({ protocol: "eliotr.research-configuration-readiness.v1", run_readiness: "ready" });
  f.method.mockReset().mockResolvedValue({ protocol: "eliotr.research-configuration-method-readiness.v1",
    project_id: projectId, selected_pin: pin, evidence_review_ready: true,
    evidence_review_handler_generation: "V7", evidence_review_unavailable_reason: null,
    checked_at: "2026-10-17T12:00:00.000Z" });
  f.envelopes.length = 0;
});

describe("opt-in research method readiness HTTP query", () => {
  it("accepts only the exact six-key capability request and full same-project pin", () => {
    const url = new URL(`https://owner.invalid/api/v1/system/research-configuration?${params()}`);
    expect(parseResearchMethodReadinessQuery(url)).toEqual({ projectId, selectionPin: pin });
    expect(parseResearchMethodReadinessQuery(new URL(`https://owner.invalid/api/v1/system/research-configuration?project_id=${projectId}`)))
      .toBeUndefined();
  });

  it.each([
    ["unknown capability", "capability=other"],
    ["unknown field", "unexpected=1"],
    ["missing required project", "project_id="],
    ["missing pin field", "configuration_ref="],
    ["duplicate pin field", `selection_revision=${pin.selection_revision}`],
    ["zero revision", "selection_revision=0"],
    ["revision over maximum", "selection_revision=1000001"],
    ["noncanonical revision", "selection_revision=1.0"],
    ["different configuration project", "configuration_project_id=other-project"],
  ])("rejects %s before invoking a readiness reader", (_label, replacement) => {
    const query = params();
    if (replacement.startsWith("unexpected=")) query.set("unexpected", "1");
    else if (replacement.startsWith("selection_revision=") && replacement === `selection_revision=${pin.selection_revision}`) {
      query.append("selection_revision", String(pin.selection_revision));
    } else {
      const [key, value] = replacement.split("=");
      if (key !== undefined) query.set(key, value ?? "");
    }
    const url = new URL(`https://owner.invalid/api/v1/system/research-configuration?${query}`);
    expect(() => parseResearchMethodReadinessQuery(url)).toThrow();
    expect(f.method).not.toHaveBeenCalled();
  });

  it("keeps a no-capability V1 read on the unchanged project_id path", async () => {
    const url = new URL(`https://owner.invalid/api/v1/system/research-configuration?project_id=${projectId}`);
    const response = await handleResearchConfigurationReadiness({ request: new Request(url), env, context, url });
    expect(await response.json()).toEqual({ data: await f.legacy.mock.results[0]?.value });
    expect(f.legacy).toHaveBeenCalledExactlyOnceWith(env, context, projectId);
    expect(f.method).not.toHaveBeenCalled();
  });

  it("dispatches the opt-in request with the exact pin and rejects a nonempty body", async () => {
    const url = new URL(`https://owner.invalid/api/v1/system/research-configuration?${params()}`);
    const response = await handleResearchConfigurationReadiness({ request: new Request(url), env, context, url });
    expect(await response.json()).toMatchObject({ data: { evidence_review_ready: true, evidence_review_handler_generation: "V7" } });
    expect(f.method).toHaveBeenCalledExactlyOnceWith(env, context, pin);
    expect(f.legacy).not.toHaveBeenCalled();

    f.method.mockClear();
    const requestWithBody = new Request(url, { method: "POST", body: "x" });
    await expect(handleResearchConfigurationReadiness({ request: requestWithBody, env, context, url })).rejects.toThrow();
    expect(f.method).not.toHaveBeenCalled();
  });
});
