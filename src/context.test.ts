import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import { resolveCitations } from "./citations.js";
import { LibraryError } from "./library.js";
import { modelOutputLimit } from "./models.js";
import type { Actor } from "./auth";

const NL = String.fromCharCode(10);
const actor = { type: "owner", id: "o1", authentication: "local" } as unknown as Actor;
const MODEL = { contextTokens: 1048576, maxOutputTokens: 2000 };

interface MemSource {
  id: string;
  title: string;
  state: string;
  currentRevisionId: string | null;
  createdAt: number;
}
interface MemRevision {
  id: string;
  readableState: string;
  readableSize: number | null;
  distillState: string | null;
  guideSummary: string | null;
  deletedAt: number | null;
  reportKey?: string | null;
  claimCount?: number | null;
}
interface MemMembership {
  projectId: string;
  sourceId: string;
  enabled: number;
}
interface MemBlock {
  id: number;
  type: string;
  start: number;
  end: number;
  heading: string | null;
}
interface MemClaim {
  ordinal: number;
  statement: string;
  quote: string;
  conditions: string | null;
  blockIndex: number;
  ambiguous: number;
}
interface MemText {
  text?: string;
  guide?: string | undefined;
  checkedGuide?: string | undefined;
  report?: unknown;
  blocks: MemBlock[];
}

function wholeBlock(text: string, id: number): MemBlock {
  return { id, type: "paragraph", start: 0, end: text.length, heading: null as string | null };
}

function makeEnv(opts: { memberships: MemMembership[]; sources: MemSource[]; revisions: MemRevision[]; texts: Record<string, MemText>; claims?: Record<string, MemClaim[]> }) {
  let reads = 0;
  const requested: string[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM project WHERE")) {
                const id = params[0] as string;
                const known = id === "p1" || opts.memberships.some((m) => m.projectId === id);
                return known ? { id } : null;
              }
              if (sql.includes("ps.source_id=?")) {
                const projectId = params[0] as string;
                const sourceId = params[1] as string;
                const m = opts.memberships.find((x) => x.projectId === projectId && x.sourceId === sourceId);
                if (!m) return null;
                const s = opts.sources.find((x) => x.id === sourceId);
                if (!s || s.state !== "active" || !s.currentRevisionId) return null;
                const r = opts.revisions.find((x) => x.id === s.currentRevisionId);
                return { id: s.id, title: s.title, revisionId: s.currentRevisionId, readableState: r ? r.readableState : null, readableSize: r ? r.readableSize : null, distillState: r ? r.distillState : null, guideSummary: r ? r.guideSummary : null, reportKey: r?.reportKey ?? null };
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM claim")) {
                const rev = params[0] as string;
                const head = opts.revisions.find((x) => x.id === rev)?.claimCount;
                const rows = (opts.claims?.[rev] ?? [])
                  .filter((c) => c.ambiguous === 0 && (typeof head !== "number" || c.ordinal < head))
                  .sort((a, b) => a.ordinal - b.ordinal);
                return { results: rows.map((c) => ({ ordinal: c.ordinal, statement: c.statement, quote: c.quote, conditions: c.conditions, blockIndex: c.blockIndex })) };
              }
              const projectId = params[0] as string;
              const rows = opts.memberships
                .filter((m) => m.projectId === projectId && m.enabled === 1)
                .map((m) => opts.sources.find((s) => s.id === m.sourceId))
                .filter((s): s is MemSource => !!s && s.state === "active" && !!s.currentRevisionId)
                .filter((s) => {
                  const r = opts.revisions.find((x) => x.id === s.currentRevisionId);
                  return !!r && (r.readableState === "readable" || r.readableState === "readable_with_warnings") && r.deletedAt === null;
                })
                .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
                .map((s) => {
                  const r = opts.revisions.find((x) => x.id === s.currentRevisionId);
                  return { id: s.id, title: s.title, revisionId: s.currentRevisionId as string, readableSize: r ? r.readableSize : null, distillState: r ? r.distillState : null, guideSummary: r ? r.guideSummary : null, reportKey: r?.reportKey ?? null };
                });
              return { results: rows };
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
  const BUCKET = {
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      reads += 1;
      const byteRange = options?.range;
      requested.push(byteRange ? key + "#r" + byteRange.offset + "-" + (byteRange.offset + byteRange.length) : key);
      const parts = key.split("/");
      if ((parts.length !== 3 && parts.length !== 4) || parts[0] !== "source") return null;
      const rev = parts[1] as string;
      const kind = parts.slice(2).join("/");
      const entry = opts.texts[rev];
      if (!entry) return null;
      if (kind === "text.md") {
        if (entry.text === undefined) return null;
        const bytes = new TextEncoder().encode(entry.text);
        const view = byteRange ? bytes.subarray(byteRange.offset, byteRange.offset + byteRange.length) : bytes;
        const exact = Uint8Array.from(view);
        return { arrayBuffer: async () => exact.buffer as ArrayBuffer };
      }
      if (kind === "guide.md") {
        if (entry.guide === undefined) return null;
        const data = new TextEncoder().encode(entry.guide);
        return { arrayBuffer: async () => data.buffer as ArrayBuffer };
      }
      if (kind === "checked/guide.md") {
        if (entry.checkedGuide === undefined) return null;
        const data = new TextEncoder().encode(entry.checkedGuide);
        return { arrayBuffer: async () => data.buffer as ArrayBuffer };
      }
      if (kind === "checked/distill.json") {
        if (entry.report === undefined) return null;
        const raw = typeof entry.report === "string" ? entry.report : JSON.stringify(entry.report);
        const data = new TextEncoder().encode(raw);
        return { arrayBuffer: async () => data.buffer as ArrayBuffer };
      }
      if (kind === "blocks.json") return { json: async () => entry.blocks };
      return null;
    },
  };
  return { env: { DB, BUCKET } as unknown as Env, reads: () => reads, requested };
}

function twoSourceEnv() {
  const textA = "Intro A." + NL + NL + "Second A." + NL;
  const textB = "Paper B body." + NL;
  return makeEnv({
    memberships: [
      { projectId: "p1", sourceId: "s1", enabled: 1 },
      { projectId: "p1", sourceId: "s2", enabled: 1 },
      { projectId: "p1", sourceId: "s3", enabled: 0 },
    ],
    sources: [
      { id: "s1", title: "Paper A", state: "active", currentRevisionId: "r1", createdAt: 1 },
      { id: "s2", title: "Paper B", state: "active", currentRevisionId: "r2", createdAt: 2 },
      { id: "s3", title: "Hidden", state: "active", currentRevisionId: "r3", createdAt: 3 },
    ],
    revisions: [
      { id: "r1", readableState: "readable", readableSize: 20, distillState: "done", guideSummary: null, deletedAt: null },
      { id: "r2", readableState: "readable_with_warnings", readableSize: 14, distillState: "done", guideSummary: null, deletedAt: null },
      { id: "r3", readableState: "readable", readableSize: 13, distillState: "done", guideSummary: null, deletedAt: null },
    ],
    texts: {
      r1: { text: textA, blocks: [{ id: 1, type: "paragraph", start: 0, end: 8, heading: null }, { id: 2, type: "paragraph", start: 10, end: 19, heading: null }] },
      r2: { text: textB, blocks: [wholeBlock(textB, 1)] },
      r3: { text: "Hidden body." + NL, blocks: [] },
    },
  });
}

describe("buildContext K2 whole scope", () => {
  it("freezes enabled readable revisions with per-block labels and sourceIds", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Background [S9:9] note" },
        { role: "assistant", content: "Old answer [S1:1] kept", revisionIds: ["r1"] },
        { role: "assistant", content: "Stale answer", revisionIds: ["rz"] },
      ],
    });
    expect(res.mode).toBe("whole");
    expect(res.revisionIds).toEqual(["r1", "r2"]);
    expect(res.sources.map((s) => s.sourceId)).toEqual(["s1", "s2"]);
    expect(res.sources.map((s) => s.alias)).toEqual(["S1", "S2"]);
    expect(res.sources.map((s) => s.blocks.length)).toEqual([2, 1]);
    const resolved = resolveCitations("Fact [S1:1] here [S9:9] gone.", res.sources);
    expect(resolved.citations.length).toBe(1);
    expect(resolved.citations[0]?.sourceId).toBe("s1");
    expect(resolved.citations[0]?.label).toBe("[S1:1]");
    expect(resolved.invalidLabels).toBe(1);
    expect(res.messages[0]?.role).toBe("system");
    expect(res.messages[1]).toMatchObject({ role: "user" });
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("[S1:1] Intro A.");
    expect(body).toContain("[S1:2] Second A.");
    expect(body).toContain("[S2:1] Paper B body.");
    expect(body).not.toContain("[S9:9]");
    expect(body).toContain("Old answer");
    expect(body).not.toContain("Stale answer");
    expect(res.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("narrowed scope keeps answers citing only A and drops answers citing B", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "explicit",
      sourceIds: ["s1"],
      model: MODEL,
      history: [
        { role: "user", content: "Question about A" },
        { role: "assistant", content: "Cited A answer [S1:1] kept", revisionIds: ["r1"] },
        { role: "assistant", content: "Cited B answer [S2:1] gone", revisionIds: ["r2"] },
      ],
    });
    expect(res.mode).toBe("whole");
    expect(res.revisionIds).toEqual(["r1"]);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Question about A");
    expect(body).toContain("Cited A answer");
    expect(body).not.toContain("Cited B answer");
  });

  it("explicit empty scope never falls back and reads no storage", async () => {
    const { env, reads } = twoSourceEnv();
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: [], model: MODEL });
    expect(res.mode).toBe("none");
    expect(res.revisionIds).toEqual([]);
    expect(res.sources).toEqual([]);
    expect(res.messages.length).toBe(2);
    expect(res.messages[1]).toMatchObject({ role: "system" });
    expect(res.messages[1]?.content).toContain("No Library sources selected");
    expect(reads()).toBe(0);
  });

  it("reserves the empty-scope policy before admitting the request", async () => {
    const { env, reads } = twoSourceEnv();
    const base = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL });
    const systemTokens = Math.ceil(new TextEncoder().encode(base.messages[0]?.content ?? "").byteLength / 3);
    const maxOutputTokens = 100;
    const contextTokens = Math.ceil((systemTokens + maxOutputTokens) / 0.6);
    expect(base.estimatedInputTokens + maxOutputTokens).toBeGreaterThan(Math.floor(contextTokens * 0.6));

    await expect(buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens, maxOutputTokens },
    })).rejects.toMatchObject({ code: "invalid", status: 400, message: "Narrow the source selection so the answer fits." });
    expect(reads()).toBe(0);
  });

  it("keeps empty-scope history inside the cap after reserving its policy", async () => {
    const { env, reads } = twoSourceEnv();
    const base = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL });
    const contextTokens = 2000, cap = Math.floor(contextTokens * 0.6);
    const maxOutputTokens = cap - base.estimatedInputTokens - 10;
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens, maxOutputTokens },
      history: [
        { role: "user", content: "q".repeat(60), revisionIds: [] },
        { role: "assistant", content: "a".repeat(60), turnId: "prior", wireTokens: 20 },
      ],
    });
    expect(res.mode).toBe("none");
    expect(res.revisionIds).toEqual([]);
    expect(res.sources).toEqual([]);
    expect(res.messages.some((message) => message.role === "assistant")).toBe(false);
    expect(res.estimatedInputTokens + maxOutputTokens).toBeLessThanOrEqual(cap);
    expect(reads()).toBe(0);
  });

  it("explicit rejects ids outside the project", async () => {
    const { env } = twoSourceEnv();
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["ghost"], model: MODEL });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    expect((err as LibraryError).status).toBe(400);
  });

  it("post-load overflow without sizes still throws narrow-scope", async () => {
    const big = "x".repeat(9000);
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Big", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: null, distillState: "queued", guideSummary: null, deletedAt: null }],
      texts: { r1: { text: big, blocks: [wholeBlock(big, 1)] } },
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
  });

  it("rejects a huge scope from D1 sizes before R2 loads", async () => {
    const { env, reads } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Native25", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, distillState: "queued", guideSummary: null, deletedAt: null }],
      texts: {},
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    expect((err as LibraryError).status).toBe(400);
    expect(reads()).toBe(0);
  });

  it("treats empty block maps as unavailable without inventing labels", async () => {
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "NoBlocks", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: 10, distillState: "done", guideSummary: null, deletedAt: null }],
      texts: { r1: { text: "Orphan text.", blocks: [] } },
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("unavailable");
    expect((err as LibraryError).status).toBe(503);
  });

  it("caps history at newest ten percent of context", async () => {
    const { env } = twoSourceEnv();
    const pad = "y".repeat(2994);
    const history = [1, 2, 3, 4, 5].map((n) => ({ role: "user" as const, content: "MARK" + n + " " + pad }));
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "empty",
      model: { contextTokens: 20000, maxOutputTokens: 100 },
      history,
    });
    expect(res.mode).toBe("none");
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("MARK5");
    expect(body).toContain("MARK4");
    expect(body).not.toContain("MARK1");
  });

  it("retains private replay identity only on the selected assistant exchange", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model: MODEL,
      history: [
        { role: "user", content: "Kept question", revisionIds: ["r1"] },
        { role: "assistant", content: "Kept answer [S1:1]", revisionIds: ["r1"], turnId: "kept", wireTokens: 50 },
        { role: "user", content: "Excluded question", revisionIds: ["r2"] },
        { role: "assistant", content: "Excluded answer", revisionIds: ["r2"], turnId: "excluded", wireTokens: 50 },
      ],
    });
    expect(res.messages.filter((message) => message.role === "assistant")).toEqual([
      { role: "assistant", content: "Kept answer", turnId: "kept" },
    ]);
    expect(res.messages.some((message) => message.content.includes("Excluded question"))).toBe(false);
  });

  it("counts private protocol data against the history budget without putting it in context", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens: 20000, maxOutputTokens: 100 },
      history: [
        { role: "user", content: "Small visible question", revisionIds: [] },
        { role: "assistant", content: "Small visible answer", turnId: "large-wire", wireTokens: 2001 },
      ],
    });
    expect(res.messages.some((message) => message.role === "assistant")).toBe(false);
    expect(res.messages.some((message) => message.content.includes("Small visible question"))).toBe(false);
  });

  it.each([
    { name: "excludes private wire after narrowing its full scope", fullScope: ["r1", "r2"], wire: true, keep: false },
    { name: "reuses public text whose actual citations remain in scope", fullScope: ["r1", "r2"], wire: false, keep: true },
    { name: "excludes private wire without declared prior full scope", fullScope: undefined, wire: true, keep: false },
  ])("$name", async ({ fullScope, wire, keep }) => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model: MODEL,
      history: [
        { role: "user", content: "Prior multi-source question", ...(fullScope === undefined ? {} : { revisionIds: fullScope }) },
        { role: "assistant", content: "Answer citing only the retained source [S1:1]", revisionIds: ["r1"], turnId: "prior",
          ...(wire ? { wireTokens: 50 } : {}) },
      ],
    });
    expect(res.mode).toBe("whole");
    expect(res.revisionIds).toEqual(["r1"]);
    expect(res.sources.map((source) => source.sourceId)).toEqual(["s1"]);
    expect(res.messages.some((message) => message.content === "Prior multi-source question")).toBe(keep);
    expect(res.messages.filter((message) => message.role === "assistant")).toEqual(keep
      ? [{ role: "assistant", content: "Answer citing only the retained source", turnId: "prior" }]
      : []);
  });

  it("replays private compact labels only when their prior scope is an unchanged prefix", async () => {
    const ids = ["1", "2", "3"];
    const { env } = makeEnv({
      memberships: ids.map((id) => ({ projectId: "p1", sourceId: "s" + id, enabled: 1 })),
      sources: ids.map((id) => ({ id: "s" + id, title: "Source " + id, state: "active", currentRevisionId: "r" + id, createdAt: Number(id) })),
      revisions: ids.map((id) => ({ id: "r" + id, readableState: "readable", readableSize: 7, distillState: "done", guideSummary: null, deletedAt: null })),
      texts: Object.fromEntries(ids.map((id) => ["r" + id, { text: "Text " + id + ".", blocks: [wholeBlock("Text " + id + ".", 1)] }])),
    });
    const user = { role: "user" as const, content: "Earlier two-source question", revisionIds: ["r1", "r2"] };
    const assistant = { role: "assistant" as const, content: "Earlier result [S1:1] [S2:1]", revisionIds: ["r1", "r2"], turnId: "prior" };
    for (const { sourceIds, keep } of [
      { sourceIds: ["s2", "s1"], keep: false },
      { sourceIds: ["s3", "s1", "s2"], keep: false },
      { sourceIds: ["s1", "s2", "s3"], keep: true },
    ]) {
      const res = await buildContext(env, actor, {
        projectId: "p1", scopeMode: "explicit", sourceIds, model: MODEL,
        history: [user, { ...assistant, wireTokens: 50 }],
      });
      expect(res.sources.map((source) => source.revisionId)).toEqual(sourceIds.map((id) => id.replace("s", "r")));
      expect(res.messages.some((message) => message.content === user.content)).toBe(keep);
      expect(res.messages.filter((message) => message.role === "assistant")).toEqual(keep
        ? [{ role: "assistant", content: "Earlier result", turnId: "prior" }]
        : []);
    }
    const publicHistory = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "explicit", sourceIds: ["s2", "s1"], model: MODEL, history: [user, assistant],
    });
    expect(publicHistory.messages.filter((message) => message.role === "assistant")).toEqual([
      { role: "assistant", content: "Earlier result", turnId: "prior" },
    ]);
  });

  it("admits empty and small scopes on a high-output model via outputReserveTokens", async () => {
    const dots = { contextTokens: 512000, maxOutputTokens: 460800, outputReserveTokens: 8192 };
    expect(modelOutputLimit({ maxOutputTokens: 460800 })).toBe(460800);
    expect(modelOutputLimit(dots)).toBe(8192);
    const { env } = twoSourceEnv();
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: [], model: { contextTokens: 512000, maxOutputTokens: 460800 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    const empty = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: [], model: dots });
    expect(empty.mode).toBe("none");
    expect(empty.revisionIds).toEqual([]);
    const small = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model: dots });
    expect(small.mode).toBe("whole");
    expect(small.revisionIds).toEqual(["r1"]);
  });
});

describe("buildContext K3 claims fallback", () => {
  function claimsEnv() {
    return makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: "Guide A.", deletedAt: null, claimCount: 4 }],
      texts: { r9: { guide: "See [S9:9] and [R00000000-0000-0000-0000-000000000000:2].", blocks: [{ id: 1, type: "paragraph", start: 0, end: 9, heading: null }, { id: 2, type: "paragraph", start: 10, end: 19, heading: null }, { id: 3, type: "paragraph", start: 20, end: 29, heading: null }] } },
      claims: {
        r9: [
          { ordinal: 1, statement: "First finding", quote: "quoted one", conditions: null, blockIndex: 2, ambiguous: 0 },
          { ordinal: 2, statement: "Second finding", quote: "quoted two", conditions: "when calm", blockIndex: 3, ambiguous: 0 },
          { ordinal: 3, statement: "Shaky finding", quote: "quoted three", conditions: null, blockIndex: 2, ambiguous: 1 },
        ],
      },
    });
  }

  it("falls back to claims without loading whole text", async () => {
    const { env, requested } = claimsEnv();
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual(["r9"]);
    expect(res.sources.map((s) => s.alias)).toEqual(["S1"]);
    expect(res.sources[0]?.blocks.map((b) => b.id)).toEqual([2, 3]);
    expect(requested.some((k) => k.endsWith("text.md"))).toBe(false);
    expect(res.messages[1]).toMatchObject({ role: "user" });
    const body = res.messages.map((m) => m.content).join(NL);
    expect(res.messages[1]?.content).toContain("[S1:2] quoted one");
    expect(res.messages[1]?.content).not.toContain("First finding");
    expect(res.messages[2]?.content).toContain("First finding");
    expect(body).not.toContain("S9:9");
    expect(body).not.toContain("Guide A.");
    const resolved = resolveCitations("Claim holds [S1:3] but not [S1:1].", res.sources);
    expect(resolved.citations.length).toBe(1);
    expect(resolved.citations[0]?.sourceId).toBe("s1");
    expect(resolved.invalidLabels).toBe(1);
  });

  it("keeps derived drafts separate and deduplicates only identical original quotes in one block", async () => {
    const quote = "Model Alpha uses the reference training procedure.";
    const otherQuote = "The experiment retains its original evaluation conditions.";
    const passage = quote + NL + otherQuote;
    const text = passage + NL + "Unselected source material. ".repeat(400);
    const passageEnd = new TextEncoder().encode(passage).byteLength;
    const byteLength = new TextEncoder().encode(text).byteLength;
    const wrongStatement = "Model Alpha was evaluated on an unrelated benchmark.";
    const wrongConditions = "using invented evaluation settings";
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: byteLength, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 3 }],
      texts: { r9: { text, guide: "No guide passages selected.", blocks: [
        { id: 2, type: "paragraph", start: 0, end: passageEnd, heading: null },
        { id: 3, type: "paragraph", start: passageEnd + 1, end: byteLength, heading: null },
      ] } },
      claims: { r9: [
        { ordinal: 0, statement: wrongStatement, quote, conditions: wrongConditions, blockIndex: 2, ambiguous: 0 },
        { ordinal: 1, statement: "A derived method description.", quote, conditions: null, blockIndex: 2, ambiguous: 0 },
        { ordinal: 2, statement: "A derived evaluation description.", quote: otherQuote, conditions: null, blockIndex: 2, ambiguous: 0 },
      ] },
    });
    const model = { contextTokens: 5000, maxOutputTokens: 100 };
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model });
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual(["r9"]);
    expect(res.sources).toMatchObject([{ sourceId: "s1", revisionId: "r9", alias: "S1" }]);
    expect(res.sources[0]?.blocks).toEqual([{ id: 2, type: "paragraph", start: 0, end: passageEnd, heading: null }]);
    expect(res.messages[1]?.role).toBe("user");
    const source = res.messages[1]?.content ?? "";
    expect(source).toContain("[S1:2] " + quote);
    expect(source).toContain("[S1:2] " + otherQuote);
    expect(source.split(quote).length - 1).toBe(1);
    expect(source.split(otherQuote).length - 1).toBe(1);
    expect(source).not.toContain(wrongStatement);
    expect(source).not.toContain(wrongConditions);
    expect(source).not.toContain("A derived");
    expect(res.messages[2]?.role).toBe("user");
    const orientation = res.messages[2]?.content ?? "";
    expect(orientation).toMatch(/orientation/i);
    expect(orientation).toContain("not source evidence");
    expect(orientation).toContain(wrongStatement);
    expect(orientation).toContain(wrongConditions);
    expect(orientation).not.toMatch(/\[S\d+:\d+\]/);
    expect(requested.filter((key) => key.includes("text.md"))).toEqual([]);
    expect(res.estimatedInputTokens).toBe(res.messages.reduce((sum, message) => sum + Math.ceil(new TextEncoder().encode(message.content).byteLength / 3), 0));
    expect(res.estimatedInputTokens + model.maxOutputTokens).toBeLessThanOrEqual(Math.min(Math.floor(model.contextTokens * 0.6), 400000));
    const resolved = resolveCitations("Original [S1:2], unseen [S1:3].", res.sources);
    expect(resolved.citations).toMatchObject([{ sourceId: "s1", revisionId: "r9", block: 2, start: 0, end: passageEnd }]);
    expect(resolved.invalidLabels).toBe(1);
  });

  it("reserved caller text pushes whole over cap and chooses claims", async () => {
    const body = "T".repeat(600);
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 600, distillState: "done", guideSummary: "Guide: G.", deletedAt: null, claimCount: 2 }],
      texts: { r9: { text: body, guide: "See nothing.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 300, heading: null }, { id: 2, type: "paragraph", start: 300, end: 600, heading: null }] } },
      claims: { r9: [{ ordinal: 1, statement: "Finding one", quote: "quoted one", conditions: null, blockIndex: 2, ambiguous: 0 }] },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 1200, maxOutputTokens: 100 }, question: "Q" + "q".repeat(539), instructions: "I" + "i".repeat(539) });
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual(["r9"]);
    expect(requested.some((k) => k.endsWith("text.md"))).toBe(false);
    expect(res.messages[1]).toMatchObject({ role: "user" });
    const text = res.messages.map((m) => m.content).join(NL);
    expect(res.messages[1]?.content).toContain("[S1:2] quoted one");
    expect(res.messages[1]?.content).not.toContain("Finding one");
    expect(res.messages[2]?.content).toContain("Finding one");
    expect(text).not.toContain("qqqq");
    expect(res.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("claims overflow errors instead of narrowing scope", async () => {
    const big = "finding detail " + "x".repeat(160);
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: "Guide A.", deletedAt: null, claimCount: 6 }],
      texts: { r9: { guide: "See nothing.", blocks: [1, 2, 3, 4, 5, 6].map((id) => ({ id, type: "paragraph", start: 0, end: 5, heading: null })) } },
      claims: { r9: [1, 2, 3, 4, 5].map((n) => ({ ordinal: n, statement: "Finding " + n + " " + big, quote: "quoted " + n, conditions: null, blockIndex: n, ambiguous: 0 })) },
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 900, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    expect((err as LibraryError).status).toBe(400);
  });

  it("undistilled scope reports understanding-needed, not silent whole", async () => {
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Big", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: 26214400, distillState: "queued", guideSummary: null, deletedAt: null }],
      texts: {},
      claims: {},
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    expect((err as LibraryError).message).toMatch(/understood/);
  });

  it("distilled scope without usable claims reports understanding-needed", async () => {
    const { env, reads } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "NoClaims", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: { r1: { blocks: [{ id: 1, type: "paragraph", start: 0, end: 5, heading: null }] } },
      claims: { r1: [{ ordinal: 1, statement: "Maybe", quote: "maybe", conditions: null, blockIndex: 1, ambiguous: 1 }] },
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    expect((err as LibraryError).message).toMatch(/understood/);
    expect(reads()).toBe(1);
  });
  it("prints only own-revision persistent guide refs as citable passages", async () => {
    const rev = "9f3b1c2d-4a5e-4f6a-8b7c-9d0e1f2a3b4c";
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: rev, createdAt: 1 }],
      revisions: [{ id: rev, readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: { [rev]: { text: "012345678901234567890123456789", blocks: [{ id: 1, type: "paragraph", start: 0, end: 9, heading: null }, { id: 2, type: "paragraph", start: 10, end: 19, heading: null }, { id: 3, type: "paragraph", start: 20, end: 29, heading: null }], guide: "Intro [S1:2] plus [R00000000-0000-0000-0000-000000000000:2] plus [R" + rev + ":2] plus [R" + rev + ":99] end." } },
      claims: { [rev]: [{ ordinal: 1, statement: "Claimed", quote: "quoted", conditions: null, blockIndex: 3, ambiguous: 0 }] },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
    expect(res.mode).toBe("claims");
    expect(res.sources[0]?.blocks.map((b) => b.id)).toEqual([2, 3]);
    expect(requested.filter((k) => k.includes("text.md"))).toEqual(["source/" + rev + "/text.md#r10-19"]);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("[S1:2] 012345678");
    const resolved = resolveCitations("Guide says [S1:2] but not [S1:1].", res.sources);
    expect(resolved.citations.length).toBe(1);
    expect(resolved.citations[0]?.sourceId).toBe("s1");
    expect(resolved.invalidLabels).toBe(1);
  });

  it("missing guide for a distilled revision is actionable unavailable", async () => {
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: { r9: { text: "x".repeat(30), blocks: [{ id: 1, type: "paragraph", start: 0, end: 5, heading: null }] } },
      claims: { r9: [{ ordinal: 1, statement: "Claimed", quote: "quoted", conditions: null, blockIndex: 1, ambiguous: 0 }] },
    });
    let err: unknown;
    try {
      await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("unavailable");
    expect((err as LibraryError).status).toBe(503);
  });

  it("claim head bound excludes retained trailing legacy rows", async () => {
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: { r9: { text: "AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDD", guide: "See nothing.", blocks: [1, 2, 3, 4].map((id) => ({ id, type: "paragraph", start: (id - 1) * 10, end: id * 10, heading: null })) } },
      claims: {
        r9: [
          { ordinal: 0, statement: "Current A", quote: "quoted A", conditions: null, blockIndex: 3, ambiguous: 0 },
          { ordinal: 1, statement: "Current B", quote: "quoted B", conditions: null, blockIndex: 4, ambiguous: 0 },
          { ordinal: 2, statement: "Legacy X", quote: "quoted X", conditions: null, blockIndex: 1, ambiguous: 0 },
          { ordinal: 3, statement: "Legacy Y", quote: "quoted Y", conditions: null, blockIndex: 1, ambiguous: 0 },
        ],
      },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
    expect(res.mode).toBe("claims");
    expect(res.sources[0]?.blocks.map((b) => b.id)).toEqual([3, 4]);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Current A");
    expect(body).toContain("Current B");
    expect(body).not.toContain("Legacy");
  });

});

describe("buildContext K3 report artifact guide", () => {
  const rev = "9f3b1c2d-4a5e-4f6a-8b7c-9d0e1f2a3b4c";
  const text = "AAAAAAAAAABBBBBBBBBBCCCCCCCCCC";
  const blocks = [
    { id: 1, type: "paragraph", start: 0, end: 10, heading: null as string | null },
    { id: 2, type: "paragraph", start: 10, end: 20, heading: null as string | null },
    { id: 3, type: "paragraph", start: 20, end: 30, heading: null as string | null },
  ];
  const claims = [{ ordinal: 1, statement: "Claimed", quote: "quoted", conditions: null, blockIndex: 3, ambiguous: 0 }];
  const reportKey = "source/" + rev + "/checked/distill.json";
  const checkedKey = "source/" + rev + "/checked/guide.md";
  function reportEnv(opts: { report?: unknown; checkedGuide?: string; legacyGuide?: string; key?: string | null }) {
    return makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: rev, createdAt: 1 }],
      revisions: [{ id: rev, readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2, reportKey: opts.key === undefined ? reportKey : opts.key }],
      texts: { [rev]: { text, blocks, guide: opts.legacyGuide, checkedGuide: opts.checkedGuide, report: opts.report } },
      claims: { [rev]: claims },
    });
  }
  async function expectUnavailable(env: unknown) {
    let err: unknown;
    try {
      await buildContext(env as Env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
      expect.unreachable();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("unavailable");
    expect((err as LibraryError).status).toBe(503);
  }
  it("follows head report artifacts over a stale legacy guide", async () => {
    const { env, requested } = reportEnv({
      report: { artifacts: { guide: checkedKey } },
      checkedGuide: "New [R" + rev + ":2] end.",
      legacyGuide: "Old [R" + rev + ":1] end.",
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
    expect(res.mode).toBe("claims");
    expect(res.sources[0]?.blocks.map((b) => b.id)).toEqual([2, 3]);
    expect(requested).toContain(reportKey);
    expect(requested).toContain(checkedKey);
    expect(requested.some((k) => k === "source/" + rev + "/guide.md")).toBe(false);
    expect(requested.filter((k) => k.includes("text.md"))).toEqual(["source/" + rev + "/text.md#r10-20"]);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("[S1:2] BBBBBBBBBB");
    expect(body).not.toContain("AAAAAAAAAA");
  });
  it("missing pointed report is actionable unavailable", async () => {
    const { env } = reportEnv({ legacyGuide: "Old [R" + rev + ":1] end." });
    await expectUnavailable(env);
  });
  it("missing pointed guide is actionable unavailable", async () => {
    const { env } = reportEnv({ report: { artifacts: { guide: checkedKey } }, legacyGuide: "Old [R" + rev + ":1] end." });
    await expectUnavailable(env);
  });
  it("report without an artifact map falls back to the legacy guide", async () => {
    const { env, requested } = reportEnv({ report: { digest: "d" }, legacyGuide: "Old [R" + rev + ":2] end." });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
    expect(res.mode).toBe("claims");
    expect(res.sources[0]?.blocks.map((b) => b.id)).toEqual([2, 3]);
    expect(requested).toContain("source/" + rev + "/guide.md");
    expect(requested.some((k) => k === checkedKey)).toBe(false);
  });
  it("guide keys outside the revision prefix are rejected", async () => {
    const { env: badReport } = reportEnv({ report: { artifacts: { guide: checkedKey } }, checkedGuide: "x", legacyGuide: "y", key: "source/other/guide.json" });
    await expectUnavailable(badReport);
    const { env: badGuide } = reportEnv({ report: { artifacts: { guide: "source/other/guide.md" } }, checkedGuide: "New [R" + rev + ":2]", legacyGuide: "Old [R" + rev + ":1]" });
    await expectUnavailable(badGuide);
  });
});

describe("orientation from stored guides", () => {
  function orientEnv(distillState: string, guide: string) {
    return makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: 10, distillState, guideSummary: guide, deletedAt: null }],
      texts: { r1: { text: "Alpha.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 6, heading: null }] } },
    });
  }
  it("appends done-guide orientation within budget after the source prefix", async () => {
    const { env } = orientEnv("done", "Guide text here.");
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
    expect(res.mode).toBe("whole");
    expect(res.messages.length).toBe(3);
    expect(res.messages[1]).toMatchObject({ role: "user" });
    expect(res.messages[2]).toMatchObject({ role: "user" });
    expect(res.messages[1]?.content).toContain("[S1:1] Alpha.");
    const orient = res.messages[2]?.content ?? "";
    expect(orient).toContain("Derived orientation only");
    expect(orient).toContain("Guide text here.");
    expect(orient).not.toContain("[S1:1]");
  });
  it("omits orientation without headroom and keeps whole", async () => {
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: 10, distillState: "done", guideSummary: "G".repeat(600), deletedAt: null }],
      texts: { r1: { text: "Alpha.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 6, heading: null }] } },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 584, maxOutputTokens: 100 } });
    expect(res.mode).toBe("whole");
    expect(res.messages.length).toBe(2);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).not.toContain("Derived orientation");
    expect(body).not.toContain("GGGGGGGG");
    expect(body).toContain("[S1:1] Alpha.");
  });
  it("never promotes partial gists to orientation", async () => {
    const { env } = orientEnv("partial", "Partial gist here.");
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
    expect(res.mode).toBe("whole");
    expect(res.messages.length).toBe(2);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).not.toContain("Derived orientation");
    expect(body).not.toContain("Partial gist");
  });
});
