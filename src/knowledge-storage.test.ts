import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "./auth";
import type { Block } from "./blocks";
import type { ComparisonClaim } from "./comparisons";
import { getProjectKnowledge, renderKnowledge, storeKnowledgeRevision } from "./knowledge";
import { loadWikiEvidence, readRetainedWiki, wikiData } from "./knowledge";
import type { KnowledgeData, KnowledgeInputs, KnowledgeSource } from "./knowledge";

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
  readonly gets: { key: string; offset?: number; length?: number }[] = [];
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

  async get(key: string, options?: { range?: { offset: number; length: number } }): Promise<object | null> {
    this.gets.push({ key, ...(options?.range ? options.range : {}) });
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = options?.range
      ? stored.slice(options.range.offset, options.range.offset + options.range.length)
      : stored.slice();
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

function seedSourceBlocks(f: Fixture, revisionId: string, chunks: string[]): Block[] {
  const encoder = new TextEncoder();
  let offset = 0;
  const blocks = chunks.map((chunk, index): Block => {
    const start = offset;
    offset += encoder.encode(chunk).byteLength;
    return { id: index + 1, type: "paragraph", start, end: offset, heading: null };
  });
  f.bucket.seed(`source/${revisionId}/text.md`, encoder.encode(chunks.join("")));
  f.bucket.seed(`source/${revisionId}/blocks.json`, JSON.stringify(blocks));
  return blocks;
}

function wikiSource(sourceId: string, revisionId: string, guide: string | null, claims: ComparisonClaim[] = []): KnowledgeSource {
  return { sourceId, revisionId, title: "Frozen source", guide, claims };
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

function seedRetainedWiki(f: Fixture) {
  const wiki = addWikiCandidate(f);
  const source = f.data.sources[0], topic = f.data.topics[0];
  if (!source || !topic) throw new Error("Missing frozen Wiki fixture topic or source");
  const quote = "Точность достигла 81%.";
  const evidence = { quote, citation: { revisionId: "source-a-r1", sourceId: "source-a", sourceTitle: "Source A",
    block: 2, start: 12, end: 12 + new TextEncoder().encode(quote).byteLength, deleted: false,
    label: "[Rsource-a-r1:2]" } };
  const inputs: KnowledgeInputs = {
    kind: "wiki", topicId: topic.id, changed: [],
    previous: { ...f.data, topics: [{ ...topic, sourceIds: [source.sourceId] },
      ...f.data.sources.filter((other) => other.sourceId !== source.sourceId)
        .map((other) => ({ id: "topic-" + other.sourceId, title: other.title, sourceIds: [other.sourceId] }))] },
    sources: [{ ...source, guide: null,
      claims: f.data.comparisons.flatMap((group) => group.rows).filter((row) => row.sourceId === "source-a") }],
    wikiEvidence: [evidence],
  };
  const raw = { sections: [
    { labels: [evidence.citation.label], text: quote },
    { labels: [evidence.citation.label], text: "Точность достигла 99%." },
  ] };
  f.bucket.seed(`page/${wiki.revisionId}/inputs.json`, JSON.stringify(inputs));
  f.bucket.seed(`page/${wiki.revisionId}/call-1.json`, JSON.stringify(raw));
  f.db.prepare("UPDATE page_revision SET generation_state='failed',model_calls=1 WHERE id=?").run(wiki.revisionId);
  return { ...wiki, inputs, raw, evidence };
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

  it("reads a supported retained subset from frozen evidence without rebinding source bytes or usage", async () => {
    const f = create(), wiki = seedRetainedWiki(f);
    const original = { ...candidateRow(f, wiki.revisionId) };
    const inputsBytes = f.bucket.textAt(`page/${wiki.revisionId}/inputs.json`);
    const rawBytes = f.bucket.textAt(`page/${wiki.revisionId}/call-1.json`);
    f.bucket.seed("source/source-a-r1/text.md", "Replacement bytes report 99%.");
    f.bucket.seed("source/source-a-r1/blocks.json", "[]");

    const retained = await readRetainedWiki(f.env, f.projectId, wiki.revisionId);
    expect(retained).not.toBeNull();
    expect(retained).toMatchObject({ pageId: wiki.pageId, originalRevisionId: wiki.revisionId,
      inputs: wiki.inputs, checked: { kept: 1, dropped: [{ index: 1, reason: "unsupported-numeric-facts" }], missingSourceIds: [] } });
    expect(retained?.checked.body).toBe(wiki.evidence.quote + "\n\n" + wiki.evidence.citation.label);
    expect(retained?.checked.citations).toEqual([wiki.evidence.citation]);
    expect((await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId, operationId: wiki.revisionId })).canRecheckWiki).toBe(true);
    expect(f.bucket.gets.every(({ key }) => key.startsWith("page/"))).toBe(true);
    expect(f.bucket.attempts).toHaveLength(0);
    expect(f.bucket.textAt(`page/${wiki.revisionId}/inputs.json`)).toBe(inputsBytes);
    expect(f.bucket.textAt(`page/${wiki.revisionId}/call-1.json`)).toBe(rawBytes);
    expect(candidateRow(f, wiki.revisionId)).toEqual(original);
  });

  it("does not offer recheck for legacy evidence, incompatible raw output, an empty subset or an undispatched operation", async () => {
    const f = create(), wiki = seedRetainedWiki(f);
    const legacy = { ...wiki.inputs };
    delete legacy.wikiEvidence;
    f.bucket.seed(`page/${wiki.revisionId}/inputs.json`, JSON.stringify(legacy));
    expect(await readRetainedWiki(f.env, f.projectId, wiki.revisionId)).toBeNull();
    expect((await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId })).canRecheckWiki).toBe(false);
    expect(f.bucket.gets.some(({ key }) => key.startsWith("source/"))).toBe(false);

    f.bucket.seed(`page/${wiki.revisionId}/inputs.json`, JSON.stringify(wiki.inputs));
    f.bucket.seed(`page/${wiki.revisionId}/call-1.json`, JSON.stringify({ sections: [{ labels: ["[Rother:2]"], text: "Other output." }] }));
    expect(await readRetainedWiki(f.env, f.projectId, wiki.revisionId)).toBeNull();
    f.bucket.seed(`page/${wiki.revisionId}/call-1.json`, JSON.stringify({ sections: [wiki.raw.sections[1]] }));
    expect(await readRetainedWiki(f.env, f.projectId, wiki.revisionId)).toBeNull();
    f.bucket.seed(`page/${wiki.revisionId}/call-1.json`, JSON.stringify(wiki.raw));
    f.db.prepare("UPDATE page_revision SET model_calls=0 WHERE id=?").run(wiki.revisionId);
    expect(await readRetainedWiki(f.env, f.projectId, wiki.revisionId)).toBeNull();
    expect(f.bucket.attempts).toHaveLength(0);
  });

  it("follows one checkedFrom directly to the original model operation and rejects a recheck chain", async () => {
    const f = create(), wiki = seedRetainedWiki(f);
    const checkedId = "wiki-checked", chainId = "wiki-checked-again";
    insertPageRevision(f.db, { id: checkedId, pageId: wiki.pageId, revisionNo: 2, status: "accepted",
      inputs: wiki.inputs.sources.map((source) => source.revisionId), now: f.now, generationState: "done", cost: 0 });
    const checkedInputs = { ...wiki.inputs, checkedFrom: wiki.revisionId };
    f.bucket.seed(`page/${checkedId}/inputs.json`, JSON.stringify(checkedInputs));
    const retained = await readRetainedWiki(f.env, f.projectId, checkedId);
    expect(retained).toMatchObject({ pageId: wiki.pageId, originalRevisionId: wiki.revisionId, inputs: wiki.inputs, checked: { kept: 1 } });
    expect(f.bucket.gets.some(({ key }) => key === `page/${checkedId}/call-1.json`)).toBe(false);
    insertPageRevision(f.db, { id: chainId, pageId: wiki.pageId, revisionNo: 3, status: "proposed",
      inputs: wiki.inputs.sources.map((source) => source.revisionId), now: f.now, generationState: "done", cost: 0 });
    f.bucket.seed(`page/${chainId}/inputs.json`, JSON.stringify({ ...wiki.inputs, checkedFrom: checkedId }));
    expect(await readRetainedWiki(f.env, f.projectId, chainId)).toBeNull();
  });

  it("denies foreign-project, foreign-page and map links before exposing retained output", async () => {
    const f = create(), wiki = seedRetainedWiki(f);
    f.db.prepare("INSERT INTO project(id,title,created_at,updated_at) VALUES('foreign-project','Other',?,?)").run(f.now, f.now);
    expect(await readRetainedWiki(f.env, "foreign-project", wiki.revisionId)).toBeNull();
    expect(await readRetainedWiki(f.env, f.projectId, f.candidateId)).toBeNull();
    expect(f.bucket.gets).toHaveLength(0);
    const otherPageId = addUnrelatedAcceptedPage(f);
    f.db.prepare("UPDATE page_revision SET model_calls=1 WHERE page_id=?").run(otherPageId);
    f.bucket.seed(`page/${wiki.revisionId}/inputs.json`, JSON.stringify({ ...wiki.inputs, checkedFrom: "unrelated-head" }));
    expect(await readRetainedWiki(f.env, f.projectId, wiki.revisionId)).toBeNull();
    expect(f.bucket.gets.some(({ key }) => key.startsWith("page/unrelated-head/"))).toBe(false);
    f.bucket.seed(`page/${wiki.revisionId}/inputs.json`, JSON.stringify({ ...wiki.inputs, checkedFrom: wiki.revisionId }));
    expect(await readRetainedWiki(f.env, f.projectId, wiki.revisionId)).toBeNull();
  });

  it("builds Wiki data from only the exact frozen sources and selected topic", () => {
    const f = create(), wiki = seedRetainedWiki(f);
    const initial = wiki.inputs.previous;
    if (!initial) throw new Error("Missing previous fixture map");
    const previous = { ...initial, topics: [...initial.topics,
      { id: "overlapping-topic", title: "Other topic", sourceIds: ["source-a"] }] };
    const frozen = { ...wiki.inputs, previous,
      sources: wiki.inputs.sources.map((source) => ({ ...source, title: "Frozen title" })) };
    const before = JSON.stringify(frozen);
    const data = wikiData(frozen);
    expect(data.sources).toEqual([{ sourceId: "source-a", revisionId: "source-a-r1", title: "Frozen title" }]);
    expect(data.topics).toEqual([{ id: "topic-results", title: "Classification results", sourceIds: ["source-a"] }]);
    expect(data.comparisons).toEqual([]);
    expect(data.gaps.every((row) => row.sourceIds.every((id) => id === "source-a"))).toBe(true);
    expect(data.routes.every((row) => row.sourceIds.every((id) => id === "source-a"))).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(() => wikiData({ ...wiki.inputs, previous: null })).toThrow(/frozen map/i);
    expect(() => wikiData({ ...wiki.inputs, sources: [] })).toThrow(/topic and sources/i);
    expect(() => wikiData({ ...wiki.inputs,
      sources: wiki.inputs.sources.map((source) => ({ ...source, revisionId: "source-a-r2" })) })).toThrow(/topic and sources/i);
    const selected = initial.topics.find((topic) => topic.id === wiki.inputs.topicId);
    if (!selected) throw new Error("Missing selected fixture topic");
    expect(() => wikiData({ ...wiki.inputs, previous: { ...initial,
      topics: [{ ...selected, sourceIds: ["source-a", "source-b"] }] } })).toThrow(/topic and sources/i);
  });

  it("publishes a review warning atomically with the accepted Wiki head", async () => {
    const f = create(), wiki = addWikiCandidate(f);
    const data = scopeData(f.data, "source-a"), rendered = renderKnowledge(data);
    const warning = "Only the supported retained sentences were saved. Review the omitted output.";
    f.d1.beforeBatch = () => {
      expect(headId(f, wiki.pageId)).toBeNull();
      expect(f.db.prepare("SELECT generation_error AS error FROM page_revision WHERE id=?").get(wiki.revisionId)).toMatchObject({ error: null });
    };
    const result = await storeKnowledgeRevision(f.env, OWNER, { projectId: f.projectId, pageId: wiki.pageId,
      revisionId: wiki.revisionId, data, inputs: wiki.inputs, title: "Topic wiki", kind: "wiki",
      ...rendered, reviewWarning: warning });
    expect(result).toMatchObject({ accepted: true, page: { headRevisionId: wiki.revisionId } });
    const view = await getProjectKnowledge(f.env, OWNER, { projectId: f.projectId });
    expect(view).toMatchObject({ state: "done", error: warning, canRecheckWiki: false });
    expect(candidateRow(f, wiki.revisionId)).toMatchObject({ calls: 0, reservedCost: 321 });
  });

  it("rolls a review warning back with the revision when head publication fails", async () => {
    const f = create(), wiki = addWikiCandidate(f);
    const data = scopeData(f.data, "source-a"), rendered = renderKnowledge(data);
    f.db.exec(`CREATE TRIGGER reject_wiki_head BEFORE UPDATE OF head_revision_id ON page
      WHEN NEW.id='wiki-page' BEGIN SELECT RAISE(ABORT,'Injected Wiki head failure'); END`);
    await expect(storeKnowledgeRevision(f.env, OWNER, { projectId: f.projectId, pageId: wiki.pageId,
      revisionId: wiki.revisionId, data, inputs: wiki.inputs, title: "Topic wiki", kind: "wiki",
      ...rendered, reviewWarning: "Retained subset requires review." })).rejects.toThrow("Injected Wiki head failure");
    expect(headId(f, wiki.pageId)).toBeNull();
    expect(f.db.prepare("SELECT status,generation_state AS state,generation_error AS error FROM page_revision WHERE id=?")
      .get(wiki.revisionId)).toMatchObject({ status: "proposed", state: "running", error: null });
  });

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

  it("hydrates a guide-only citation from the full block in its frozen revision", async () => {
    const f = create();
    const revisionId = "guide-only-r1";
    const chunks = ["Prefix block.\n", "Guide-only evidence.\n"];
    const blocks = seedSourceBlocks(f, revisionId, chunks);

    const evidence = await loadWikiEvidence(f.env, [wikiSource("guide-only", revisionId, `Claim [R${revisionId}:2].`)]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual({ quote: chunks[1], citation: {
      revisionId, sourceId: "guide-only", block: 2, start: blocks[1]?.start, end: blocks[1]?.end,
      sourceTitle: "Frozen source", deleted: false, label: `[R${revisionId}:2]`,
    } });
    expect(f.bucket.gets).toEqual([
      { key: `source/${revisionId}/blocks.json` },
      { key: `source/${revisionId}/text.md`, offset: blocks[1]?.start, length: (blocks[1]?.end ?? 0) - (blocks[1]?.start ?? 0) },
    ]);
  });

  it("hydrates guide references only from revisions in the frozen Wiki source set", async () => {
    const f = create();
    const revisionId = "source-b-r1", quote = "Cross-source guide evidence.\n";
    seedSourceBlocks(f, revisionId, [quote]);

    const evidence = await loadWikiEvidence(f.env, [
      wikiSource("source-a", "source-a-r1", `Guide reference [R${revisionId}:1].`),
      wikiSource("source-b", revisionId, null),
    ]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ quote, citation: {
      sourceId: "source-b", revisionId, sourceTitle: "Frozen source", block: 1, label: `[R${revisionId}:1]`,
    } });
  });

  it("deduplicates a block cited by both a verified claim and its guide", async () => {
    const f = create();
    const revisionId = "claim-guide-r1", chunk = "Whole source block, not just the claim quote.\n";
    seedSourceBlocks(f, revisionId, [chunk]);
    const sourceClaim = { ...claim("claim-guide", revisionId, "claim quote", "81%", 81), block: 1 };

    const evidence = await loadWikiEvidence(f.env, [wikiSource("claim-guide", revisionId,
      `Guide passage [R${revisionId}:1].`, [sourceClaim])]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.quote).toBe(chunk);
    expect(f.bucket.gets.filter((item) => item.key === `source/${revisionId}/text.md`)).toHaveLength(1);
  });

  it("uses exact UTF-8 byte offsets for a full non-ASCII block range", async () => {
    const f = create();
    const revisionId = "utf8-evidence-r1";
    const chunks = ["Prefix π 😀.\n", "Résumé — 東京 🧪.\n"];
    const blocks = seedSourceBlocks(f, revisionId, chunks);
    const start = new TextEncoder().encode(chunks[0]).byteLength;
    const end = start + new TextEncoder().encode(chunks[1]).byteLength;

    const evidence = await loadWikiEvidence(f.env, [wikiSource("utf8-source", revisionId, `[R${revisionId}:2]`)]);

    expect(evidence[0]).toMatchObject({ quote: chunks[1], citation: { block: 2, start, end, label: `[R${revisionId}:2]` } });
    expect(blocks[1]).toMatchObject({ start, end });
    expect(f.bucket.gets.at(-1)).toEqual({ key: `source/${revisionId}/text.md`, offset: start, length: end - start });
  });

  it("rejects a guide reference outside the frozen revision scope before reading R2", async () => {
    const f = create();

    await expect(loadWikiEvidence(f.env, [wikiSource("source-a", "source-a-r1", "Foreign quote [Rsource-b-r1:1].")]))
      .rejects.toMatchObject({ code: "conflict" });
    expect(f.bucket.gets).toHaveLength(0);
  });

  it("rejects an empty Wiki evidence set", async () => {
    const f = create();

    await expect(loadWikiEvidence(f.env, [wikiSource("source-a", "source-a-r1", null)]))
      .rejects.toMatchObject({ code: "invalid" });
    expect(f.bucket.gets).toHaveLength(0);
  });

  it("enforces the existing bounded context ceiling before reading passage bytes", async () => {
    const f = create();
    const revisionId = "large-evidence-r1";
    f.bucket.seed(`source/${revisionId}/blocks.json`, JSON.stringify([
      { id: 1, type: "paragraph", start: 0, end: 1_200_001, heading: null },
    ]));

    await expect(loadWikiEvidence(f.env, [wikiSource("large-source", revisionId, `[R${revisionId}:1]`)]))
      .rejects.toMatchObject({ code: "invalid" });
    expect(f.bucket.gets).toEqual([{ key: `source/${revisionId}/blocks.json` }]);
  });
});
