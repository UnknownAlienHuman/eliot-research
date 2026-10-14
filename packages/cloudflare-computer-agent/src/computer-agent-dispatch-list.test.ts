import { describe, expect, it } from "vitest";
import { readComputerAgentDispatchPage } from "./computer-agent-dispatch-list.js";

describe("dispatch list D1 response boundary", () => {
  it.each([
    { success: false, results: [] },
    { success: true },
  ])("refuses a failed or incomplete response instead of returning an empty task list", async (response) => {
    const statement = { bind() { return statement; }, async all() { return response; } };
    const database = { prepare() { return statement; } } as unknown as D1Database;
    await expect(readComputerAgentDispatchPage({ database, project_id: "project-a",
      owner_principal_ref: "owner-a", now: Date.now() }))
      .rejects.toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_STORAGE_UNAVAILABLE", status: 503 });
  });
});
