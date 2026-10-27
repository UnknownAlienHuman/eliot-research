import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./auth";
import type { ComparisonClaim } from "./comparisons";
import { getProjectKnowledge, renderKnowledge, storeKnowledgeRevision } from "./knowledge";
import type { KnowledgeData } from "./knowledge";

// These cases call the real storage functions, not loadKnowledgeInputs. Keep
// the latter's unrelated K3 Workflow import out of the native SQLite runner.
vi.mock("./understanding", () => ({ getUnderstanding: vi.fn() }));

const OWNER: Actor = { type: "owner", id: "fixture-owner", authentication: "local" };
const MIGRATIONS = [
  "0001_library.sql", "0002_ask.sql", "0003_distill.sql",
  "0005_model_gateway.sql", "0006_integrity.sql", "0007_project_knowledge.sql",
];

interface D1Statement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

class SQLiteD1 {
  beforeBatch: (() => void) | null = null;
  batches = 0;

  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string) {
    return {
      bind: (...values: SQLInputValue[]): D1Statement => ({
        first: async <T>() => (this.db.prepare(sql).get(...values) as T | undefined) ?? null,
        all: async <T>() => ({ results: this.db.prepare(sql).all(...values) as T[] }),
        run: async () => ({ meta: { changes: Number(this.db.prepare(sql).run(...values).changes) } }),
      }),
    };
  }

  async batch(statements: D1Statement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.batches += 1;
    this.beforeBatch?.();
    this.db.exec("BEGIN");
    try {
      const results: Array<{ meta: { changes: number } }> = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface MemoryPutOptions {
  onlyIf?: { etagDoesNotMatch?: string };
  httpMetadata?: { contentType?: string };
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly attempts: { key: string; etagDoesNotMatch?: string }[] = [];
  failKey: string | null = null;
  afterPut: ((key: string) => void | Promise<void>) | null = null;

  seed(key: string, body: string | Uint8Array): void {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body.slice());
  }

  has(key: string): boolean { return this.objects.has(key); }

  textAt(key: string): string | null {
    const bytes = this.objects.get(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async put(key: string, body: Uint8Array, options?: MemoryPutOptions): Promise<object | null> {
    this.attempts.push({ key, ...(options?.onlyIf?.etagDoesNotMatch === undefined ? {} : { etagDoesNotMatch: options.onlyIf.etagDoesNotMatch }) });
    if (this.failKey === key) throw new Error("Injected R2 write failure");
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) {
      await this.afterPut?.(key);
      return null;
    }
    this.objects.set(key, body.slice());
    await this.afterPut?.(key);
    return {};
  }

  async get(key: string): Promise<object | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.slice();
    return {
      async arrayBuffer() { return bytes.slice().buffer; },
      async text() { return new TextDecoder().decode(bytes); },
      async json<T>() { return JSON.parse(new TextDecoder().decode(bytes)) as T; },
    };
  }
}

interface Fixture {
  db: DatabaseSync;
  d1: SQLiteD1;
  bucket: MemoryR2;
  env: Env;
  data: KnowledgeData;
  projectId: string;
  pageId: string;
  oldHeadId: string;
  candidateId: string;
  inputs: string[];
  now: number;
}

function claim(sourceId: string, revisionId: string, quote: string, valueText: string, valueNumber: number): ComparisonClaim {
  return {
    id: "claim-" + sourceId,
    sourceId,
    revisionId,
    kind: "result",
    statement: "The reported result is " + valueText,
    quote,
    block: 0,
    start: 0,
    end: new TextEncoder().encode(quote).length,
    ambiguous: false,
    task: "classification",
    metric: "accuracy",
    dataset: "FixtureSet",
    valueText,
    valueNumber,
    unit: "percent",
    conditions: "same setting",
  };
}

function fixtureData(): KnowledgeData {
  const first = claim("source-a", "source-a-r1", "Source A exact quote.", "81%", 81);
  const second = claim("source-b", "source-b-r1", "Source B exact quote.", "84%", 84);
  return {
    topics: [{ id: "topic-results", title: "Classification results", sourceIds: ["source-a", "source-b"] }],
    comparisons: [{ id: "cmp:classification", task: "classification", metric: "accuracy", dataset: "FixtureSet",
      unit: "percent", conditions: "same setting", rows: [first, second], disagreement: true }],
    gaps: [{ question: "Which setting explains the difference?", sourceIds: ["source-a", "source-b"] }],
    routes: [{ title: "Read the two result sections", sourceIds: ["source-a", "source-b"] }],
    sources: [
      { sourceId: "source-a", revisionId: "source-a-r1", title: "Source A" },
      { sourceId: "source-b", revisionId: "source-b-r1", title: "Source B" },
    ],
    aliases: { classification: ["categorization"] },
  };
}

function addReadableSource(db: DatabaseSync, sourceId: string, revisionId: string, revisionNo: number, now: number): void {
  if (revisionNo === 1) {
    db.prepare(`INSERT INTO source(id,title,kind,created_by,created_at,updated_at)
      VALUES(?,?,'text','owner',?,?)`).run(sourceId, sourceId === "source-a" ? "Source A" : "Source B", now, now);
  }
  db.prepare(`INSERT INTO source_revision(id,source_id,revision_no,readable_state,created_by,created_at)
    VALUES(?,?,?,'readable','owner',?)`).run(revisionId, sourceId, revisionNo, now);
  if (revisionNo === 1) db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run(revisionId, sourceId);
}

function insertPageRevision(db: DatabaseSync, values: {
  id: string;
  pageId: string;
  revisionNo: number;
  status: "accepted" | "proposed";
  inputs: string[];
  now: number;
  generationState: "running" | "done";
  cost?: number | null;
}): void {
  db.prepare(`INSERT INTO page_revision(id,page_id,revision_no,status,origin,actor,body_key,citations_key,
    inputs_json,mutation_id,created_at,generation_payload_key,generation_state,model_calls,
    model_estimated_cost_microusd,model_started_at)
    VALUES(?,?,?,?,'job',?,?,?, ?,?,?,? ,?,0,?,?)`)
    .run(values.id, values.pageId, values.revisionNo, values.status, OWNER.id,
      `page/${values.id}/body.md`, `page/${values.id}/citations.json`, JSON.stringify(values.inputs),
      "mutation-" + values.id, values.now, `page/${values.id}/inputs.json`, values.generationState,
      values.cost ?? null, values.generationState === "running" ? values.now : null);
}

function makeFixture(): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of MIGRATIONS) db.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));

  const now = Date.now();
  const projectId = "project-a", pageId = "map-page", oldHeadId = "map-old-head", candidateId = "map-candidate";
  const inputs = ["source-a-r1", "source-b-r1"];
  db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES(?,?,?,?)")
    .run(projectId, "Fixture project", now, now);
  addReadableSource(db, "source-a", "source-a-r1", 1, now);
  addReadableSource(db, "source-b", "source-b-r1", 1, now);
  for (const sourceId of ["source-a", "source-b"]) {
    db.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES(?,?,'owner',?)")
      .run(projectId, sourceId, now);
  }
  db.prepare(`INSERT INTO page(id,project_id,kind,title,created_at,updated_at)
    VALUES(?,?,'map','Project map',?,?)`).run(pageId, projectId, now, now);
  insertPageRevision(db, { id: oldHeadId, pageId, revisionNo: 1, status: "accepted", inputs,
    now, generationState: "done" });
  db.prepare("UPDATE page SET head_revision_id=? WHERE id=?").run(oldHeadId, pageId);
  insertPageRevision(db, { id: candidateId, pageId, revisionNo: 2, status: "proposed", inputs,
    now, generationState: "running", cost: 777 });
  db.prepare("UPDATE project SET knowledge_page_id=?,knowledge_active_revision_id=? WHERE id=?")
    .run(pageId, candidateId, projectId);

  const data = fixtureData();
  const bucket = new MemoryR2();
  bucket.seed(`page/${oldHeadId}/body.md`, "Prior accepted project map");
  bucket.seed(`page/${oldHeadId}/citations.json`, "[]");
  bucket.seed(`page/${oldHeadId}/data.json`, JSON.stringify(data));
  const d1 = new SQLiteD1(db);
  const env = { DB: d1, BUCKET: bucket } as unknown as Env;
  return { db, d1, bucket, env, data, projectId, pageId, oldHeadId, candidateId, inputs, now };
}

function addUnrelatedAcceptedPage(f: Fixture): string {
  const pageId = "unrelated-wiki", revisionId = "unrelated-head";
  f.db.prepare(`INSERT INTO page(id,project_id,kind,title,created_at,updated_at)
    VALUES(?,?,'wiki','Unrelated',?,?)`).run(pageId, f.projectId, f.now, f.now);
  insertPageRevision(f.db, { id: revisionId, pageId, revisionNo: 1, status: "accepted",
    inputs: ["source-b-r1"], now: f.now, generationState: "done" });
  f.db.prepare("UPDATE page SET head_revision_id=? WHERE id=?").run(revisionId, pageId);
  return pageId;
}

function addWikiCandidate(f: Fixture): { pageId: string; revisionId: string; inputs: string[] } {
  const pageId = "wiki-page", revisionId = "wiki-candidate", inputs = ["source-a-r1"];
  f.db.prepare(`INSERT INTO page(id,project_id,kind,title,created_at,updated_at)
    VALUES(?,?,'wiki','Topic wiki',?,?)`).run(pageId, f.projectId, f.now, f.now);
  insertPageRevision(f.db, { id: revisionId, pageId, revisionNo: 1, status: "proposed", inputs,
    now: f.now, generationState: "running", cost: 321 });
  f.db.prepare("UPDATE project SET knowledge_active_revision_id=? WHERE id=?").run(revisionId, f.projectId);
  return { pageId, revisionId, inputs };
}

function scopeData(data: KnowledgeData, sourceId: string): KnowledgeData {
  const keep = new Set([sourceId]);
  const sources = data.sources.filter((source) => keep.has(source.sourceId));
  return {
    topics: data.topics.map((topic) => ({ ...topic, sourceIds: topic.sourceIds.filter((id) => keep.has(id)) }))
      .filter((topic) => topic.sourceIds.length > 0),
    comparisons: data.comparisons.map((group) => ({ ...group,
      rows: group.rows.filter((row) => keep.has(row.sourceId)) })).filter((group) => group.rows.length > 0),
    gaps: data.gaps.map((gap) => ({ ...gap, sourceIds: gap.sourceIds.filter((id) => keep.has(id)) }))
      .filter((gap) => gap.sourceIds.length > 0),
    routes: data.routes.map((route) => ({ ...route, sourceIds: route.sourceIds.filter((id) => keep.has(id)) }))
      .filter((route) => route.sourceIds.length > 0),
    sources,
  };
}

function headId(f: Fixture, pageId = f.pageId): string | null {
  const row = f.db.prepare("SELECT head_revision_id AS headRevisionId FROM page WHERE id=?").get(pageId) as { headRevisionId: string | null };
  return row.headRevisionId;
}

function candidateRow(f: Fixture, revisionId = f.candidateId) {
  return f.db.prepare(`SELECT status,generation_state AS generationState,
    model_calls AS calls,model_estimated_cost_microusd AS reservedCost,
    generation_payload_key AS payloadKey FROM page_revision WHERE id=?`).get(revisionId);
}

async function storeMap(f: Fixture) {
  return storeKnowledgeRevision(f.env, OWNER, {
    projectId: f.projectId, pageId: f.pageId, revisionId: f.candidateId,
    data: f.data, inputs: f.inputs, title: "Fixture map", kind: "map",
  });
}

describe("K6 storage functions on migrated SQLite and in-memory R2", () => {
  let fixtures: Fixture[] = [];

  beforeEach(() => { fixtures = []; });
  afterEach(() => { for (const f of fixtures) f.db.close(); });

  function create(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }

  it("renders exact persistent citations and writes every R2 output before atomically advancing the head", async () => {
    const f = create();
    const rendered = renderKnowledge(f.data);
    const bodyKey = `page/${f.candidateId}/body.md`;
    const outputKeys = [
      bodyKey,
      `page/${f.candidateId}/citations.json`,
      `page/${f.candidateId}/data.json`,
    ];
    expect(rendered.body).toContain(`[Rsource-a-r1:0]`);
    expect(rendered.body).toContain(`[Rsource-b-r1:0]`);
    expect(rendered.citations.map((citation) => [citation.revisionId, citation.start, citation.end])).toEqual([
      ["source-a-r1", 0, new TextEncoder().encode("Source A exact quote.").length],
      ["source-b-r1", 0, new TextEncoder().encode("Source B exact quote.").length],
    ]);

    // A native Workflow retry can encounter an object already written by the
    // previous attempt. Identical body bytes are accepted without overwrite.
    f.bucket.seed(bodyKey, rendered.body);
    const completedPuts = new Set<string>();
    f.bucket.afterPut = (key) => {
      completedPuts.add(key);
      expect(headId(f)).toBe(f.oldHeadId);
    };
    f.d1.beforeBatch = () => {
      expect(headId(f)).toBe(f.oldHeadId);
      expect(outputKeys.every((key) => f.bucket.has(key))).toBe(true);
      expect(completedPuts).toEqual(new Set(outputKeys));
    };

    const result = await storeMap(f);
    expect(result).toMatchObject({ accepted: true, stale: false, page: { headRevisionId: f.candidateId, freshness: "current" } });
    expect(result.page?.body).toBe(rendered.body);
    expect(result.page?.citations).toEqual(rendered.citations);
    expect(f.bucket.attempts).toHaveLength(3);
    expect(f.bucket.attempts.every((attempt) => attempt.etagDoesNotMatch === "*")).toBe(true);
    expect(candidateRow(f)).toEqual({
      status: "accepted", generationState: "done", calls: 0, reservedCost: 777,
      payloadKey: `page/${f.candidateId}/inputs.json`,
    });

    const view = await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId });
    expect(view).toMatchObject({ state: "done", operation: { revisionId: f.candidateId, pageId: f.pageId, kind: "map" },
      page: { headRevisionId: f.candidateId, freshness: "current" }, usage: {
      calls: 0, inputTokens: null, outputTokens: null, estimatedCostMicrousd: 777,
    } });
    expect(view.data).toEqual(f.data);
  });

  it("preserves the old accepted head and model reservation when an R2 write partially fails", async () => {
    const f = create();
    f.bucket.failKey = `page/${f.candidateId}/citations.json`;

    await expect(storeMap(f)).rejects.toMatchObject({ code: "unavailable" });

    expect(headId(f)).toBe(f.oldHeadId);
    expect(candidateRow(f)).toEqual({
      status: "proposed", generationState: "running", calls: 0, reservedCost: 777,
      payloadKey: `page/${f.candidateId}/inputs.json`,
    });
    expect(f.d1.batches).toBe(0);
  });

  it("does not overwrite differing bytes already at an immutable output key", async () => {
    const f = create();
    const bodyKey = `page/${f.candidateId}/body.md`;
    f.bucket.seed(bodyKey, "different bytes from an earlier attempt");

    await expect(storeMap(f)).rejects.toMatchObject({ code: "unavailable" });

    expect(f.bucket.textAt(bodyKey)).toBe("different bytes from an earlier attempt");
    expect(headId(f)).toBe(f.oldHeadId);
    expect(candidateRow(f)).toMatchObject({ status: "proposed", generationState: "running", reservedCost: 777 });
    expect(f.d1.batches).toBe(0);
  });

  it("rejects a source replaced before commit and stales only the dependent accepted head", async () => {
    const f = create();
    const unrelatedPageId = addUnrelatedAcceptedPage(f);
    addReadableSource(f.db, "source-a", "source-a-r2", 2, f.now + 1);
    let replaced = false;
    f.bucket.afterPut = (key) => {
      if (!replaced && key === `page/${f.candidateId}/data.json`) {
        replaced = true;
        f.db.prepare("UPDATE source SET current_revision_id='source-a-r2' WHERE id='source-a'").run();
      }
    };

    const result = await storeMap(f);

    expect(replaced).toBe(true);
    expect(result).toMatchObject({ accepted: false, stale: true, page: { headRevisionId: f.oldHeadId, freshness: "stale" } });
    expect(headId(f)).toBe(f.oldHeadId);
    expect(candidateRow(f)).toMatchObject({ status: "proposed", generationState: "failed", reservedCost: 777 });
    expect((f.db.prepare("SELECT freshness FROM page WHERE id=?").get(unrelatedPageId) as { freshness: string }).freshness)
      .toBe("current");
    expect(f.bucket.has(`page/${f.candidateId}/data.json`)).toBe(true);

    const view = await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId });
    expect(view).toMatchObject({ state: "failed", operation: { revisionId: f.candidateId, pageId: f.pageId, kind: "map" },
      page: { headRevisionId: f.oldHeadId, freshness: "stale" } });
  });

  it("requires Wiki page data and citations to match the selected input scope", async () => {
    const f = create();
    const wiki = addWikiCandidate(f);
    const broad = {
      projectId: f.projectId, pageId: wiki.pageId, revisionId: wiki.revisionId,
      data: f.data, inputs: wiki.inputs, title: "Topic wiki", kind: "wiki" as const,
    };
    const running = await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId });
    expect(running).toMatchObject({ state: "running",
      operation: { revisionId: wiki.revisionId, pageId: wiki.pageId, kind: "wiki" },
      page: { headRevisionId: f.oldHeadId }, data: f.data });

    await expect(storeKnowledgeRevision(f.env, OWNER, broad)).rejects.toMatchObject({ code: "invalid" });
    expect(f.bucket.attempts).toHaveLength(0);
    expect(headId(f, wiki.pageId)).toBeNull();
    expect(candidateRow(f, wiki.revisionId)).toMatchObject({ status: "proposed", generationState: "running", reservedCost: 321 });

    const scoped = scopeData(f.data, "source-a");
    const rendered = renderKnowledge(scoped);
    const accepted = await storeKnowledgeRevision(f.env, OWNER, {
      ...broad, data: scoped, body: rendered.body, citations: rendered.citations,
    });
    expect(accepted).toMatchObject({ accepted: true, stale: false, page: { kind: "wiki", headRevisionId: wiki.revisionId } });
    expect(accepted.page?.citations).toHaveLength(1);

    const view = await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId });
    expect(view).toMatchObject({ state: "done",
      operation: { revisionId: wiki.revisionId, pageId: wiki.pageId, kind: "wiki" },
      page: { id: f.pageId, headRevisionId: f.oldHeadId }, data: f.data });
  });

  it("returns no operation when the project has no active K6 revision", async () => {
    const f = create();
    f.db.prepare("UPDATE project SET knowledge_active_revision_id=NULL WHERE id=?").run(f.projectId);

    const view = await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId });

    expect(view).toMatchObject({ state: "none", operation: null, page: { headRevisionId: f.oldHeadId }, data: f.data });
  });
});
