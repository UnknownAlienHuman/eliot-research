import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";

const bindings = env as unknown as Env;

it("authenticates before AIChatAgent history and preserves the existing DO session record", async () => {
  const fixture = await prepareHistoricalV2Workflow("session-native-chat-binding");
  const sessionId = fixture.session_body.session_id;
  const operationId = fixture.request.operation_id;
  const workflow = bindings.RESEARCH_WORKFLOW;
  const get = vi.spyOn(workflow, "get").mockImplementation(async (id) => ({
    id,
    status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(workflow, "create");
  try {
    const namespace = bindings.RESEARCH_SESSION;
    const stub = namespace.get(namespace.idFromName(`session-native-chat-${sessionId}`));
    const started = await stub.fetch(new Request("https://session.example/session/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.session_headers },
      body: JSON.stringify(fixture.session_body),
    }));
    expect(started.status).toBe(200);
    await started.json();

    const foreignHistory = await stub.fetch(new Request(
      `https://session.example/get-messages?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { ...fixture.session_headers, "x-research-principal": "foreign-principal",
        "x-research-access-expires-at": "2027-01-01T00:00:00.000Z" } },
    ));
    expect(foreignHistory.status).toBe(403);

    const history = await stub.fetch(new Request(
      `https://session.example/get-messages?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { ...fixture.session_headers, "x-research-access-expires-at": "2027-01-01T00:00:00.000Z" } },
    ));
    expect(history.status).toBe(200);
    await history.text();

    const persisted = await stub.fetch(new Request(`https://session.example/session/${sessionId}`, {
      headers: fixture.session_headers,
    }));
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toMatchObject({
      session_id: sessionId,
      state: "ACTIVE",
      operation_id: operationId,
    });
    expect(create).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(operationId);
  } finally {
    get.mockRestore();
    create.mockRestore();
  }
}, 30_000);
