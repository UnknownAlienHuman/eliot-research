import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";
import { sessionIdForAgentRequest } from "../src/research-session-chat-authority.js";

it("requires path/query session identity to agree and decodes query locators once", () => {
  const valid = (value: string) => /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value);
  const resolve = (path: string) => sessionIdForAgentRequest(new URL(path, "https://session.example"), valid);
  expect(resolve("/agents/research-session/A/chat?session_id=B")).toBeNull();
  expect(resolve("/session/A/chat?session_id=B")).toBeNull();
  expect(resolve("/agents/research-session/A/chat?session_id=A")).toBe("A");
  expect(resolve("/get-messages?session_id=%41")).toBe("A");
  expect(resolve("/get-messages?session_id=%2541")).toBeNull();
  expect(resolve("/get-messages?session_id=A&session_id=A")).toBeNull();
});

it("binds an SDK session from canonical run readback and rejects foreign or stale readers without another run", async () => {
  const fixture = await prepareHistoricalV2Workflow("native-sdk-bootstrap");
  const runtime = env as unknown as Env;
  const operationId = fixture.request.operation_id;
  const get = vi.spyOn(runtime.RESEARCH_WORKFLOW, "get").mockImplementation(async (id) => ({
    id, status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(runtime.RESEARCH_WORKFLOW, "create");
  const send = (principalRef = fixture.principal.principal_ref, credential = fixture.principal.credential_generation) =>
    handleHttp(new Request(`https://research.example/agents/research-session/${operationId}/get-messages`, {
      headers: { "x-research-principal": "spoofed-reader" },
    }), runtime, {} as ExecutionContext, { accessVerifier: { verify: async () => ({
      principal_ref: principalRef, credential_generation: credential,
      authentication_method: "cloudflare_access", expires_at: "2027-01-01T00:00:00.000Z",
    }) } });
  try {
    const before = await fixture.db.prepare(
      "SELECT next_stage_index,current_revision FROM research_workflow_run WHERE operation_id=?1",
    ).bind(operationId).first();
    const history = await send();
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual([]);
    const stub = runtime.RESEARCH_SESSION.get(runtime.RESEARCH_SESSION.idFromName(operationId));
    const record = await stub.fetch(new Request(`https://session.example/session/${operationId}`, {
      headers: fixture.session_headers,
    }));
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({ session_id: operationId, operation_id: operationId });
    const foreign = await send("foreign-reader");
    expect(foreign.status).toBe(404);
    const stale = await send(fixture.principal.principal_ref, "stale-credential");
    expect(stale.status).toBe(409);
    const after = await fixture.db.prepare(
      "SELECT next_stage_index,current_revision FROM research_workflow_run WHERE operation_id=?1",
    ).bind(operationId).first();
    expect(after).toEqual(before);
    expect(create).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    create.mockRestore();
  }
}, 30_000);
