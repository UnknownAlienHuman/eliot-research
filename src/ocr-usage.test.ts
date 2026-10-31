import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type * as ModelTransport from "./model-transport";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, readonly env: Env) {}
  },
}));
vi.mock("ai", async () => ({ ...await vi.importActual<Record<string, unknown>>("ai"), generateText: vi.fn() }));
vi.mock("./model-transport", async () => ({
  ...await vi.importActual<typeof ModelTransport>("./model-transport"), resolveModelTransport: vi.fn(),
}));

import { generateText } from "ai";
import { OcrWorkflow } from "./workflows/ocr";

it("settles saved page usage after terminal failure without reviving the job or dispatching its next page", async () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const text = "Saved OCR page.", bytes = new TextEncoder().encode(text);
  const settled: unknown[] = [];
  const progress = () => db.prepare("SELECT state,error,calls,completed_pages,input_tokens,cached_tokens,output_tokens FROM source_ocr_job WHERE id='job'").get();
  const prepare = vi.fn((sql: string) => ({ bind: (...args: SQLInputValue[]) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => {
      const result = db.prepare(sql).run(...args);
      if (sql.includes("SET completed_pages=completed_pages+")) settled.push(progress());
      return { meta: { changes: Number(result.changes) } };
    },
  }) }));
  const env = { DB: { prepare }, BUCKET: {
    get: async (key: string) => key === "source/revision/ocr/job/page-1.md" ? {
      customMetadata: { sha256: createHash("sha256").update(bytes).digest("hex"), finish: "stop", failure: "",
        inputTotal: "120", cachedTotal: "5", outputTotal: "30" },
      arrayBuffer: async () => bytes.buffer,
    } : null,
    put: vi.fn(async () => ({})),
  } } as unknown as Env;
  const stepDo = vi.fn(async (name: string, _options: unknown, callback: () => Promise<unknown>) =>
    // Replay the completed begin step; page 1 was dispatched before the job failed.
    name === "begin OCR" ? 2 : callback());
  try {
    db.exec(readFileSync(new URL("../migrations/0010_source_ocr.sql", import.meta.url), "utf8"));
    db.exec("INSERT INTO source_ocr_job(id,project_id,source_id,base_revision_id,model_route,model_snapshot,page_count,state,calls,"
      + "token_limit,input_tokens,cached_tokens,output_tokens,error,deadline_at,created_by,created_at,updated_at) "
      + "VALUES('job','project','source','revision','fixture','{}',2,'failed',1,4096,NULL,NULL,NULL,'Deadline elapsed',0,'owner',0,0)");
    await new OcrWorkflow({} as never, env).run({ payload: { jobId: "job" } } as WorkflowEvent<{ jobId: string }>,
      { do: stepDo } as unknown as WorkflowStep);

    expect(settled).toEqual([{ state: "failed", error: "Deadline elapsed", calls: 1, completed_pages: 1,
      input_tokens: 120, cached_tokens: 5, output_tokens: 30 }]);
    expect(progress()).toMatchObject({ state: "failed", calls: 1, completed_pages: 1,
      input_tokens: 120, cached_tokens: 5, output_tokens: 30 });
    expect(stepDo.mock.calls.some(([name]) => name === "OCR page 2")).toBe(true);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("SET calls=calls+1"))).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  } finally { db.close(); }
});
