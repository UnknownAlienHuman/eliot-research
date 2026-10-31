import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { Actor } from "./auth";
import type * as Models from "./models";
import type { ModelSpec } from "./models";

vi.mock("./models", async () => ({
  ...await vi.importActual<typeof Models>("./models"),
  requireAvailableModel: vi.fn(),
}));

import { requireAvailableModel } from "./models";
import { createOcrJob, startOcrJob } from "./ocr";

const projectId = "43c8e9b1-5e0c-4ea7-b7a7-1a80e9c2d301";
const sourceId = "e5d3bafd-143b-47bd-8dd4-452dd8ec1502";
const revisionId = "132f2848-aec0-4e6c-a7c6-59d46b16b511";
const jobId = "57f5801a-e4c9-4e69-a572-84f79fb8665c";
const pageCount = 15;
const actor = { type: "owner" } as Actor;
const pdf = new TextEncoder().encode("%PDF-ocr-admission-fixture");
const originalSha256 = createHash("sha256").update(pdf).digest("hex");

function fixture(model: ModelSpec) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  db.exec(readFileSync(new URL("../migrations/0001_library.sql", import.meta.url), "utf8"));
  db.exec(readFileSync(new URL("../migrations/0010_source_ocr.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES(?, 'OCR admission fixture', 0, 0)").run(projectId);
  db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES(?, 'OCR PDF', 'file', 'owner', 0, 0)")
    .run(sourceId);
  db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,original_key,original_sha256,original_size,original_mime,
    readable_state,created_by,created_at) VALUES(?,?,1,?,?,?,'application/pdf','readable','owner',0)`)
    .run(revisionId, sourceId, `source/${revisionId}/original`, originalSha256, pdf.byteLength);
  db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
  db.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES(?,?,'owner',0)").run(projectId, sourceId);

  const env = {
    DB: {
      prepare(sql: string) {
        return { bind(...args: SQLInputValue[]) {
          return {
            first: async () => db.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: db.prepare(sql).all(...args) }),
            run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
          };
        } };
      },
    },
    BUCKET: {
      async get(key: string) {
        if (key !== `source/${revisionId}/original`) return null;
        return { size: pdf.byteLength, arrayBuffer: async () => Uint8Array.from(pdf).buffer };
      },
    },
    OCR: { create: vi.fn(async () => ({ id: `ocr-${jobId}` })) },
  } as unknown as Env;
  return { db, env, model };
}

type BudgetedModelSpec = ModelSpec & { outputReserveTokens: number };

function modelSpec(maxOutputTokens: number | null, outputReserveTokens: number): BudgetedModelSpec {
  return Object.freeze({
    route: "gateway:fixture/vision-model", id: "fixture/vision-model", label: "OCR image fixture",
    contextTokens: 1_000_000, maxOutputTokens, outputReserveTokens, supportsImages: true,
    checkedOn: "2026-10-31", enabled: true,
  });
}

it.each([
  { capacity: 131_072, currentReserve: 8_192, expectedReserve: 16_384 },
  { capacity: 12_288, currentReserve: 8_192, expectedReserve: 12_288 },
  { capacity: null, currentReserve: 8_192, expectedReserve: 8_192 },
  { capacity: 131_072, currentReserve: 32_768, expectedReserve: 32_768 },
] as const)("stores OCR reserve $expectedReserve within capacity $capacity", async ({ capacity, currentReserve, expectedReserve }) => {
  const model = modelSpec(capacity, currentReserve);
  const f = fixture(model);
  vi.mocked(requireAvailableModel).mockReset().mockResolvedValue(model);
  try {
    const job = await createOcrJob(f.env, actor, {
      projectId, sourceId, jobId, baseRevisionId: revisionId, model: model.route,
      pageCount, originalSha256,
    });
    const row = f.db.prepare("SELECT model_snapshot AS snapshot,token_limit AS tokenLimit FROM source_ocr_job WHERE id=?")
      .get(jobId) as { snapshot: string; tokenLimit: number };
    const admitted = JSON.parse(row.snapshot) as ModelSpec;
    const expectedBound = pageCount * (model.contextTokens + expectedReserve);

    expect(job.state).toBe("preparing");
    expect(job.tokenLimit).toBe(expectedBound);
    expect(row.tokenLimit).toBe(expectedBound);
    expect(admitted.outputReserveTokens).toBe(expectedReserve);
    expect(admitted.route).toBe(model.route);
    expect(model.outputReserveTokens).toBe(currentReserve);
    expect(requireAvailableModel).toHaveBeenCalledExactlyOnceWith(f.env, model.route);
    expect(f.env.OCR.create).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});

it.each(["queued", "failed"] as const)("does not rewrite a legacy $state OCR snapshot on Start", async (state) => {
  const model = modelSpec(131_072, 8_192);
  const f = fixture(model);
  const priorSnapshot = JSON.stringify(model);
  const priorTokenLimit = pageCount * (model.contextTokens + model.outputReserveTokens);
  f.db.prepare(`INSERT INTO source_ocr_job(id,project_id,source_id,base_revision_id,model_route,model_snapshot,page_count,state,
    calls,completed_pages,token_limit,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?, ?,1,1,?,'owner',0,0)`)
    .run(jobId, projectId, sourceId, revisionId, model.route, priorSnapshot, pageCount, state, priorTokenLimit);
  vi.mocked(requireAvailableModel).mockReset();
  try {
    const before = f.db.prepare("SELECT model_snapshot AS snapshot,token_limit AS tokenLimit FROM source_ocr_job WHERE id=?")
      .get(jobId);
    const job = await startOcrJob(f.env, actor, { projectId, sourceId, jobId });
    const after = f.db.prepare("SELECT model_snapshot AS snapshot,token_limit AS tokenLimit FROM source_ocr_job WHERE id=?")
      .get(jobId);

    expect(job.state).toBe(state);
    expect(after).toEqual(before);
    expect(requireAvailableModel).not.toHaveBeenCalled();
    expect(f.env.OCR.create).not.toHaveBeenCalled();
  } finally { f.db.close(); }
});
