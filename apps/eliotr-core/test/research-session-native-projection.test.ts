import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";

const bindings = env as unknown as Env;

it("projects a native waiting run without creating a workflow or advancing D1 stages", async () => {
  const fixture = await prepareHistoricalV2Workflow("session-native-projection");
  const operationId = fixture.request.operation_id;
  const workflow = bindings.RESEARCH_WORKFLOW;
  const get = vi.spyOn(workflow, "get").mockImplementation(async (id) => ({
    id,
    status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(workflow, "create");
  try {
    const namespace = bindings.RESEARCH_SESSION;
    const stub = namespace.get(namespace.idFromName(fixture.session_body.session_id));
    const started = await stub.fetch(new Request("https://session.example/session/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.session_headers },
      body: JSON.stringify(fixture.session_body),
    }));
    expect(started.status).toBe(200);

    const before = await fixture.db.prepare(`SELECT state, next_stage_index, current_revision,
      (SELECT COUNT(*) FROM research_workflow_attempt WHERE operation_id = ?1) AS attempts,
      (SELECT COUNT(*) FROM research_workflow_checkpoint WHERE operation_id = ?1) AS checkpoints
      FROM research_workflow_run WHERE operation_id = ?1`).bind(operationId)
      .first<{ state: string; next_stage_index: number; current_revision: number; attempts: number; checkpoints: number }>();
    const response = await stub.fetch(new Request(
      `https://session.example/session/${fixture.session_body.session_id}/run`,
      { method: "POST", headers: fixture.session_headers },
    ));
    const payload = await response.json() as {
      state?: string;
      run_status?: { execution_state?: string; engine_status?: string; next_stage_index?: number; failure?: unknown };
    };
    const after = await fixture.db.prepare(`SELECT state, next_stage_index, current_revision,
      (SELECT COUNT(*) FROM research_workflow_attempt WHERE operation_id = ?1) AS attempts,
      (SELECT COUNT(*) FROM research_workflow_checkpoint WHERE operation_id = ?1) AS checkpoints
      FROM research_workflow_run WHERE operation_id = ?1`).bind(operationId)
      .first<{ state: string; next_stage_index: number; current_revision: number; attempts: number; checkpoints: number }>();

    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload).toMatchObject({
      state: "ACTIVE",
      run_status: { execution_state: "ACTIVE", engine_status: "waiting", next_stage_index: 0 },
    });
    expect(payload.run_status).not.toHaveProperty("failure");
    expect(get).toHaveBeenCalledWith(operationId);
    expect(create).not.toHaveBeenCalled();
    expect(after).toEqual(before);
  } finally {
    get.mockRestore();
    create.mockRestore();
  }
}, 30_000);
