import { describe, expect, it } from "vitest";
import { buildContext } from "./context.js";
import { resolveCitations } from "./citations.js";
import { LibraryError } from "./library.js";
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
  deletedAt: number | null;
}
interface MemMembership {
  projectId: string;
  sourceId: string;
  enabled: number;
}
interface MemText {
  text: string;
  blocks: { id: number; type: string; start: number; end: number; heading: string | null }[];
}

function wholeBlock(text: string, id: number) {
  return { id, type: "paragraph", start: 0, end: text.length, heading: null as string | null };
}

function makeEnv(opts: { memberships: MemMembership[]; sources: MemSource[]; revisions: MemRevision[]; texts: Record<string, MemText> }) {
  let reads = 0;
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
                return { id: s.id, title: s.title, revisionId: s.currentRevisionId, readableState: r ? r.readableState : null, readableSize: r ? r.readableSize : null };
              }
              return null;
            },
            async all() {
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
                  return { id: s.id, title: s.title, revisionId: s.currentRevisionId as string, readableSize: r ? r.readableSize : null };
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
    async get(key: string) {
      reads += 1;
      const parts = key.split("/");
      if (parts.length !== 3 || parts[0] !== "source") return null;
      const rev = parts[1] as string;
      const kind = parts[2] as string;
      const entry = opts.texts[rev];
      if (!entry) return null;
      if (kind === "text.md") {
        const data = new TextEncoder().encode(entry.text);
        return { arrayBuffer: async () => data.buffer as ArrayBuffer };
      }
      if (kind === "blocks.json") return { json: async () => entry.blocks };
      return null;
    },
  };
  return { env: { DB, BUCKET } as unknown as Env, reads: () => reads };
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
      { id: "r1", readableState: "readable", readableSize: 20, deletedAt: null },
      { id: "r2", readableState: "readable_with_warnings", readableSize: 14, deletedAt: null },
      { id: "r3", readableState: "readable", readableSize: 13, deletedAt: null },
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

  it("throws narrow-scope when whole text does not fit", async () => {
    const big = "x".repeat(9000);
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Big", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: null, deletedAt: null }],
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
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, deletedAt: null }],
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
      revisions: [{ id: "r1", readableState: "readable", readableSize: 10, deletedAt: null }],
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
});


