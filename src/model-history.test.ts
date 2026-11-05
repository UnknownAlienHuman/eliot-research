import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { Citation } from "./citations";
import { MATERIALIZATION_BYTES } from "./context";
import type { HistoryCandidate, HistoryExchange, HistoryStep, Materialization } from "./context";
import { estimateHistoryMessage } from "./model-input";
import { createModelHistoryReader } from "./model-history";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const citation = (revisionId: string): Citation => ({ revisionId, sourceId: "source", block: 1, start: 0, end: 12,
  sourceTitle: "Source", deleted: false, label: "[S1:1]" });

function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL,history_version INTEGER NOT NULL);" +
    "CREATE INDEX turns_by_created ON turns(created_at,id)");
  const assembly: Materialization = { used: 0, blocks: new Map(), rangeReads: 0 };
  const queries: Array<{ query: string; bindings: SQLInputValue[]; allocation: number; stringBytes: number }> = [];
  let rawJsonBytes = 0;
  const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
    if (query.includes("json_extract") || query.includes("SELECT payload ->")) {
      const payload = db.prepare("SELECT payload FROM turns WHERE id=?").get(bindings.at(-3) ?? null)?.payload;
      if (typeof payload === "string") rawJsonBytes += Buffer.byteLength(payload);
    }
    const rows = db.prepare(query).all(...bindings);
    queries.push({ query, bindings, allocation: assembly.used, stringBytes: rows.reduce((total, row) => total +
      Object.values(row).reduce<number>((bytes, value) => bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0), 0), 0) });
    return { toArray: () => rows };
  } } as unknown as SqlStorage;
  const insert = (id: string, at: number, fields: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({ question: "Question " + id, answer: "Answer " + id, state: "completed",
      revisionIds: [], citations: [], ...fields });
    db.prepare("INSERT INTO turns VALUES(?,?,?,1)").run(id, payload, at);
    return Buffer.byteLength(payload);
  };
  return { db, assembly, queries, insert, get rawJsonBytes() { return rawJsonBytes; },
    reader: (frozen: string[] = [], current = "current") => createModelHistoryReader(sql, current)(new Set(frozen), assembly) };
}
function candidate(step: HistoryStep): HistoryCandidate {
  expect(step.kind).toBe("candidate");
  if (step.kind !== "candidate") throw new Error("Expected candidate");
  return step.candidate;
}
function collect(reader: { next(): HistoryStep }): { exchanges: HistoryExchange[]; kinds: string[] } {
  const exchanges: HistoryExchange[] = [], kinds: string[] = [];
  while (true) {
    const step = reader.next(); kinds.push(step.kind);
    if (step.kind === "candidate") exchanges.push(step.candidate.load());
    if (step.kind === "end" || step.kind === "limited") return { exchanges, kinds };
  }
}

describe("budget-driven SQL model history", () => {
  it.each([120, 1100])("retains %i fitting exchanges independently of page/row counts", (count) => {
    const h = fixture();
    for (let i = 0; i < count; i++) h.insert("turn-" + String(i).padStart(4, "0"), i);
    h.insert("current", count, { state: "started" });
    const result = collect(h.reader());
    expect(result.exchanges).toHaveLength(count);
    expect(result.exchanges[0]?.assistant?.turnId).toBe("turn-" + String(count - 1).padStart(4, "0"));
    expect(result.exchanges.at(-1)?.assistant?.turnId).toBe("turn-0000");
    expect(result.kinds.filter(kind => kind === "ignored")).toHaveLength(1);
    expect(result.kinds.at(-1)).toBe("end");
    expect(h.assembly.used).toBeLessThan(MATERIALIZATION_BYTES);
    expect(h.rawJsonBytes).toBeLessThan(MATERIALIZATION_BYTES);
    expect(h.queries.filter(q => q.query.includes("ORDER BY")).every(q => q.query.endsWith("LIMIT 1"))).toBe(true);
  });

  it("passes 49 failed rows and uncited partials without consuming a retention slot", () => {
    const h = fixture(); h.insert("older", 0);
    for (let i = 1; i <= 49; i++) h.insert("failed-" + i, i, { state: "failed" });
    h.insert("uncited", 50, { state: "partial" });
    h.insert("cited", 51, { state: "partial", citations: [citation("rev")], revisionIds: ["rev"] });
    h.insert("current", 52, { state: "started" });
    const result = collect(h.reader(["rev"]));
    expect(result.exchanges.map(exchange => exchange.assistant?.turnId)).toEqual(["cited", "older"]);
    expect(result.exchanges[0]?.assistant?.partial).toBe(true);
    expect(result.kinds.filter(kind => kind === "ignored")).toHaveLength(51);
    expect(h.queries.filter(q => q.query.includes("SELECT payload ->"))).toHaveLength(2);
  });

  it("uses the physical ordering index for both initial and keyset size probes", () => {
    const h = fixture();
    for (let i = 0; i < 40; i++) h.insert("turn-" + String(i).padStart(3, "0"), Math.floor(i / 20));
    const reader = h.reader();
    expect(candidate(reader.next()).load().assistant?.turnId).toBe("turn-039");
    expect(candidate(reader.next()).load().assistant?.turnId).toBe("turn-038");
    const probes = h.queries.filter(query => query.query.includes("ORDER BY"));
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      const plan = h.db.prepare("EXPLAIN QUERY PLAN " + probe.query).all(...probe.bindings).map(row => String(row.detail));
      expect(plan.some(detail => detail.includes("turns_by_created"))).toBe(true);
      expect(plan.some(detail => detail.includes("TEMP B-TREE"))).toBe(false);
    }
  });

  it("stops at an invalid newest raw identity instead of sorting it behind a valid tie", () => {
    const h = fixture(); h.insert("a", 1); h.insert("z".repeat(129), 1);
    expect(h.reader().next()).toEqual({ kind: "limited" });
    expect(h.queries).toHaveLength(1);
    expect(h.rawJsonBytes).toBe(0);
  });

  it("uses only actual assistant citations for pair scope eligibility and preserves user scope for label checks", () => {
    const h = fixture();
    h.insert("in-scope", 1, { revisionIds: ["unused", "rev"], citations: [citation("rev")] });
    h.insert("no-citations", 2, { revisionIds: ["outside"] });
    h.insert("outside", 3, { revisionIds: ["rev"], citations: [citation("outside")] });
    const reader = h.reader(["rev"]);
    expect(reader.next()).toEqual({ kind: "omitted" });
    const uncited = candidate(reader.next()).load();
    expect(uncited.user.revisionIds).toEqual(["outside"]);
    expect(uncited.assistant?.revisionIds).toEqual([]);
    const cited = candidate(reader.next()).load();
    expect(cited.user.revisionIds).toEqual(["unused", "rev"]);
    expect(cited.assistant?.revisionIds).toEqual(["rev"]);
  });

  it("preserves equal-time keyset order without skips or duplicate exchanges", () => {
    const h = fixture();
    for (const id of ["a", "b", "c"]) h.insert(id, 1);
    expect(collect(h.reader()).exchanges.map(exchange => exchange.assistant?.turnId)).toEqual(["c", "b", "a"]);
  });

  it.each(["plain", "a\u0000b", "\ud800", "\udc00", "😀", "é", '\\"\n', "Кириллица"]) (
    "round-trips JSON string fragments and matches token estimates for %j", (text) => {
      const h = fixture(); h.insert("unicode", 1, { question: text, answer: text });
      const planned = candidate(h.reader().next());
      expect(planned.tokens).toBe(estimateHistoryMessage({ role: "user", content: text }) + estimateHistoryMessage({ role: "assistant", content: text }));
      const loaded = planned.load();
      expect(loaded.user.content).toBe(text);
      expect(loaded.assistant?.content).toBe(text);
      expect(h.queries.some(q => q.query.includes("json_extract(payload,'$.question')"))).toBe(false);
    },
  );

  it("probes oversized raw JSON before any extraction or payload transfer", () => {
    const h = fixture();
    h.insert("oversized", 1, { privateUnusedField: "x".repeat(MATERIALIZATION_BYTES) });
    const reader = h.reader();
    expect(reader.next()).toEqual({ kind: "limited" });
    expect(reader.next()).toEqual({ kind: "end" });
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.query).not.toMatch(/json_| -> /);
    expect(h.queries[0]?.stringBytes).toBe(Buffer.byteLength("oversized"));
    expect(h.rawJsonBytes).toBe(0);
  });

  it("bounds cumulative raw scans even when ignored rows have almost no transferred metadata", () => {
    const h = fixture();
    for (let i = 0; i < 20; i++) h.insert("failed-" + i, i, { state: "failed", answer: "x".repeat(1024 * 1024) });
    const result = collect(h.reader());
    expect(result.exchanges).toHaveLength(0);
    expect(result.kinds.at(-1)).toBe("limited");
    expect(h.rawJsonBytes).toBeLessThanOrEqual(MATERIALIZATION_BYTES);
    expect(h.queries.every(q => !q.query.includes("SELECT payload ->"))).toBe(true);
    expect(h.queries.reduce((bytes, q) => bytes + q.stringBytes, 0)).toBeLessThan(1024);
  });

  it("does not expose a candidate whose future fragment read exceeds the raw scan allowance", () => {
    const h = fixture();
    h.insert("large", 1, { privateUnusedField: "x".repeat(Math.floor(MATERIALIZATION_BYTES / 2)) });
    expect(h.reader().next()).toEqual({ kind: "limited" });
    expect(h.queries.filter(q => q.query.includes("SELECT payload ->"))).toHaveLength(0);
    expect(h.rawJsonBytes).toBeLessThan(MATERIALIZATION_BYTES);
  });

  it.each(["history_version=history_version+1", "created_at=created_at+1"]) (
    "rejects a changed pinned row before body transfer (%s)", (change) => {
      const h = fixture(); h.insert("changed", 1);
      const planned = candidate(h.reader().next());
      h.db.prepare("UPDATE turns SET " + change + ",payload=? WHERE id='changed'").run(JSON.stringify({ answer: "x".repeat(1024 * 1024) }));
      expect(() => planned.load()).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
      expect(h.queries.at(-1)?.stringBytes).toBe(0);
    },
  );

  it("rejects a removed pinned row rather than retrying a different history identity", () => {
    const h = fixture(); h.insert("removed", 1);
    const planned = candidate(h.reader().next()); h.db.prepare("DELETE FROM turns WHERE id='removed'").run();
    expect(() => planned.load()).toThrow(expect.objectContaining({ code: "unavailable", status: 503 }));
    expect(h.queries.filter(q => q.query.includes("SELECT payload ->"))).toHaveLength(1);
  });

  it("caches a successful load across context retries without more reads or allocations", () => {
    const h = fixture(); h.insert("cached", 1);
    const planned = candidate(h.reader().next()), before = h.assembly.used, loadBytes = planned.bytes;
    expect(h.queries.filter(q => q.query.includes("SELECT payload ->"))).toHaveLength(0);
    const first = planned.load(), reads = h.queries.length, allocation = h.assembly.used;
    expect(allocation - before).toBe(loadBytes);
    expect(planned.bytes).toBe(0);
    expect(planned.load()).toBe(first);
    expect(h.queries).toHaveLength(reads);
    expect(h.assembly.used).toBe(allocation);
  });

  it("charges physical transfer and parse allocation before the SQL load and never exceeds the shared guard", () => {
    const h = fixture(); h.insert("bounded", 1, { question: "q".repeat(100000), answer: "a".repeat(100000),
      revisionIds: ["rev"], citations: [citation("rev")] });
    const planned = candidate(h.reader(["rev"]).next());
    const metadataAllocation = h.assembly.used, loadBytes = planned.bytes;
    h.assembly.used = MATERIALIZATION_BYTES - planned.bytes + 1;
    const reads = h.queries.length;
    expect(() => planned.load()).toThrow(expect.objectContaining({ status: 400 }));
    expect(h.queries).toHaveLength(reads);
    h.assembly.used = metadataAllocation;
    planned.load();
    const load = h.queries.at(-1);
    expect(load?.allocation).toBe(metadataAllocation + loadBytes);
    expect(loadBytes).toBeGreaterThanOrEqual(4 * (load?.stringBytes ?? 0));
    expect(h.assembly.used).toBeLessThanOrEqual(MATERIALIZATION_BYTES);
  });

  it("refuses a metadata query before allocating beyond the shared guard", () => {
    const h = fixture(); h.insert("unread", 1); h.assembly.used = MATERIALIZATION_BYTES;
    expect(h.reader().next()).toEqual({ kind: "limited" });
    expect(h.queries).toHaveLength(0);
    expect(h.assembly.used).toBe(MATERIALIZATION_BYTES);
  });
});
