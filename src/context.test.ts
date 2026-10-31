import { describe, expect, it } from "vitest";
import { scanBlocks, sliceUtf8 } from "./blocks.js";
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

interface SourceContextRecord {
  alias: string;
  title: string;
  availableLabels: string[];
  blocks: Array<{ quoteBlock: string; text: string }>;
}
function sourceEvidenceRecords(content: string): SourceContextRecord[] {
  const start = content.indexOf("{");
  return start < 0 ? [] : content.slice(start).split(NL).filter(Boolean).map((line) => JSON.parse(line) as SourceContextRecord);
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

function mixedScopeEnv(firstText = "Небольшой читаемый источник.\n") {
  const encoder = new TextEncoder();
  const sourceIds = Array.from({ length: 12 }, (_value, index) => "s" + (index + 1));
  const revisionIds = Array.from({ length: 12 }, (_value, index) =>
    "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"));
  const sources: MemSource[] = [];
  const revisions: MemRevision[] = [];
  const memberships: MemMembership[] = [];
  const texts: Record<string, MemText> = {};
  const claims: Record<string, MemClaim[]> = {};
  const largeBlocks = new Map<string, MemBlock[]>();
  const largeTexts = new Map<string, string>();
  const firstBlock = scanBlocks(firstText)[0];
  const lastText = "Заключительный читаемый источник.\n";
  const lastBlocks = scanBlocks(lastText);
  const lastBlock = lastBlocks[0];
  if (!firstBlock || !lastBlock) throw new Error("Mixed-context fixtures require citable original blocks.");
  for (let index = 0; index < 12; index++) {
    const sourceId = sourceIds[index], revisionId = revisionIds[index];
    if (sourceId === undefined || revisionId === undefined) throw new Error("Mixed-context fixture source identity is missing.");
    const title = index === 0 ? "Readable failed source" : index === 11 ? "Readable unstarted source" : "Paper " + (index + 1);
    sources.push({ id: sourceId, title, state: "active", currentRevisionId: revisionId, createdAt: index + 1 });
    memberships.push({ projectId: "p1", sourceId, enabled: 1 });
    if (index === 0) {
      const blocks = scanBlocks(firstText);
      revisions.push({ id: revisionId, readableState: "readable", readableSize: encoder.encode(firstText).byteLength, distillState: "failed", guideSummary: null, deletedAt: null });
      texts[revisionId] = { text: firstText, blocks };
    } else if (index === 11) {
      revisions.push({ id: revisionId, readableState: "readable", readableSize: encoder.encode(lastText).byteLength, distillState: "none", guideSummary: null, deletedAt: null });
      texts[revisionId] = { text: lastText, blocks: lastBlocks };
    } else {
      const quote = "Paper " + (index + 1) + " reports 8.4 QScore.";
      const background = "Background " + "x".repeat(148_000);
      const tail = "Supplementary text." + NL;
      const text = background + NL + NL + quote + NL + NL + tail;
      const backgroundEnd = encoder.encode(background).byteLength;
      const quoteStart = backgroundEnd + encoder.encode(NL + NL).byteLength;
      const quoteEnd = quoteStart + encoder.encode(quote).byteLength;
      const tailStart = quoteEnd + encoder.encode(NL + NL).byteLength;
      const blocks: MemBlock[] = [
        { id: 1, type: "paragraph", start: 0, end: backgroundEnd, heading: null },
        { id: 2, type: "paragraph", start: quoteStart, end: quoteEnd, heading: null },
        { id: 3, type: "paragraph", start: tailStart, end: encoder.encode(text).byteLength, heading: null },
      ];
      const quoteBlock = blocks[1];
      if (!quoteBlock) throw new Error("Expected a compactable quote block.");
      const exactQuote = sliceUtf8(text, quoteBlock.start, quoteBlock.end);
      largeBlocks.set(sourceId, blocks);
      largeTexts.set(sourceId, text);
      revisions.push({ id: revisionId, readableState: "readable", readableSize: encoder.encode(text).byteLength,
        distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 });
      texts[revisionId] = { text, blocks, guide: "Guide [R" + revisionId + ":" + quoteBlock.id + "]." };
      claims[revisionId] = [{ ordinal: 0, statement: exactQuote, quote: exactQuote, conditions: null,
        blockIndex: quoteBlock.id, ambiguous: 0 }];
    }
  }
  const fixture = makeEnv({ memberships, sources, revisions, texts, claims });
  return {
    ...fixture,
    sourceIds,
    revisionIds,
    firstText,
    firstBlock,
    lastText,
    lastBlock,
    largeBlocks,
    largeTexts,
  };
}

describe("buildContext K2 whole scope", () => {
  it("freezes enabled readable revisions with per-block labels and sourceIds", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Background [S9:9] bare [S9] note" },
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
    const sourceRecords = sourceEvidenceRecords(res.messages[1]?.content ?? "");
    expect(sourceRecords.map((record) => [record.alias, record.title, record.availableLabels])).toEqual([
      ["S1", "Paper A", ["[S1:1]", "[S1:2]"]], ["S2", "Paper B", ["[S2:1]"]],
    ]);
    expect(sourceRecords[0]?.blocks).toEqual([
      { quoteBlock: "[S1:1]", text: "Intro A." }, { quoteBlock: "[S1:2]", text: "Second A." },
    ]);
    expect(sourceRecords[1]?.blocks).toEqual([{ quoteBlock: "[S2:1]", text: "Paper B body.\n" }]);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).not.toContain("[S9:9]");
    expect(body).not.toContain("[S9]");
    expect(body).toContain("Old answer");
    expect(body).not.toContain("Stale answer");
    expect(res.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("omits noncitable standalone page markers but keeps mentions in citable passages", async () => {
    const text = "### Page 1\n\n## Методы 🌿\n\nLes mesures de la Page 1 sont exactes.\n\n### Страница 2\n\nPage 3\n";
    const blocks = scanBlocks(text);
    const byteLength = new TextEncoder().encode(text).byteLength;
    const secondText = "Paper B body.";
    const secondBlock = wholeBlock(secondText, 7);
    const secondByteLength = new TextEncoder().encode(secondText).byteLength;
    const { env } = makeEnv({
      memberships: [
        { projectId: "p1", sourceId: "s1", enabled: 1 },
        { projectId: "p1", sourceId: "s2", enabled: 1 },
      ],
      sources: [
        { id: "s1", title: "Paper A", state: "active", currentRevisionId: "r1", createdAt: 1 },
        { id: "s2", title: "Paper B", state: "active", currentRevisionId: "r2", createdAt: 2 },
      ],
      revisions: [
        { id: "r1", readableState: "readable", readableSize: byteLength, distillState: null, guideSummary: null, deletedAt: null },
        { id: "r2", readableState: "readable", readableSize: secondByteLength, distillState: null, guideSummary: null, deletedAt: null },
      ],
      texts: { r1: { text, blocks }, r2: { text: secondText, blocks: [secondBlock] } },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
    expect(res.mode).toBe("whole");
    expect(res.revisionIds).toEqual(["r1", "r2"]);
    expect(res.sources.map((source) => [source.sourceId, source.revisionId, source.alias])).toEqual([
      ["s1", "r1", "S1"], ["s2", "r2", "S2"],
    ]);
    expect(res.sources[0]?.blocks).toEqual([blocks[1], blocks[2]]);
    expect(res.sources[0]?.blocks.map((block) => sliceUtf8(text, block.start, block.end))).toEqual([
      "## Методы 🌿\n", "Les mesures de la Page 1 sont exactes.\n",
    ]);
    expect(res.sources[1]?.blocks).toEqual([secondBlock]);
    const source = res.messages[1]?.content ?? "";
    const records = sourceEvidenceRecords(source);
    const firstSource = records[0], secondSource = records[1];
    if (!firstSource || !secondSource) throw new Error("Expected both whole-source JSON records.");
    expect(firstSource).toMatchObject({ alias: "S1", title: "Paper A", availableLabels: ["[S1:2]", "[S1:3]"] });
    expect(firstSource.blocks).toEqual([
      { quoteBlock: "[S1:2]", text: "## Методы 🌿\n" },
      { quoteBlock: "[S1:3]", text: "Les mesures de la Page 1 sont exactes.\n" },
    ]);
    expect(source).not.toContain("### Page 1\n");
    expect(source).not.toContain("### Страница 2\n");
    expect(source).not.toContain("Page 3\n");
    for (const unavailable of ["[S1:1]", "[S1:4]", "[S1:5]", "[S1:132]", "[S7:132]", "[S2:7]"]) {
      expect(firstSource.availableLabels).not.toContain(unavailable);
    }
    expect(secondSource).toMatchObject({ alias: "S2", title: "Paper B", availableLabels: ["[S2:7]"] });
    expect(secondSource.blocks).toEqual([{ quoteBlock: "[S2:7]", text: secondText }]);
    const system = res.messages[0]?.content ?? "";
    expect(system).toContain("The N in [Sx:N] is an exact source block ID, not a page, section, footnote or bibliography number; gaps are intentional.");
    expect(system).toContain("If no listed label supports a claim, omit it rather than infer an ID.");
    const resolved = resolveCitations(
      "A [S1:2] and [S1:3]; B [S2:7]; page-only [S1:1] [S1:4] [S1:5]; absent [S1:132] [S7:132]; foreign [S1:7] [S2:2].",
      res.sources,
    );
    expect(resolved.citations.map((citation) => [citation.label, citation.sourceId, citation.revisionId, citation.block, citation.start, citation.end])).toEqual([
      ["[S1:2]", "s1", "r1", 2, blocks[1]?.start, blocks[1]?.end],
      ["[S1:3]", "s1", "r1", 3, blocks[2]?.start, blocks[2]?.end],
      ["[S2:7]", "s2", "r2", 7, 0, secondByteLength],
    ]);
    expect(resolved.invalidLabels).toBe(7);
    const estimateTokens = (value: string) => Math.ceil(new TextEncoder().encode(value).byteLength / 3);
    expect(res.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(res.estimatedInputTokens).toBe(res.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0));
    expect(res.estimatedInputTokens + modelOutputLimit(MODEL)).toBeLessThanOrEqual(Math.min(Math.floor(MODEL.contextTokens * 0.6), 400000));
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
        { role: "assistant", content: "a".repeat(60), turnId: "prior" },
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

  it("rejects an actually over-budget undistilled whole projection", async () => {
    const big = "x".repeat(9000);
    const byteLength = new TextEncoder().encode(big).byteLength;
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Native25", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: byteLength, distillState: "queued", guideSummary: null, deletedAt: null }],
      texts: { r9: { text: big, blocks: [wholeBlock(big, 1)] } },
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
    expect(requested).toContain("source/r9/text.md");
  });

  it("uses exact citable projection before rejecting a marker-heavy unprocessed source", async () => {
    const encoder = new TextEncoder();
    const pageCount = 2000;
    const pageMarkers = Array.from({ length: pageCount }, (_value, index) => "### Page " + (index + 1)).join(NL + NL);
    const nextBlockLabel = "[S1:" + (pageCount + 2) + "]";
    const firstCitable = "Small citable paragraph includes literal " + nextBlockLabel + ".";
    const nextCitable = "The schedule uses d_model^-0.5 * min(step_num^-0.5, step_num * warmup_steps^-1.5), warmup_steps=4000; JavaScript: const rate = Math.min(step_num ** -0.5, step_num * warmup_steps ** -1.5).";
    const pageText = pageMarkers + NL + NL + firstCitable + NL + NL + nextCitable + NL;
    const pageBlocks = scanBlocks(pageText);
    const originalBlock = pageBlocks[pageBlocks.length - 2], boundaryBlock = pageBlocks[pageBlocks.length - 1];
    if (!originalBlock || !boundaryBlock || boundaryBlock.id !== pageCount + 2) {
      throw new Error("Expected the two final citable blocks after the page markers.");
    }
    const largeRevision = "22222222-2222-4222-8222-222222222222";
    const pageRevision = "11111111-1111-4111-8111-111111111111";
    const largePrefix = "Background " + "b".repeat(9000);
    const compactQuote = "The compact source preserves d_model^-0.5 * min(step_num^-0.5, step_num * warmup_steps^-1.5), warmup_steps=4000.";
    const largeText = largePrefix + NL + NL + compactQuote + NL;
    const prefixBytes = encoder.encode(largePrefix).byteLength;
    const quoteStart = prefixBytes + encoder.encode(NL + NL).byteLength;
    const quoteEnd = quoteStart + encoder.encode(compactQuote).byteLength;
    const compactBlock: MemBlock = { id: 2, type: "paragraph", start: quoteStart, end: quoteEnd, heading: null };
    const largeBlocks: MemBlock[] = [
      { id: 1, type: "paragraph", start: 0, end: prefixBytes, heading: null },
      compactBlock,
    ];
    const { env, requested } = makeEnv({
      memberships: [
        { projectId: "p1", sourceId: "s1", enabled: 1 },
        { projectId: "p1", sourceId: "s2", enabled: 1 },
      ],
      sources: [
        { id: "s1", title: "Readable failed source", state: "active", currentRevisionId: pageRevision, createdAt: 1 },
        { id: "s2", title: "Compactable paper", state: "active", currentRevisionId: largeRevision, createdAt: 2 },
      ],
      revisions: [
        { id: pageRevision, readableState: "readable", readableSize: encoder.encode(pageText).byteLength, distillState: "failed", guideSummary: null, deletedAt: null },
        { id: largeRevision, readableState: "readable", readableSize: encoder.encode(largeText).byteLength, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 1 },
      ],
      texts: {
        [pageRevision]: { text: pageText, blocks: pageBlocks },
        [largeRevision]: { text: largeText, blocks: largeBlocks, guide: "Guide [R" + largeRevision + ":2]." },
      },
      claims: {
        [largeRevision]: [{ ordinal: 0, statement: compactQuote, quote: compactQuote, conditions: null, blockIndex: 2, ambiguous: 0 }],
      },
    });
    const model = { contextTokens: 5000, maxOutputTokens: 100 };
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model });
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual([pageRevision, largeRevision]);
    expect(res.sources.map((source) => source.alias)).toEqual(["S1", "S2"]);
    expect(res.sources[0]?.blocks).toEqual([originalBlock, boundaryBlock]);
    expect(res.sources[1]?.blocks).toEqual([compactBlock]);
    const sourcesText = res.messages[1]?.content ?? "";
    const records = sourceEvidenceRecords(sourcesText);
    const originalRecord = records[0], compactRecord = records[1];
    if (!originalRecord || !compactRecord) throw new Error("Expected two per-source JSON records.");
    const firstPassage = sliceUtf8(pageText, originalBlock.start, originalBlock.end);
    const nextPassage = sliceUtf8(pageText, boundaryBlock.start, boundaryBlock.end);
    expect(originalRecord.availableLabels).toEqual(["[S1:" + originalBlock.id + "]", nextBlockLabel]);
    expect(originalRecord.blocks).toEqual([
      { quoteBlock: "[S1:" + originalBlock.id + "]", text: firstPassage },
      { quoteBlock: nextBlockLabel, text: nextPassage },
    ]);
    expect(compactRecord.blocks).toEqual([{ quoteBlock: "[S2:2]", text: compactQuote }]);
    expect(sourcesText).toContain('"quoteBlock":"' + nextBlockLabel + '"');
    expect(sourcesText).toContain("literal \\u005bS1:" + (pageCount + 2) + "\\u005d");
    expect(sourcesText).not.toContain("literal " + nextBlockLabel);
    expect(sourcesText).not.toContain("b".repeat(1000));
    const citations = resolveCitations("Whole " + nextBlockLabel + " and compact [S2:2].", res.sources);
    expect(citations.citations.map((citation) => [citation.sourceId, citation.revisionId, citation.block, citation.start, citation.end])).toEqual([
      ["s1", pageRevision, boundaryBlock.id, boundaryBlock.start, boundaryBlock.end],
      ["s2", largeRevision, compactBlock.id, compactBlock.start, compactBlock.end],
    ]);
    expect(citations.invalidLabels).toBe(0);
    expect(res.estimatedInputTokens + modelOutputLimit(model)).toBeLessThanOrEqual(Math.min(3000, 400000));
    expect(requested).toContain("source/" + pageRevision + "/text.md");
    expect(requested).not.toContain("source/" + largeRevision + "/text.md");
    expect(requested.some((key) => key.startsWith("source/" + largeRevision + "/text.md#r"))).toBe(true);
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
    const sourceRecord = sourceEvidenceRecords(res.messages[1]?.content ?? "")[0];
    if (!sourceRecord) throw new Error("Expected one compact source record.");
    expect(sourceRecord.availableLabels).toEqual(["[S1:2]", "[S1:3]"]);
    expect(sourceRecord.blocks).toContainEqual({ quoteBlock: "[S1:2]", text: "quoted one" });
    expect(sourceRecord.blocks).toContainEqual({ quoteBlock: "[S1:3]", text: "quoted two" });
    expect(sourceRecord.blocks.some((block) => block.text.includes("First finding"))).toBe(false);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(res.messages[2]?.content).toContain("First finding");
    expect(body).not.toContain("S9:9");
    expect(body).not.toContain("Guide A.");
    const resolved = resolveCitations("Claim holds [S1:3] but not [S1:1].", res.sources);
    expect(resolved.citations.length).toBe(1);
    expect(resolved.citations[0]?.sourceId).toBe("s1");
    expect(resolved.invalidLabels).toBe(1);
  });

  it("keeps readable failed and unstarted sources whole while compacting large eligible sources", async () => {
    const fixture = mixedScopeEnv();
    const model = { contextTokens: 1048576, maxOutputTokens: 8192 };
    const res = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model });
    const compactSourceId = fixture.sourceIds[1];
    if (compactSourceId === undefined) throw new Error("Expected a second frozen source.");
    const compactBlock = fixture.largeBlocks.get(compactSourceId)?.[1];
    const firstLargeBlock = fixture.largeBlocks.get(compactSourceId)?.[0];
    const largeText = fixture.largeTexts.get(compactSourceId);
    if (!compactBlock || !firstLargeBlock || !largeText) throw new Error("Expected the second frozen source to have original blocks.");
    const compactQuote = sliceUtf8(largeText, compactBlock.start, compactBlock.end);
    const smallQuote = sliceUtf8(fixture.firstText, fixture.firstBlock.start, fixture.firstBlock.end);
    const lastQuote = sliceUtf8(fixture.lastText, fixture.lastBlock.start, fixture.lastBlock.end);
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual(fixture.revisionIds);
    expect(res.sources.map((source) => source.sourceId)).toEqual(fixture.sourceIds);
    expect(res.sources.map((source) => source.alias)).toEqual(Array.from({ length: 12 }, (_value, i) => "S" + (i + 1)));
    expect(res.sources[0]?.blocks).toEqual([fixture.firstBlock]);
    expect(res.sources[1]?.blocks).toEqual([compactBlock]);
    expect(res.sources[11]?.blocks).toEqual([fixture.lastBlock]);
    const sourceRecords = sourceEvidenceRecords(res.messages[1]?.content ?? "");
    const first = sourceRecords[0], second = sourceRecords[1], last = sourceRecords[11];
    if (!first || !second || !last) throw new Error("Expected all twelve source records in frozen order.");
    expect(first.blocks).toEqual([{ quoteBlock: "[S1:" + fixture.firstBlock.id + "]", text: smallQuote }]);
    expect(second.availableLabels).toEqual(["[S2:" + compactBlock.id + "]"]);
    expect(second.blocks).toEqual([{ quoteBlock: "[S2:" + compactBlock.id + "]", text: compactQuote }]);
    expect(last.blocks).toEqual([{ quoteBlock: "[S12:" + fixture.lastBlock.id + "]", text: lastQuote }]);
    expect(second.blocks.some((block) => block.text.includes("x".repeat(1000)))).toBe(false);
    const resolved = resolveCitations(
      "First [S1:" + fixture.firstBlock.id + "], compact [S2:" + compactBlock.id + "], final [S12:" + fixture.lastBlock.id + "].",
      res.sources,
    );
    expect(resolved.invalidLabels).toBe(0);
    expect(resolved.citations.map((citation) => [citation.sourceId, citation.revisionId, citation.block, citation.start, citation.end])).toEqual([
      [fixture.sourceIds[0], fixture.revisionIds[0], fixture.firstBlock.id, fixture.firstBlock.start, fixture.firstBlock.end],
      [fixture.sourceIds[1], fixture.revisionIds[1], compactBlock.id, compactBlock.start, compactBlock.end],
      [fixture.sourceIds[11], fixture.revisionIds[11], fixture.lastBlock.id, fixture.lastBlock.start, fixture.lastBlock.end],
    ]);
    expect(fixture.requested).toContain("source/" + fixture.revisionIds[0] + "/text.md");
    expect(fixture.requested).toContain("source/" + fixture.revisionIds[11] + "/text.md");
    expect(fixture.requested).not.toContain("source/" + fixture.revisionIds[1] + "/text.md");
    expect(fixture.requested.some((key) => key.startsWith("source/" + fixture.revisionIds[1] + "/text.md#r"))).toBe(true);
    expect(res.estimatedInputTokens + modelOutputLimit(model)).toBeLessThanOrEqual(400000);
  });

  it("rejects an over-budget mixed scope after exact projection without dropping sources", async () => {
    const impossibleText = "u".repeat(1_300_000) + NL;
    const fixture = mixedScopeEnv(impossibleText);
    let err: unknown;
    try {
      await buildContext(fixture.env, actor, {
        projectId: "p1", scopeMode: "project_default", model: { contextTokens: 1048576, maxOutputTokens: 8192 },
      });
      expect.unreachable();
    } catch (error) {
      err = error;
    }
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe("invalid");
    expect((err as LibraryError).status).toBe(400);
    expect(fixture.requested.filter((key) => key === "source/" + fixture.revisionIds[0] + "/text.md")).toHaveLength(1);
    expect(fixture.requested.filter((key) => key === "source/" + fixture.revisionIds[11] + "/text.md")).toHaveLength(1);
    for (const revisionId of fixture.revisionIds.slice(1, 11)) {
      expect(fixture.requested).not.toContain("source/" + revisionId + "/text.md");
    }
  });

  it("recomputes retained history and enforces the existing output and caller budget for mixed context", async () => {
    const fixture = mixedScopeEnv();
    const model = { contextTokens: 1048576, maxOutputTokens: 8192 };
    const smallBlock = fixture.firstBlock;
    const smallSourceId = fixture.sourceIds[0], compactSourceId = fixture.sourceIds[1];
    const smallRevisionId = fixture.revisionIds[0], compactRevisionId = fixture.revisionIds[1];
    if (smallSourceId === undefined || compactSourceId === undefined || smallRevisionId === undefined || compactRevisionId === undefined) {
      throw new Error("Expected the first two frozen source identities.");
    }
    const largeBlocks = fixture.largeBlocks.get(compactSourceId);
    if (!largeBlocks) throw new Error("Expected original blocks for Paper 2.");
    const compactBlock = largeBlocks[1], absentBlock = largeBlocks[0];
    if (!compactBlock || !absentBlock) throw new Error("Expected compact and unselected blocks for Paper 2.");
    const priorCitations = [
      { sourceId: smallSourceId, revisionId: smallRevisionId, block: smallBlock.id, start: smallBlock.start, end: smallBlock.end,
        sourceTitle: "Readable failed source", deleted: false, label: "[S1:" + smallBlock.id + "]" },
      { sourceId: compactSourceId, revisionId: compactRevisionId, block: compactBlock.id, start: compactBlock.start, end: compactBlock.end,
        sourceTitle: "Paper 2", deleted: false, label: "[S2:" + compactBlock.id + "]" },
      { sourceId: compactSourceId, revisionId: compactRevisionId, block: absentBlock.id, start: absentBlock.start, end: absentBlock.end,
        sourceTitle: "Paper 2", deleted: false, label: "[S2:" + absentBlock.id + "]" },
    ];
    const question = "Q".repeat(30000), instructions = "I".repeat(30000);
    const history = [
      { role: "user" as const, content: "Old oversized question", revisionIds: fixture.revisionIds },
      { role: "assistant" as const, content: "Old oversized answer " + "o".repeat(320000), revisionIds: fixture.revisionIds, citations: [] },
      { role: "user" as const, content: "Recent scope-preserving question", revisionIds: fixture.revisionIds },
      { role: "assistant" as const, content: "Retain [S1:" + smallBlock.id + "] and [S2:" + compactBlock.id + "]; remove [S2:" + absentBlock.id + "].",
        revisionIds: [smallRevisionId, compactRevisionId], citations: priorCitations },
    ];
    const res = await buildContext(fixture.env, actor, {
      projectId: "p1", scopeMode: "project_default", model, history, question, instructions,
    });
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual(fixture.revisionIds);
    const body = res.messages.map((message) => message.content).join(NL);
    expect(body).toContain("Recent scope-preserving question");
    expect(body).toContain("Retain [S1:" + smallBlock.id + "] and [S2:" + compactBlock.id + "]");
    expect(body).not.toContain("Old oversized answer");
    expect(body).not.toContain("[S2:" + absentBlock.id + "]");
    const estimate = (value: string) => Math.ceil(new TextEncoder().encode(value).byteLength / 3);
    const callerTokens = estimate(question) + estimate(instructions);
    const historyTokens = res.messages.slice(3).reduce((sum, message) => sum + estimate(message.content), 0);
    const cap = Math.min(Math.floor(model.contextTokens * 0.6), 400000);
    expect(historyTokens).toBeLessThanOrEqual(Math.floor(model.contextTokens * 0.1));
    expect(res.estimatedInputTokens).toBe(res.messages.reduce((sum, message) => sum + estimate(message.content), 0));
    expect(res.estimatedInputTokens + callerTokens + modelOutputLimit(model)).toBeLessThanOrEqual(cap);
  });

  it("filters structural page markers from hydrated claim and guide passages", async () => {
    const revisionId = "11111111-1111-4111-8111-111111111111";
    const text = "### Page 1\n\n## Методы 🌿\n\nLes mesures sont exactes.\n\n### Страница 2\n";
    const blocks = scanBlocks(text);
    const [pageOne, heading, body, pageTwo] = blocks;
    if (pageOne === undefined || heading === undefined || body === undefined || pageTwo === undefined) {
      throw new Error("Expected two page markers, a semantic heading and a body block.");
    }
    const byteLength = new TextEncoder().encode(text).byteLength;
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: revisionId, createdAt: 1 }],
      revisions: [{ id: revisionId, readableState: "readable", readableSize: 10_000, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: {
        [revisionId]: {
          text,
          blocks,
          guide: `Guide [R${revisionId}:${pageOne.id}] [R${revisionId}:${heading.id}] [R${revisionId}:${body.id}] [R${revisionId}:${pageTwo.id}].`,
        },
      },
      claims: {
        [revisionId]: [
          { ordinal: 0, statement: "A page marker is present.", quote: "Page 1", conditions: null, blockIndex: pageOne.id, ambiguous: 0 },
          { ordinal: 1, statement: "The passage reports measurements.", quote: "Les mesures sont exactes.", conditions: null, blockIndex: body.id, ambiguous: 0 },
        ],
      },
    });
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model: { contextTokens: 2000, maxOutputTokens: 100 },
    });
    expect(res.mode).toBe("claims");
    expect(res.sources[0]?.blocks).toEqual([heading, body]);
    const source = res.messages[1]?.content ?? "";
    const record = sourceEvidenceRecords(source)[0];
    if (!record) throw new Error("Expected a compact JSON record for the source.");
    expect(record.availableLabels).toEqual(["[S1:2]", "[S1:3]"]);
    expect(record.blocks).toHaveLength(3);
    expect(record.blocks).toContainEqual({ quoteBlock: "[S1:2]", text: "## Методы 🌿\n" });
    expect(record.blocks).toContainEqual({ quoteBlock: "[S1:3]", text: "Les mesures sont exactes.\n" });
    expect(record.blocks).toContainEqual({ quoteBlock: "[S1:3]", text: "Les mesures sont exactes." });
    expect(source).not.toContain("### Page 1");
    expect(source).not.toContain("### Страница 2");
    expect(source).not.toContain("Page 3");
    expect(res.messages[2]?.content).toContain("The passage reports measurements.");
    expect(res.messages[2]?.content).not.toContain("A page marker is present.");
    expect(requested.filter((key) => key.startsWith(`source/${revisionId}/text.md#r`))).toHaveLength(4);
    expect(requested).not.toContain(`source/${revisionId}/text.md`);
    expect(res.sources[0]?.blocks.map((block) => [block.id, block.start, block.end])).toEqual([
      [heading.id, heading.start, heading.end], [body.id, body.start, body.end],
    ]);
    expect(byteLength).toBeGreaterThan(text.length);
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
    const sourceRecord = sourceEvidenceRecords(source)[0];
    if (!sourceRecord) throw new Error("Expected one compact source record.");
    expect(sourceRecord.availableLabels).toEqual(["[S1:2]"]);
    expect(sourceRecord.blocks).toEqual([
      { quoteBlock: "[S1:2]", text: quote },
      { quoteBlock: "[S1:2]", text: otherQuote },
    ]);
    expect(JSON.stringify(sourceRecord)).not.toContain(wrongStatement);
    expect(JSON.stringify(sourceRecord)).not.toContain(wrongConditions);
    expect(JSON.stringify(sourceRecord)).not.toContain("A derived");
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
    const body = "T".repeat(1800);
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: bodyBytes, distillState: "done", guideSummary: "Guide: G.", deletedAt: null, claimCount: 2 }],
      texts: { r9: { text: body, guide: "See nothing.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 900, heading: null }, { id: 2, type: "paragraph", start: 900, end: bodyBytes, heading: null }] } },
      claims: { r9: [{ ordinal: 1, statement: "Finding one", quote: "quoted one", conditions: null, blockIndex: 2, ambiguous: 0 }] },
    });
    const question = "Q" + "q".repeat(459), instructions = "I" + "i".repeat(459), outputTokens = 100;
    const estimateTokens = (value: string) => Math.ceil(new TextEncoder().encode(value).byteLength / 3);
    const measuredSystem = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens: 5000, maxOutputTokens: outputTokens }, question, instructions,
    });
    const systemTokens = estimateTokens(measuredSystem.messages[0]?.content ?? "");
    const callerTokens = estimateTokens(question) + estimateTokens(instructions);
    const wholePrefitTokens = Math.ceil(bodyBytes / 3) + systemTokens + callerTokens + outputTokens;
    // Place the existing 60% cap one token below the current whole-prefit estimate;
    // claims must still fit after its smaller labelled excerpts are estimated.
    const contextTokens = Math.floor((wholePrefitTokens - 1) / 0.6);
    const cap = Math.min(Math.floor(contextTokens * 0.6), 400000);
    expect(cap).toBeLessThan(wholePrefitTokens);
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "project_default", model: { contextTokens, maxOutputTokens: outputTokens }, question, instructions,
    });
    expect(res.mode).toBe("claims");
    expect(res.estimatedInputTokens + callerTokens + outputTokens).toBeLessThanOrEqual(cap);
    expect(res.revisionIds).toEqual(["r9"]);
    expect(requested.some((k) => k.endsWith("text.md"))).toBe(false);
    expect(res.messages[1]).toMatchObject({ role: "user" });
    const text = res.messages.map((m) => m.content).join(NL);
    const sourceRecord = sourceEvidenceRecords(res.messages[1]?.content ?? "")[0];
    if (!sourceRecord) throw new Error("Expected one compact JSON source record.");
    expect(sourceRecord.blocks).toContainEqual({ quoteBlock: "[S1:2]", text: "quoted one" });
    expect(sourceRecord.blocks.some((block) => block.text.includes("Finding one"))).toBe(false);
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
    const text = "x".repeat(9000);
    const readableSize = new TextEncoder().encode(text).byteLength;
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Big", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize, distillState: "queued", guideSummary: null, deletedAt: null }],
      texts: { r1: { text, blocks: [wholeBlock(text, 1)] } },
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
    const text = "Maybe" + "x".repeat(9000);
    const readableSize = new TextEncoder().encode(text).byteLength;
    const { env, reads, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "NoClaims", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: { r1: { text, blocks: [wholeBlock(text, 1)] } },
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
    expect(reads()).toBe(3);
    expect(requested.filter((key) => key === "source/r1/text.md")).toHaveLength(1);
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
    const sourceRecord = sourceEvidenceRecords(res.messages[1]?.content ?? "")[0];
    if (!sourceRecord) throw new Error("Expected the report-guided JSON source record.");
    expect(sourceRecord.availableLabels).toEqual(["[S1:2]", "[S1:3]"]);
    expect(sourceRecord.blocks).toEqual([
      { quoteBlock: "[S1:2]", text: "012345678" },
      { quoteBlock: "[S1:3]", text: "quoted" },
    ]);
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
    const sourceRecord = sourceEvidenceRecords(res.messages[1]?.content ?? "")[0];
    if (!sourceRecord) throw new Error("Expected the checked guide's source record.");
    expect(sourceRecord.availableLabels).toEqual(["[S1:2]", "[S1:3]"]);
    expect(sourceRecord.blocks).toEqual([
      { quoteBlock: "[S1:2]", text: "BBBBBBBBBB" },
      { quoteBlock: "[S1:3]", text: "quoted" },
    ]);
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
    const record = sourceEvidenceRecords(res.messages[1]?.content ?? "")[0];
    if (!record) throw new Error("Expected the whole-source JSON record.");
    expect(record).toMatchObject({ alias: "S1", title: "Paper A", availableLabels: ["[S1:1]"] });
    expect(record.blocks).toEqual([{ quoteBlock: "[S1:1]", text: "Alpha." }]);
    const orient = res.messages[2]?.content ?? "";
    expect(orient).toContain("Derived orientation only");
    expect(orient).toContain("Guide text here.");
    expect(orient).not.toContain("[S1:1]");
  });
  it("omits orientation without headroom and keeps whole", async () => {
    const text = "Alpha.";
    const outputTokens = 100;
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: new TextEncoder().encode(text).byteLength, distillState: "done", guideSummary: "G".repeat(600), deletedAt: null }],
      texts: { r1: { text, blocks: [{ id: 1, type: "paragraph", start: 0, end: 6, heading: null }] } },
    });
    const estimateTokens = (value: string) => Math.ceil(new TextEncoder().encode(value).byteLength / 3);
    const measuredWhole = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 20000, maxOutputTokens: outputTokens } });
    expect(measuredWhole.mode).toBe("whole");
    expect(measuredWhole.messages).toHaveLength(3);
    const baseTokens = estimateTokens(measuredWhole.messages[0]?.content ?? "") + estimateTokens(measuredWhole.messages[1]?.content ?? "");
    const orientationTokens = estimateTokens(measuredWhole.messages[2]?.content ?? "");
    const contextTokens = Math.ceil((baseTokens + outputTokens) / 0.6);
    const cap = Math.min(Math.floor(contextTokens * 0.6), 400000);
    expect(baseTokens + outputTokens).toBeLessThanOrEqual(cap);
    expect(baseTokens + orientationTokens + outputTokens).toBeGreaterThan(cap);
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens, maxOutputTokens: outputTokens } });
    expect(res.mode).toBe("whole");
    expect(res.messages.length).toBe(2);
    expect(res.estimatedInputTokens).toBe(baseTokens);
    expect(res.estimatedInputTokens + outputTokens).toBeLessThanOrEqual(cap);
    expect(res.estimatedInputTokens + orientationTokens + outputTokens).toBeGreaterThan(cap);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).not.toContain("Derived orientation");
    expect(body).not.toContain("GGGGGGGG");
    const sourceRecord = sourceEvidenceRecords(res.messages[1]?.content ?? "")[0];
    if (!sourceRecord) throw new Error("Expected the whole-source JSON record.");
    expect(sourceRecord.blocks).toEqual([{ quoteBlock: "[S1:1]", text: "Alpha." }]);
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

describe("bare-label header regression", () => {
  it("whole headers avoid bare labels while keeping exact passages and literals", async () => {
    const literalText = "Alpha [S1] literal.";
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r1", createdAt: 1 }],
      revisions: [{ id: "r1", readableState: "readable", readableSize: 20, distillState: "done", guideSummary: "Guide [S1] overview [S1:1] done.", deletedAt: null }],
      texts: { r1: { text: literalText, blocks: [{ id: 1, type: "paragraph", start: 0, end: literalText.length, heading: null }] } },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
    expect(res.mode).toBe("whole");
    const sourceText = res.messages[1]?.content ?? "";
    const orientText = res.messages[2]?.content ?? "";
    const record = sourceEvidenceRecords(sourceText)[0];
    if (!record) throw new Error("Expected the whole-source JSON record.");
    expect(record).toMatchObject({ alias: "S1", title: "Paper A", availableLabels: ["[S1:1]"] });
    expect(record.blocks).toEqual([{ quoteBlock: "[S1:1]", text: literalText }]);
    expect(sourceText).toContain('"quoteBlock":"[S1:1]"');
    expect(sourceText).toContain("Alpha \\u005bS1\\u005d literal.");
    expect(sourceText).not.toContain("Alpha [S1] literal.");
    expect(orientText).toContain("Derived orientation only");
    expect(orientText).toContain("Source S1");
    expect(orientText).toContain("overview");
    expect(orientText).not.toMatch(/\[S\d+\]/);
    expect(orientText).not.toMatch(/\[S\d+:\d+\]/);
  });

  it("claims headers and orientation avoid bare labels while keeping exact quotes and literals", async () => {
    const passage = "Model Alpha uses [S1] literal.";
    const passageEnd = new TextEncoder().encode(passage).byteLength;
    const text = passage + NL + "Unselected source material. ".repeat(400);
    const byteLength = new TextEncoder().encode(text).byteLength;
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: byteLength, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 2 }],
      texts: {
        r9: {
          text,
          guide: "No guide passages selected.",
          blocks: [
            { id: 2, type: "paragraph", start: 0, end: passageEnd, heading: null },
            { id: 3, type: "paragraph", start: passageEnd + 1, end: byteLength, heading: null },
          ],
        },
      },
      claims: { r9: [{ ordinal: 1, statement: "Finding [S1] claim [S1:2] here", quote: passage, conditions: null, blockIndex: 2, ambiguous: 0 }] },
    });
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 2000, maxOutputTokens: 100 } });
    expect(res.mode).toBe("claims");
    const sourceText = res.messages[1]?.content ?? "";
    const orientText = res.messages[2]?.content ?? "";
    const record = sourceEvidenceRecords(sourceText)[0];
    if (!record) throw new Error("Expected the compact JSON source record.");
    expect(record).toMatchObject({ alias: "S1", title: "Paper A", availableLabels: ["[S1:2]"] });
    expect(record.blocks).toEqual([{ quoteBlock: "[S1:2]", text: passage }]);
    expect(sourceText).toContain('"quoteBlock":"[S1:2]"');
    expect(sourceText).toContain("Model Alpha uses \\u005bS1\\u005d literal.");
    expect(sourceText).not.toContain("Model Alpha uses [S1] literal.");
    expect(orientText).toContain("Source S1");
    expect(orientText).toContain("Finding");
    expect(orientText).not.toMatch(/\[S\d+\]/);
    expect(orientText).not.toMatch(/\[S\d+:\d+\]/);
  });
});
describe("history reference continuity", () => {
  it("retains stable current stored reference", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Prior question", revisionIds: ["r1", "r2"] },
        { role: "assistant", content: "Kept fact [S1:1] here", turnId: "t1", revisionIds: ["r1"], citations: [{ revisionId: "r1", sourceId: "s1", block: 1, start: 0, end: 8, sourceTitle: "Paper A", deleted: false, label: "[S1:1]" }] },
      ],
    });
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Kept fact [S1:1] here");
  });
  it("strips reordered scope even with stored proof", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Prior question", revisionIds: ["r2", "r1"] },
        { role: "assistant", content: "Kept fact [S1:1] here", turnId: "t1", revisionIds: ["r1"], citations: [{ revisionId: "r1", sourceId: "s1", block: 1, start: 0, end: 8, sourceTitle: "Paper A", deleted: false, label: "[S1:1]" }] },
      ],
    });
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Kept fact");
    expect(body).not.toContain("Kept fact [S1:1] here");
  });
  it("strips unstored labels by default", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Prior question", revisionIds: ["r1", "r2"] },
        { role: "assistant", content: "Old answer [S1:1] kept", revisionIds: ["r1"] },
      ],
    });
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Old answer");
    expect(body).not.toContain("Old answer [S1:1] kept");
  });
  it("strips foreign, stale, bare and unknown refs", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Prior question", revisionIds: ["r1", "r2"] },
        { role: "assistant", content: "Mix [S1:1] good [S2:1] foreign [S1] bare [S9:9] unknown", turnId: "t1", revisionIds: ["r1"], citations: [{ revisionId: "r1", sourceId: "s1", block: 1, start: 0, end: 8, sourceTitle: "Paper A", deleted: false, label: "[S1:1]" }] },
      ],
    });
    const assistants = res.messages.filter((m) => m.role === "assistant").map((m) => m.content).join(NL);
    expect(assistants).toContain("Mix [S1:1] good");
    expect(assistants).not.toContain("[S2:1]");
    expect(assistants).not.toContain("[S9:9]");
  });
  it("maps persistent R token to current compact S", async () => {
    const rev = "11111111-1111-1111-1111-111111111111";
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: rev, createdAt: 1 }],
      revisions: [{ id: rev, readableState: "readable", readableSize: 20, distillState: "done", guideSummary: null, deletedAt: null }],
      texts: { [rev]: { text: "Alpha.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 6, heading: null }] } },
    });
    const rLabel = "[R" + rev + ":1]";
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: MODEL,
      history: [
        { role: "user", content: "Prior question", revisionIds: [rev] },
        { role: "assistant", content: "Kept fact " + rLabel + " here", turnId: "t1", revisionIds: [rev], citations: [{ revisionId: rev, sourceId: "s1", block: 1, start: 0, end: 6, sourceTitle: "Paper A", deleted: false, label: rLabel }] },
      ],
    });
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Kept fact [S1:1] here");
    expect(body).not.toContain(rLabel);
  });
  it("claims retains present block and strips absent block", async () => {
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 26214400, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 4 }],
      texts: { r9: { guide: "See nothing.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 9, heading: null }, { id: 2, type: "paragraph", start: 10, end: 19, heading: null }, { id: 3, type: "paragraph", start: 20, end: 29, heading: null }] } },
      claims: { r9: [{ ordinal: 1, statement: "First finding", quote: "quoted one", conditions: null, blockIndex: 2, ambiguous: 0 }] },
    });
    const res = await buildContext(env, actor, {
      projectId: "p1",
      scopeMode: "project_default",
      model: { contextTokens: 2000, maxOutputTokens: 100 },
      history: [
        { role: "user", content: "Prior question", revisionIds: ["r9"] },
        { role: "assistant", content: "Keep two [S1:2] drop one [S1:1]", turnId: "t2", revisionIds: ["r9"], citations: [{ revisionId: "r9", sourceId: "s1", block: 2, start: 10, end: 19, sourceTitle: "Paper A", deleted: false, label: "[S1:2]" }, { revisionId: "r9", sourceId: "s1", block: 1, start: 0, end: 9, sourceTitle: "Paper A", deleted: false, label: "[S1:1]" }] },
      ],
    });
    expect(res.mode).toBe("claims");
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).toContain("Keep two [S1:2]");
    expect(body).not.toContain("drop one [S1:1]");
  });
  it("marks prior prose as conversation context not evidence", async () => {
    const { env } = twoSourceEnv();
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
    expect(res.messages[0]?.content).toContain("conversation context, not evidence");
    expect(res.messages[0]?.content).toContain("re-ground");
  });
});
