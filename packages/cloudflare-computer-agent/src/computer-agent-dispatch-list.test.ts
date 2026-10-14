import { describe, expect, it } from "vitest";
import { ComputerAgentDispatchListSchema, RESEARCH_REQUEST_MAX_BYTES } from "@eliotr/contracts";
import { previewComputerAgentDispatchQuestion, readComputerAgentDispatchPage } from "./computer-agent-dispatch-list.js";

describe("dispatch list D1 response boundary", () => {
  it("retains complete Unicode codepoints and exposes a truncated preview explicitly", () => {
    const original = "x".repeat(1023) + "🙂 suffix";
    expect(previewComputerAgentDispatchQuestion(original)).toEqual({ question_preview: "x".repeat(1023),
      question_utf8_bytes: 1034, question_truncated: true });
    expect(previewComputerAgentDispatchQuestion("Полный вопрос")).toMatchObject({
      question_preview: "Полный вопрос", question_truncated: false });
  });

  it("keeps twenty maximum requests below the existing owner JSON reader envelope", () => {
    const preview = previewComputerAgentDispatchQuestion("x".repeat(RESEARCH_REQUEST_MAX_BYTES));
    const page = ComputerAgentDispatchListSchema.parse({ protocol: "eliotr.computer-agent-dispatch-list.v2",
      items: Array.from({ length: 20 }, (_, index) => ({ protocol: "eliotr.computer-agent-dispatch-summary.v2",
        dispatch_id: `dispatch-${String(index).padStart(2, "0")}`, project_id: "project-a", connection_id: "connection-a",
        connection_revision: 1, state: "PENDING", created_at: "2026-10-14T00:00:00.000Z",
        expires_at: "2026-10-15T00:00:00.000Z", ...preview, accepted_workflow: null })),
      next_after_dispatch_id: null });
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(512 * 1024);
    expect(page.items.every(item => item.question_truncated && item.question_utf8_bytes === RESEARCH_REQUEST_MAX_BYTES)).toBe(true);
  });

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
