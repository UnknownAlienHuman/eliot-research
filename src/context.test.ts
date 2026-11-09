import { describe, expect, it } from "vitest";
import { scanBlocks, sliceUtf8 } from "./blocks.js";
import { buildContext } from "./context.js";
import { createModelHistoryReader } from "./model-history.js";
import { resolveCitations } from "./citations.js";
import { LibraryError } from "./library.js";
import { modelInputLimit, modelOutputReserve } from "./models.js";
import { chatModelMessages, estimateHistoryMessage, estimateModelInput } from "./model-input.js";
import type { Actor } from "./auth";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const NL = String.fromCharCode(10);
const actor = { type: "owner", id: "o1", authentication: "local" } as unknown as Actor;
const MODEL = { contextTokens: 1048576, maxOutputTokens: 2000 };
function requestEstimate(messages: { role: "system" | "user" | "assistant"; content: string }[], question = "", instructions = "") {
  return estimateModelInput({ instructions: [...messages.filter(m => m.role === "system").map(m => m.content), instructions].filter(Boolean).join("\n\n"),
    messages: chatModelMessages(messages, question) });
}
interface SourceEvidenceRecord { label: string; text: string }
function sourceEvidenceRecords(content: string): SourceEvidenceRecord[] {
  return content.split(NL).filter((line) => line.startsWith("{\"label\":"))
    .map((line) => JSON.parse(line) as SourceEvidenceRecord);
}

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
function streamObject(bytes: Uint8Array, size: number | undefined = bytes.byteLength) {
  let offset = 0;
  return { size, body: new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) { controller.close(); return; }
      const end = Math.min(offset + 65536, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 }) };
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
              return null;
            },
            async all() {
              if (sql.includes("FROM json_each(?) wanted")) {
                const ids = JSON.parse(params[0] as string) as string[], projectId = params[1] as string;
                return { results: ids.map(id => {
                  const membership = opts.memberships.find(m => m.projectId === projectId && m.sourceId === id);
                  const source = membership && opts.sources.find(s => s.id === id && s.state === "active");
                  const revision = source && opts.revisions.find(r => r.id === source.currentRevisionId);
                  return { id: source?.id, title: source?.title, revisionId: source?.currentRevisionId,
                    readableState: revision?.readableState, readableSize: revision?.readableSize, distillState: revision?.distillState,
                    guideSummary: revision?.guideSummary, reportKey: revision?.reportKey ?? null, attemptId: null, claimCount: revision?.claimCount ?? 0 };
                }) };
              }
              if (sql.includes("FROM claim")) {
                const rev = params[sql.includes("WITH owner") ? 5 : 0] as string;
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
                  return { id: s.id, title: s.title, revisionId: s.currentRevisionId as string, readableSize: r ? r.readableSize : null, distillState: r ? r.distillState : null, guideSummary: r ? r.guideSummary : null, reportKey: r?.reportKey ?? null, attemptId: null, claimCount: r?.claimCount ?? 0 };
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
        return streamObject(exact);
      }
      if (kind === "guide.md") {
        if (entry.guide === undefined) return null;
        const data = new TextEncoder().encode(entry.guide);
        return streamObject(data);
      }
      if (kind === "checked/guide.md") {
        if (entry.checkedGuide === undefined) return null;
        const data = new TextEncoder().encode(entry.checkedGuide);
        return streamObject(data);
      }
      if (kind === "checked/distill.json") {
        if (entry.report === undefined) return null;
        const raw = typeof entry.report === "string" ? entry.report : JSON.stringify(entry.report);
        const data = new TextEncoder().encode(raw);
        return streamObject(data);
      }
      if (kind === "blocks.json") return streamObject(new TextEncoder().encode(JSON.stringify(entry.blocks)));
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
  it.each([undefined, null, { contextTokens: 0, maxOutputTokens: 100 },
    { contextTokens: 2000, maxOutputTokens: 100, outputReserveTokens: 0 }])("preserves invalid400 for a missing or malformed model %j", async (model) => {
    const { env, reads } = twoSourceEnv();
    await expect(buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: model as never }))
      .rejects.toMatchObject({ code: "invalid", status: 400, message: "The model configuration is missing. Try again." });
    expect(reads()).toBe(0);
  });

  it("applies a known combined window without treating an input-only ceiling as that window", async () => {
    const text = Array(16).fill("Canonical source evidence. ".repeat(300)).join("\n\n"), blocks = scanBlocks(text);
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Canonical source", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "none", guideSummary: null, deletedAt: null }],
      texts: { r0: { text, blocks } } });
    const input = { projectId: "p1", scopeMode: "explicit" as const, sourceIds: ["s0"],
      model: { contextTokens: 1000000, maxOutputTokens: null, outputReserveTokens: 2048 } };
    const result = await buildContext(fixture.env, actor, input);
    expect(result.mode).toBe("whole");
    expect(result.sources[0]?.blocks).toEqual(blocks);
    await expect(buildContext(fixture.env, actor, { ...input, model: { ...input.model, contextWindowTokens: 40000 } }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(input.model.maxOutputTokens).toBeNull();
  });

  it("drops escape-heavy optional history by serialized cost while keeping fitting sources whole", async () => {
    const paragraph = "Canonical source evidence. ".repeat(300);
    const text = Array(15).fill(paragraph).join("\n\n"), blocks = scanBlocks(text);
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Canonical source", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "none", guideSummary: null, deletedAt: null }],
      texts: { r0: { text, blocks } } });
    const model = { contextTokens: 45000, maxOutputTokens: 2000 };
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"], model,
      history: [{ role: "user", content: '"'.repeat(10000) }, { role: "user", content: "Recent question" }] });
    expect(result.mode).toBe("whole");
    expect(result.messages.some(message => message.content === "Recent question")).toBe(true);
    expect(result.messages.some(message => message.content.includes('"'.repeat(100)))).toBe(false);
    expect(result.sources[0]?.blocks).toEqual(blocks);
    expect(requestEstimate(result.messages)).toBeLessThanOrEqual(modelInputLimit(model));
  });

  it.each([
    { bytes: 80000, context: 40000, previousCap: 24000 },
    { bytes: 1230000, context: 1000000, previousCap: 400000 },
  ])("keeps a canonical $bytes-byte source whole above the former $previousCap-token cap", async ({ bytes, context, previousCap }) => {
    const paragraph = "Canonical evidence describes the method, its conditions and limitations. ".repeat(120);
    const text = Array.from({ length: Math.ceil(bytes / paragraph.length) }, () => paragraph).join("\n\n").slice(0, bytes);
    const blocks = scanBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Canonical source", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: bytes, distillState: "none", guideSummary: null, deletedAt: null }],
      texts: { r0: { text, blocks } } });
    const model = { contextTokens: context, contextWindowTokens: context, maxOutputTokens: 32768, outputReserveTokens: 2048 };
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"], model, question: "Explain the source." });
    expect(result.mode).toBe("whole");
    expect(result.estimatedInputTokens).toBeGreaterThan(previousCap);
    expect(result.revisionIds).toEqual(["r0"]);
    expect(result.sources[0]?.blocks.map(block => [block.id, block.start, block.end]))
      .toEqual(blocks.map(block => [block.id, block.start, block.end]));
  });

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
    const body = res.messages.map((m) => m.content).join(NL);
    expect(sourceEvidenceRecords(body)).toContainEqual({ label: "[S1:1]", text: "Intro A." });
    expect(sourceEvidenceRecords(body)).toContainEqual({ label: "[S1:2]", text: "Second A." });
    expect(sourceEvidenceRecords(body)).toContainEqual({ label: "[S2:1]", text: "Paper B body.\n" });
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
    const secondSourceStart = source.indexOf("Source S2 — Paper B");
    const firstSource = source.slice(source.indexOf("Source S1 — Paper A"), secondSourceStart);
    const secondSource = source.slice(secondSourceStart);
    expect(firstSource).toContain("Citable labels for S1 (block IDs; gaps are intentional): [S1:2], [S1:3].");
    expect(firstSource).not.toContain("### Page 1\n");
    expect(firstSource).not.toContain("### Страница 2\n");
    expect(firstSource).not.toContain("Page 3\n");
    for (const unavailable of ["[S1:1]", "[S1:4]", "[S1:5]", "[S1:132]", "[S7:132]", "[S2:7]"]) {
      expect(firstSource).not.toContain(unavailable);
    }
    expect(sourceEvidenceRecords(firstSource)).toContainEqual({ label: "[S1:2]", text: "## Методы 🌿\n" });
    expect(sourceEvidenceRecords(firstSource)).toContainEqual({ label: "[S1:3]", text: "Les mesures de la Page 1 sont exactes.\n" });
    expect(secondSource).toContain("Citable labels for S2 (block IDs; gaps are intentional): [S2:7].");
    expect(sourceEvidenceRecords(secondSource)).toContainEqual({ label: "[S2:7]", text: secondText });
    expect(secondSource).not.toContain("[S1:2]");
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
    expect(requestEstimate(res.messages)).toBeLessThanOrEqual(modelInputLimit(MODEL));
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
    const contextTokens = requestEstimate(base.messages.slice(0, 1)) + maxOutputTokens;
    expect(requestEstimate(base.messages) + maxOutputTokens).toBeGreaterThan(contextTokens);
    expect(systemTokens).toBeGreaterThan(0);

    await expect(buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens, contextWindowTokens: contextTokens, maxOutputTokens },
    })).rejects.toMatchObject({ code: "invalid", status: 400, message: "Narrow the source selection so the answer fits." });
    expect(reads()).toBe(0);
  });

  it("rejects instead of silently discarding the latest exchange after reserving the empty policy", async () => {
    const { env, reads } = twoSourceEnv();
    const base = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL });
    const contextTokens = 2000;
    const maxOutputTokens = contextTokens - requestEstimate(base.messages) - 10;
    await expect(buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens, contextWindowTokens: contextTokens, maxOutputTokens },
      history: [
        { role: "user", content: "q".repeat(60), revisionIds: [] },
        { role: "assistant", content: "a".repeat(60), turnId: "prior" },
      ],
    })).rejects.toMatchObject({ code: "invalid", status: 400,
      message: expect.stringContaining("latest conversation exchange do not fit") });
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
    const pageMarkers = Array.from({ length: 2000 }, (_value, index) => "### Page " + (index + 1)).join(NL + NL);
    const pageText = pageMarkers + NL + NL + "Small citable paragraph." + NL;
    const pageBlocks = scanBlocks(pageText);
    const originalBlock = pageBlocks[pageBlocks.length - 1];
    if (!originalBlock) throw new Error("Expected the whole source to retain its final citable paragraph.");
    const largeRevision = "22222222-2222-4222-8222-222222222222";
    const pageRevision = "11111111-1111-4111-8111-111111111111";
    const largePrefix = "Background " + "b".repeat(9000);
    const compactQuote = "The result is 3 times.";
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
    expect(res.sources[0]?.blocks).toEqual([originalBlock]);
    expect(res.sources[1]?.blocks).toEqual([compactBlock]);
    const sourcesText = res.messages[1]?.content ?? "";
    expect(sourceEvidenceRecords(sourcesText)).toContainEqual({ label: "[S1:" + originalBlock.id + "]", text: "Small citable paragraph.\n" });
    expect(sourcesText).not.toContain("[S1:1]");
    expect(sourceEvidenceRecords(sourcesText)).toContainEqual({ label: "[S2:2]", text: compactQuote });
    expect(sourcesText).not.toContain("b".repeat(1000));
    const citations = resolveCitations("Whole [S1:" + originalBlock.id + "] and compact [S2:2].", res.sources);
    expect(citations.citations.map((citation) => [citation.sourceId, citation.revisionId, citation.block, citation.start, citation.end])).toEqual([
      ["s1", pageRevision, originalBlock.id, originalBlock.start, originalBlock.end],
      ["s2", largeRevision, compactBlock.id, compactBlock.start, compactBlock.end],
    ]);
    expect(citations.invalidLabels).toBe(0);
    expect(res.estimatedInputTokens + modelOutputReserve(model)).toBeLessThanOrEqual(Math.min(3000, 400000));
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

  it("uses available model capacity rather than a separate ten percent history quota", async () => {
    const { env } = twoSourceEnv();
    const pad = "y".repeat(2800);
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
    for (const n of [1, 2, 3, 4, 5]) expect(body).toContain("MARK" + n + " " + pad);
    expect(res.historyNotice).toBeUndefined();
    expect(requestEstimate(res.messages)).toBeLessThanOrEqual(20000);
  });


  it("admits empty and small scopes on a high-output model via outputReserveTokens", async () => {
    const dots = { contextTokens: 512000, maxOutputTokens: 460800, outputReserveTokens: 8192 };
    expect(modelOutputReserve({ maxOutputTokens: 460800 })).toBe(460800);
    expect(modelOutputReserve(dots)).toBe(8192);
    const { env } = twoSourceEnv();
    // An input-only ceiling does not lose the published output maximum.
    const inputOnly = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: [], model: { contextTokens: 512000, maxOutputTokens: 460800 } });
    expect(inputOnly.mode).toBe("none");
    const empty = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: [], model: dots });
    expect(empty.mode).toBe("none");
    expect(empty.revisionIds).toEqual([]);
    const small = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model: dots });
    expect(small.mode).toBe("whole");
    expect(small.revisionIds).toEqual(["r1"]);
  });
});

describe("block-scoped source input", () => {
  it("keeps adjacent heading and formula blocks separate in whole and compact evidence", async () => {
    const first = "5.3 Optimizer setup\n" + "The optimizer's beta parameters follow this generic setup. ".repeat(25);
    const formula = "For this example, eta_t = eta_0 * beta^t.\nWarmup lasts 4,000 steps.";
    const literal = "The source prints [S1:36] in this notation.";
    const text = [first, formula, literal].join(NL + NL) + NL;
    const encoder = new TextEncoder();
    const scanned = scanBlocks(text);
    const blocks = scanned.map((block, index) => ({ ...block, id: 35 + index }));
    const firstBlock = blocks[0], formulaBlock = blocks[1], literalBlock = blocks[2];
    if (!firstBlock || !formulaBlock || !literalBlock) throw new Error("Expected three adjacent source blocks.");
    const firstQuote = sliceUtf8(text, firstBlock.start, firstBlock.end);
    const formulaQuote = sliceUtf8(text, formulaBlock.start, formulaBlock.end);
    const literalQuote = sliceUtf8(text, literalBlock.start, literalBlock.end);
    const revisionId = "f0000000-0000-4000-8000-000000000001";
    const { env } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Generic paper", state: "active", currentRevisionId: revisionId, createdAt: 1 }],
      revisions: [{ id: revisionId, readableState: "readable", readableSize: encoder.encode(text).byteLength,
        distillState: "done", guideSummary: null, deletedAt: null, claimCount: 1 }],
      texts: { [revisionId]: { text, blocks, guide: "Guide [R" + revisionId + ":36]." } },
      claims: { [revisionId]: [{ ordinal: 0, statement: "The example specifies a formula and warmup.", quote: formulaQuote,
        conditions: null, blockIndex: 36, ambiguous: 0 }] },
    });

    const whole = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"],
      model: { contextTokens: 1048576, maxOutputTokens: 2000 } });
    expect(whole.mode).toBe("whole");
    expect(whole.messages[0]?.content).toContain("Each JSON record's label covers only its own text");
    const wholeSource = whole.messages[1]?.content ?? "";
    expect(sourceEvidenceRecords(wholeSource)).toEqual([
      { label: "[S1:35]", text: firstQuote },
      { label: "[S1:36]", text: formulaQuote },
      { label: "[S1:37]", text: literalQuote },
    ]);
    expect(wholeSource).toContain('"text":"The source prints \\u005bS1:36\\u005d in this notation.');

    const system = whole.messages[0]?.content ?? "";
    const compact = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"],
      model: { contextTokens: requestEstimate([{ role: "system", content: system }]) + 256, maxOutputTokens: 100 } });
    expect(compact.mode).toBe("claims");
    expect(sourceEvidenceRecords(compact.messages[1]?.content ?? "")).toEqual([{ label: "[S1:36]", text: formulaQuote }]);
    expect(compact.sources[0]?.blocks).toEqual([formulaBlock]);
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
    expect(sourceEvidenceRecords(res.messages[1]?.content ?? "")).toContainEqual({ label: "[S1:2]", text: "quoted one" });
    expect(res.messages[1]?.content).not.toContain("First finding");
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
    const model = { contextTokens: 400000, contextWindowTokens: 408192, maxOutputTokens: 8192 };
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
    const sourceText = res.messages[1]?.content ?? "";
    expect(sourceEvidenceRecords(sourceText)).toContainEqual({ label: "[S1:" + fixture.firstBlock.id + "]", text: smallQuote });
    expect(sourceEvidenceRecords(sourceText)).toContainEqual({ label: "[S2:" + compactBlock.id + "]", text: compactQuote });
    expect(sourceEvidenceRecords(sourceText)).toContainEqual({ label: "[S12:" + fixture.lastBlock.id + "]", text: lastQuote });
    const s2 = sourceText.slice(sourceText.indexOf("Paper 2"), sourceText.indexOf("Paper 3"));
    expect(s2).not.toContain("x".repeat(1000));
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
    expect(requestEstimate(res.messages)).toBeLessThanOrEqual(modelInputLimit(model));
  });

  it("keeps the latest exchange and all compact evidence when older history exceeds the final budget", async () => {
    const text = "Canonical source evidence describes the finding and its conditions. ".repeat(2000), blocks = scanBlocks(text);
    const claims = blocks.slice(0, 8).map((block, ordinal) => ({ ordinal, statement: "Finding", quote: sliceUtf8(text, block.start, block.end),
      conditions: null, blockIndex: block.id, ambiguous: 0 }));
    const { env, requested } = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: text.length, distillState: "done", guideSummary: null, deletedAt: null, claimCount: claims.length }],
      texts: { r9: { text, blocks, guide: "" } }, claims: { r9: claims } });
    const question = "Explain that finding.";
    const base = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens: 20000, maxOutputTokens: 100 }, question });
    const citations = resolveCitations("[S1:2]", base.sources).citations;
    const latest = [{ role: "user" as const, content: "Recent question", revisionIds: base.revisionIds },
      { role: "assistant" as const, content: "Original quoted finding [S1:2]. ".repeat(20).trim(), turnId: "latest", revisionIds: base.revisionIds, citations }];
    const cap = requestEstimate([...base.messages, ...latest], question) + 100;
    const model = { contextTokens: 20000, contextWindowTokens: cap + 100, maxOutputTokens: 100 };
    const before = requested.length;
    const result = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model, question,
      history: [{ role: "user", content: "Older question", revisionIds: base.revisionIds },
        { role: "assistant", content: "Older answer. ".repeat(80), turnId: "older", revisionIds: base.revisionIds, citations: [] }, ...latest] });
    expect(result.mode).toBe("claims");
    expect(result.sources).toEqual(base.sources);
    expect(result.messages.filter(message => message.turnId)).toEqual([expect.objectContaining({ turnId: "latest", content: latest[1]?.content })]);
    expect(result.historyNotice).toContain("Older exchanges were omitted");
    expect(result.messages.some(message => message.role === "system" && message.content === result.historyNotice)).toBe(true);
    expect(requestEstimate(result.messages, question)).toBeLessThanOrEqual(cap);
    expect(requested.slice(before)).toEqual(requested.slice(0, before)); // Same storage-only evidence work.
  });

  it("rejects an over-budget mixed scope after exact projection without dropping sources", async () => {
    const impossibleText = "u".repeat(1_300_000) + NL;
    const fixture = mixedScopeEnv(impossibleText);
    let err: unknown;
    try {
      await buildContext(fixture.env, actor, {
        projectId: "p1", scopeMode: "project_default", model: { contextTokens: 400000, maxOutputTokens: 8192 },
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
    const model = { contextTokens: 400000, contextWindowTokens: 408192, maxOutputTokens: 8192 };
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
    const cap = modelInputLimit(model);
    expect(historyTokens).toBeLessThanOrEqual(Math.floor(model.contextTokens * 0.1));
    expect(res.estimatedInputTokens).toBe(res.messages.reduce((sum, message) => sum + estimate(message.content), 0));
    expect(requestEstimate(res.messages, question, instructions)).toBeLessThanOrEqual(cap);
    expect(callerTokens).toBeGreaterThan(0);
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
    expect(sourceEvidenceRecords(source)).toContainEqual({ label: "[S1:2]", text: "## Методы 🌿\n" });
    expect(sourceEvidenceRecords(source)).toContainEqual({ label: "[S1:3]", text: "Les mesures sont exactes." });
    expect(source).not.toContain("[S1:1]");
    expect(source).not.toContain("[S1:4]");
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
    const model = { contextTokens: 3000, maxOutputTokens: 100 };
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1"], model });
    expect(res.mode).toBe("claims");
    expect(res.revisionIds).toEqual(["r9"]);
    expect(res.sources).toMatchObject([{ sourceId: "s1", revisionId: "r9", alias: "S1" }]);
    expect(res.sources[0]?.blocks).toEqual([{ id: 2, type: "paragraph", start: 0, end: passageEnd, heading: null }]);
    expect(res.messages[1]?.role).toBe("user");
    const source = res.messages[1]?.content ?? "";
    expect(sourceEvidenceRecords(source)).toContainEqual({ label: "[S1:2]", text: quote });
    expect(sourceEvidenceRecords(source)).toContainEqual({ label: "[S1:2]", text: otherQuote });
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
    expect(requestEstimate(res.messages)).toBeLessThanOrEqual(modelInputLimit(model));
    const resolved = resolveCitations("Original [S1:2], unseen [S1:3].", res.sources);
    expect(resolved.citations).toMatchObject([{ sourceId: "s1", revisionId: "r9", block: 2, start: 0, end: passageEnd }]);
    expect(resolved.invalidLabels).toBe(1);
  });

  it("reserved caller text pushes whole over cap and chooses claims", async () => {
    const body = "T".repeat(6000);
    const { env, requested } = makeEnv({
      memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper A", state: "active", currentRevisionId: "r9", createdAt: 1 }],
      revisions: [{ id: "r9", readableState: "readable", readableSize: 6000, distillState: "done", guideSummary: "Guide: G.", deletedAt: null, claimCount: 2 }],
      texts: { r9: { text: body, guide: "See nothing.", blocks: [{ id: 1, type: "paragraph", start: 0, end: 3000, heading: null }, { id: 2, type: "paragraph", start: 3000, end: 6000, heading: null }] } },
      claims: { r9: [{ ordinal: 1, statement: "Finding one", quote: "quoted one", conditions: null, blockIndex: 2, ambiguous: 0 }] },
    });
    const question = "Q" + "q".repeat(459), instructions = "I" + "i".repeat(459), outputTokens = 100;
    const estimateTokens = (value: string) => Math.ceil(new TextEncoder().encode(value).byteLength / 3);
    const measuredSystem = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "empty", model: { contextTokens: 5000, maxOutputTokens: outputTokens }, question, instructions,
    });
    const callerTokens = estimateTokens(question) + estimateTokens(instructions);
    const cap = requestEstimate(measuredSystem.messages.slice(0, 1), question, instructions) + 800;
    const contextTokens = cap;
    const res = await buildContext(env, actor, {
      projectId: "p1", scopeMode: "project_default", model: { contextTokens, maxOutputTokens: outputTokens }, question, instructions,
    });
    expect(res.mode).toBe("claims");
    expect(requestEstimate(res.messages, question, instructions)).toBeLessThanOrEqual(cap);
    expect(callerTokens).toBeGreaterThan(0);
    expect(res.revisionIds).toEqual(["r9"]);
    expect(requested.some((k) => k.endsWith("text.md"))).toBe(false);
    expect(res.messages[1]).toMatchObject({ role: "user" });
    const text = res.messages.map((m) => m.content).join(NL);
    expect(sourceEvidenceRecords(res.messages[1]?.content ?? "")).toContainEqual({ label: "[S1:2]", text: "quoted one" });
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
    expect((err as LibraryError).message).toMatch(/exceeds whole-reading capacity/);
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
    expect((err as LibraryError).message).toMatch(/exceeds whole-reading capacity/);
    expect(reads()).toBe(2); // The same immutable block map is reused by whole/compact attempts.
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
    const body = res.messages.map((m) => m.content).join(NL);
    expect(sourceEvidenceRecords(body)).toContainEqual({ label: "[S1:2]", text: "012345678" });
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
    expect(sourceEvidenceRecords(body)).toContainEqual({ label: "[S1:2]", text: "BBBBBBBBBB" });
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
    expect(sourceEvidenceRecords(res.messages[1]?.content ?? "")).toContainEqual({ label: "[S1:1]", text: "Alpha." });
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
    const contextTokens = requestEstimate(measuredWhole.messages.slice(0, 2));
    const cap = contextTokens;
    expect(requestEstimate(measuredWhole.messages)).toBeGreaterThan(cap);
    const res = await buildContext(env, actor, { projectId: "p1", scopeMode: "project_default", model: { contextTokens, maxOutputTokens: outputTokens } });
    expect(res.mode).toBe("whole");
    expect(res.messages.length).toBe(2);
    expect(res.estimatedInputTokens).toBe(baseTokens);
    expect(requestEstimate(res.messages)).toBeLessThanOrEqual(cap);
    expect(requestEstimate(measuredWhole.messages)).toBeGreaterThan(cap);
    expect(orientationTokens).toBeGreaterThan(0);
    const body = res.messages.map((m) => m.content).join(NL);
    expect(body).not.toContain("Derived orientation");
    expect(body).not.toContain("GGGGGGGG");
    expect(sourceEvidenceRecords(body)).toContainEqual({ label: "[S1:1]", text: "Alpha." });
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
    expect(sourceEvidenceRecords(sourceText)).toContainEqual({ label: "[S1:1]", text: "Alpha [S1] literal." });
    expect(sourceText).toContain("Source S1");
    expect(sourceText).toContain("Paper A");
    expect(sourceText).not.toMatch(/^\[S\d+\] /m);
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
    expect(sourceEvidenceRecords(sourceText)).toContainEqual({ label: "[S1:2]", text: passage });
    expect(sourceText).toContain("Citable labels for S1 (block IDs; gaps are intentional): [S1:2].");
    expect(sourceText).not.toContain("[S1:1]");
    expect(sourceText).not.toContain("[S1:3]");
    expect(sourceText).toContain("Source S1");
    expect(sourceText).toContain("Paper A");
    expect(sourceText).not.toMatch(/^\[S\d+\] /m);
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

describe("bounded context materialization", () => {
  const limit = 16 * 1024 * 1024;
  function scope(count = 3, text = "Evidence.", readableSize: number | null = null, distilled = false, reportKey: string | null = null) {
    return makeEnv({
      memberships: Array.from({ length: count }, (_, i) => ({ projectId: "p1", sourceId: "s" + i, enabled: 1 })),
      sources: Array.from({ length: count }, (_, i) => ({ id: "s" + i, title: "Paper " + i, state: "active", currentRevisionId: "r" + i, createdAt: i })),
      revisions: Array.from({ length: count }, (_, i) => ({ id: "r" + i, readableState: "readable", readableSize,
        distillState: distilled ? "done" : "none", guideSummary: null, deletedAt: null, claimCount: 1, reportKey })),
      texts: Object.fromEntries(Array.from({ length: count }, (_, i) => ["r" + i, { text, blocks: [wholeBlock(text, 1)], guide: "Guide." }])),
      claims: Object.fromEntries(Array.from({ length: count }, (_, i) => ["r" + i,
        [{ ordinal: 0, statement: text, quote: text, conditions: null, blockIndex: 1, ambiguous: 0 }]])),
    });
  }
  function strictScope(ids: string[]) {
    const fixture = scope(ids.length), db = new DatabaseSync(":memory:"), calls: string[] = [];
    const transferred: Record<string, unknown>[] = [];
    for (const file of readdirSync(new URL("../migrations/", import.meta.url)).filter(name => /^\d+_.+\.sql$/.test(name)).sort())
      db.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
    db.exec("INSERT INTO project(id,title,created_at,updated_at) VALUES('p1','Project',1,1)");
    for (const [i, id] of ids.entries()) {
      db.prepare("INSERT INTO source(id,title,kind,created_by,created_at,updated_at) VALUES(?,?,'text','owner',?,1)").run(id, "Paper " + i, i);
      db.prepare("INSERT INTO source_revision(id,source_id,revision_no,readable_state,readable_size,created_by,created_at) VALUES(?,?,1,'readable',9,'owner',1)").run("r" + i, id);
      db.prepare("UPDATE source SET current_revision_id=? WHERE id=?").run("r" + i, id);
      db.prepare("INSERT INTO project_source(project_id,source_id,added_by,added_at) VALUES('p1',?,'owner',1)").run(id);
    }
    fixture.env.DB = { prepare(sql: string) {
      const statement = db.prepare(sql);
      return { bind(...params: SQLInputValue[]) { return {
        async first() { calls.push(sql); return statement.get(...params) ?? null; },
        async all() { calls.push(sql); const rows = statement.all(...params); transferred.push(...rows); return { results: rows }; },
      }; } };
    } } as unknown as D1Database;
    return { ...fixture, db, calls, transferred };
  }
  it.each([0, 1, 1024])("freezes %i explicit sources with one bounded metadata query", async (count) => {
    const ids = Array.from({ length: count }, (_, i) => "s" + i), fixture = strictScope(ids);
    try {
      const order = [...ids].reverse();
      const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: order, model: MODEL });
      expect(result.revisionIds).toEqual(order.map(id => "r" + id.slice(1)));
      expect(result.sources.map(source => source.sourceId)).toEqual(order);
      expect(fixture.calls).toHaveLength(count ? 2 : 1);
    } finally { fixture.db.close(); }
  });
  it("keeps first-occurrence order, disabled membership and exact JSON string IDs", async () => {
    const ids = ["s0", "Пример😀\"'", "s2"], fixture = strictScope(ids);
    try {
      fixture.db.prepare("UPDATE project_source SET enabled=0 WHERE source_id=?").run(ids[1] ?? "");
      const input = { projectId: "p1", scopeMode: "explicit" as const, model: MODEL };
      const result = await buildContext(fixture.env, actor, { ...input, sourceIds: [ids[2] ?? "", ids[1] ?? "", ids[2] ?? "", "s0"] });
      expect(fixture.calls).toHaveLength(2);
      expect(result.revisionIds).toEqual(["r2", "r1", "r0"]);
      expect(result.sources.map(source => [source.sourceId, source.alias])).toEqual([[ids[2], "S1"], [ids[1], "S2"], [ids[0], "S3"]]);
      expect(resolveCitations("[S1:1] [S2:1] [S3:1]", result.sources).citations.map(c => [c.revisionId, c.start, c.end]))
        .toEqual([["r2", 0, 9], ["r1", 0, 9], ["r0", 0, 9]]);
      expect(result).toEqual(await buildContext(fixture.env, actor, { ...input, sourceIds: [ids[2] ?? "", ids[1] ?? "", "s0"] }));
    } finally { fixture.db.close(); }
  });
  it.each(["missing", "detached", "deleted", "archived", "null head", "wrong project"])("rejects %s scope before source body reads", async (kind) => {
    const fixture = strictScope(["s0"]);
    try {
      if (kind === "detached") fixture.db.exec("DELETE FROM project_source");
      if (kind === "deleted" || kind === "archived") fixture.db.prepare("UPDATE source SET state=?").run(kind);
      if (kind === "null head") fixture.db.exec("UPDATE source SET current_revision_id=NULL");
      if (kind === "wrong project") fixture.db.exec("INSERT INTO project(id,title,created_at,updated_at) VALUES('p2','Other',2,2)");
      await expect(buildContext(fixture.env, actor, { projectId: kind === "wrong project" ? "p2" : "p1", scopeMode: "explicit", sourceIds: [kind === "missing" ? "no-source" : "s0"], model: MODEL }))
        .rejects.toMatchObject({ code: "invalid", status: 400, message: "Narrow the source selection to readable sources in this project." });
      expect(fixture.calls).toHaveLength(2);
      expect(fixture.requested).toEqual([]);
    } finally { fixture.db.close(); }
  });
  it("preserves metadata-versus-missing error order and raw-list limits", async () => {
    const fixture = strictScope(["s0"]);
    try {
      fixture.db.prepare("UPDATE source SET title=?").run("x".repeat(4097));
      for (const [sourceIds, message] of [
        [["s0", "missing"], "Narrow the source selection so the answer fits."],
        [["missing", "s0"], "Narrow the source selection to readable sources in this project."],
        [["missing", "x".repeat(129)], "Narrow the source selection to readable sources in this project."],
        [Array<string>(1025).fill("s0"), "Narrow the source selection so the answer fits."],
      ] as const) {
        await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: [...sourceIds], model: MODEL })).rejects.toMatchObject({ message });
      }
      expect(fixture.calls).toHaveLength(7);
      expect(fixture.requested).toEqual([]);
    } finally { fixture.db.close(); }
  });
  it("retains the existing explicit policy for a head deleted after assignment", async () => {
    const fixture = strictScope(["s0"]);
    try {
      fixture.db.exec("UPDATE source_revision SET deleted_at=2");
      const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"], model: MODEL });
      expect(result.revisionIds).toEqual(["r0"]);
      const defaults = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
      expect(defaults.revisionIds).toEqual([]);
    } finally { fixture.db.close(); }
  });
  it("bounds conservative Unicode metadata and a previously occupied allocation allowance", async () => {
    const ids = Array.from({ length: 600 }, (_, i) => "s" + i), fixture = strictScope(ids);
    const input = { projectId: "p1", scopeMode: "explicit" as const, sourceIds: ids, model: MODEL };
    try {
      fixture.db.prepare("UPDATE source_revision SET guide_summary=?").run("g".repeat(4096));
      expect((await buildContext(fixture.env, actor, input)).revisionIds).toHaveLength(600);
      for (const [summary, question] of [["я".repeat(4096), ""], ["g".repeat(8192), "q".repeat(1000000)]] as const) {
        fixture.requested.length = 0; fixture.transferred.length = 0; fixture.calls.length = 0;
        fixture.db.prepare("UPDATE source_revision SET guide_summary=?").run(summary);
        await expect(buildContext(fixture.env, actor, { ...input, question }))
          .rejects.toMatchObject({ message: "Narrow the source selection so the answer fits." });
        expect(fixture.calls).toHaveLength(2);
        expect(fixture.requested).toEqual([]);
        expect(new TextEncoder().encode(JSON.stringify(fixture.transferred)).length).toBeLessThan(limit / 4 + 200000);
      }
    } finally { fixture.db.close(); }
  });
  it("rejects an oversized undistilled block before opening its text body", async () => {
    const fixture = scope(3, "x".repeat(limit + 1), limit + 1);
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested).toEqual(["source/r0/blocks.json"]);
  });
  it("does not start a speculative GET when its overhead would exhaust the allowance", async () => {
    const fixture = scope(1, "Evidence.", 9);
    // One metadata row costs 300 bytes, leaving 300 for the block reader.
    const question = "q".repeat((limit - 600) / 2);
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default",
      model: { ...MODEL, contextTokens: 20000000 }, question })).rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested).toEqual(["source/r0/blocks.json"]);
  });
  it.each(["missing", "invalid", "oversized block", "oversized map"])("cancels unread speculative text after a %s block map", async (kind) => {
    const fixture = scope(2, "Evidence.", 9);
    const get = fixture.env.BUCKET.get.bind(fixture.env.BUCKET);
    let textPulls = 0, textCancels = 0, textStartedBeforeMapSize = false;
    fixture.env.BUCKET.get = (async (key: string, options?: R2GetOptions) => {
      if (key === "source/r0/text.md") {
        fixture.requested.push(key);
        return { size: 9, body: new ReadableStream<Uint8Array>({
          pull() { textPulls++; }, cancel() { textCancels++; },
        }, { highWaterMark: 0 }) };
      }
      if (key !== "source/r0/blocks.json") return get(key, options);
      fixture.requested.push(key);
      if (kind === "oversized map") return { ...streamObject(new Uint8Array(0)), get size() {
        textStartedBeforeMapSize = fixture.requested.includes("source/r0/text.md");
        return limit + 1;
      } };
      // Text headers can arrive before block validation fails.
      await new Promise(resolve => setTimeout(resolve, 1));
      if (kind === "missing") return null;
      return streamObject(new TextEncoder().encode(JSON.stringify(kind === "invalid" ? []
        : [{ id: 1, type: "paragraph", start: 0, end: limit + 1, heading: null }])));
    }) as typeof fixture.env.BUCKET.get;
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: kind.startsWith("oversized") ? "invalid" : "unavailable" });
    expect(textPulls).toBe(0); expect(textCancels).toBe(1);
    if (kind === "oversized map") expect(textStartedBeforeMapSize).toBe(true);
    expect(fixture.requested).toEqual(["source/r0/blocks.json", "source/r0/text.md"]);
  });
  it.each([true, false])("preserves block-first failure order when prefetched text rejects early (map fails: %s)", async (mapFails) => {
    const fixture = scope(2, "Evidence.", 9), failure = new Error("R2 text failed");
    const get = fixture.env.BUCKET.get.bind(fixture.env.BUCKET);
    fixture.env.BUCKET.get = (async (key: string, options?: R2GetOptions) => {
      if (key === "source/r0/text.md") { fixture.requested.push(key); throw failure; }
      if (key === "source/r0/blocks.json") {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (mapFails) { fixture.requested.push(key); return null; }
      }
      return get(key, options);
    }) as typeof fixture.env.BUCKET.get;
    const result = buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL });
    if (mapFails) await expect(result).rejects.toMatchObject({ code: "unavailable", status: 503 });
    else await expect(result).rejects.toBe(failure);
    expect(fixture.requested).toHaveLength(2);
    expect(fixture.requested.some(key => key.startsWith("source/r1/"))).toBe(false);
  });
  it.each([null, 1])("counts unknown/understated source and object sizes (%s), cancels the stream and opens no later body", async (readableSize) => {
    const fixture = scope(3, "x", readableSize);
    const get = fixture.env.BUCKET.get.bind(fixture.env.BUCKET);
    let consumed = 0;
    let cancelled = false;
    const baseline = process.memoryUsage();
    let peakHeap = baseline.heapUsed;
    let peakBuffers = baseline.arrayBuffers;
    fixture.env.BUCKET.get = (async (key: string, options?: R2GetOptions) => {
      if (key !== "source/r0/text.md") return get(key, options);
      fixture.requested.push(key);
      return { size: 1, body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new Uint8Array(65536).fill(120);
          consumed += chunk.byteLength;
          const memory = process.memoryUsage();
          peakHeap = Math.max(peakHeap, memory.heapUsed);
          peakBuffers = Math.max(peakBuffers, memory.arrayBuffers);
          controller.enqueue(chunk);
          if (consumed >= limit + 65536) controller.close();
        },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }) };
    }) as typeof fixture.env.BUCKET.get;
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(cancelled).toBe(true);
    expect(consumed).toBeLessThanOrEqual(limit);
    expect(fixture.requested.some((key) => key.startsWith("source/r1/"))).toBe(false);
    console.warn("context-memory-observation", JSON.stringify({ readableSize, consumed, cancelled,
      heapIncrease: peakHeap - baseline.heapUsed, arrayBufferIncrease: peakBuffers - baseline.arrayBuffers }));
  });
  it("counts projected strings cumulatively and stops before the next text body", async () => {
    const fixture = scope(3, "x".repeat(1_000_000), null);
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested).toContain("source/r0/text.md");
    expect(fixture.requested).not.toContain("source/r2/text.md");
  });
  it.each(["blocks.json", "guide.md", "checked/distill.json"])("bounds %s before JSON parsing/decoding or later source reads", async (artifact) => {
    const fixture = scope(2, "Evidence.", 9_000_000, true, artifact.startsWith("checked/") ? "source/r0/checked/distill.json" : null);
    const get = fixture.env.BUCKET.get.bind(fixture.env.BUCKET);
    fixture.env.BUCKET.get = (async (key: string, options?: R2GetOptions) => {
      if (key !== "source/r0/" + artifact) return get(key, options);
      fixture.requested.push(key);
      return streamObject(new Uint8Array(limit + 1).fill(120), 1);
    }) as typeof fixture.env.BUCKET.get;
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested.some((key) => key.startsWith("source/r1/"))).toBe(false);
    expect(fixture.requested).not.toContain("source/r0/text.md");
  });
  it("bounds explicit and default scope cardinality without returning a partial scope", async () => {
    const fixture = scope(1025);
    for (const scopeMode of ["explicit", "project_default"] as const) {
      await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode, model: MODEL,
        sourceIds: Array.from({ length: 1025 }, (_, i) => "s" + i) }))
        .rejects.toMatchObject({ code: "invalid", status: 400 });
    }
    expect(fixture.requested).toEqual([]);
  });
  it("rejects oversized explicit IDs before binding or reading source bodies", async () => {
    const fixture = scope();
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s".repeat(129)], model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested).toEqual([]);
  });
  it("selects newest history before copying individually fitting older exchanges", async () => {
    const fixture = scope(1);
    const history = Array.from({ length: 49 }, (_, i) => [
      { role: "user" as const, content: "Old question " + i + "u".repeat(100000), revisionIds: ["r0"] },
      { role: "assistant" as const, content: "Old answer " + i + "a".repeat(100000), revisionIds: ["r0"], citations: [] },
    ]).flat();
    history.push({ role: "user", content: "Newest question", revisionIds: ["r0"] },
      { role: "assistant", content: "Newest answer", revisionIds: ["r0"], citations: [] });
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL, history });
    expect(result.messages.at(-1)?.content).toBe("Newest answer");
    expect(result.revisionIds).toEqual(["r0"]);
    expect(requestEstimate(result.messages)).toBeLessThanOrEqual(modelInputLimit(MODEL));
    expect(result.historyNotice).toBeTruthy();
  });
  it("keeps a latest exchange above the former quota when it fits the model", async () => {
    const fixture = scope(1);
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL,
      history: [{ role: "user", content: "Old question" }, { role: "assistant", content: "Old answer" },
        { role: "user", content: "New question" }, { role: "assistant", content: "n".repeat(400000) }] });
    expect(result.messages.at(-1)?.content).toBe("n".repeat(400000));
    expect(result.messages.some(message => message.content === "Old answer")).toBe(true);
    expect(result.historyNotice).toBeUndefined();
    expect(requestEstimate(result.messages)).toBeLessThanOrEqual(modelInputLimit(MODEL));
  });
  it("does not jump over a latest exchange above the full model budget to reuse older history", async () => {
    const fixture = scope(1);
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL,
      history: [{ role: "user", content: "Old question" }, { role: "assistant", content: "Old answer" },
        { role: "user", content: "New question" }, { role: "assistant", content: "n".repeat(4000000) }] }))
      .rejects.toMatchObject({ code: "invalid", status: 400, message: expect.stringContaining("latest conversation exchange do not fit") });
  });
  it("counts separate block maps cumulatively before reading later text", async () => {
    const fixture = scope();
    const get = fixture.env.BUCKET.get.bind(fixture.env.BUCKET);
    const blocks = new TextEncoder().encode(JSON.stringify(Array.from({ length: 2000 }, (_, i) =>
      ({ id: i + 1, type: "heading", start: 0, end: 1, heading: "h".repeat(200) }))));
    fixture.env.BUCKET.get = (async (key: string, options?: R2GetOptions) => {
      if (!key.endsWith("blocks.json")) return get(key, options);
      fixture.requested.push(key);
      return streamObject(blocks);
    }) as typeof fixture.env.BUCKET.get;
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested).toContain("source/r0/text.md");
    expect(fixture.requested).toContain("source/r1/blocks.json");
    expect(fixture.requested).not.toContain("source/r1/text.md");
    expect(fixture.requested.some((key) => key.startsWith("source/r2/"))).toBe(false);
  });
  it("rejects a guide range above the remaining bound before its R2 get", async () => {
    const revisionId = "11111111-1111-4111-8111-111111111111";
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper", state: "active", currentRevisionId: revisionId, createdAt: 1 }],
      revisions: [{ id: revisionId, readableState: "readable", readableSize: limit + 1, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 1 }],
      texts: { [revisionId]: { text: "Evidence.", blocks: [{ id: 1, type: "paragraph", start: 0, end: limit + 1, heading: null }], guide: "Guide [R" + revisionId + ":1]." } },
      claims: { [revisionId]: [{ ordinal: 0, statement: "Evidence.", quote: "Evidence.", conditions: null, blockIndex: 1, ambiguous: 0 }] },
    });
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested).toContain("source/" + revisionId + "/guide.md");
    expect(fixture.requested.some((key) => key.includes("text.md"))).toBe(false);
  });
  it("caps tiny guide range fan-out without returning partial source evidence", async () => {
    const revisionId = "11111111-1111-4111-8111-111111111111";
    const blocks = Array.from({ length: 257 }, (_, i) => ({ id: i + 1, type: "paragraph", start: i, end: i + 1, heading: null }));
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s1", enabled: 1 }],
      sources: [{ id: "s1", title: "Paper", state: "active", currentRevisionId: revisionId, createdAt: 1 }],
      revisions: [{ id: revisionId, readableState: "readable", readableSize: 9000000, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 1 }],
      texts: { [revisionId]: { text: "x".repeat(257), blocks, guide: blocks.map((block) => "[R" + revisionId + ":" + block.id + "]").join(" ") } },
      claims: { [revisionId]: [{ ordinal: 0, statement: "x", quote: "x", conditions: null, blockIndex: 1, ambiguous: 0 }] },
    });
    await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "project_default", model: MODEL }))
      .rejects.toMatchObject({ code: "invalid", status: 400 });
    expect(fixture.requested.filter((key) => key.includes("text.md#r"))).toHaveLength(256);
  });
  it.each(["sources", "source NUL", "summary NUL", "report NUL", "claims", "claim NUL", "source aggregate", "IDs"]
    .flatMap(kind => (["project_default", "explicit"] as const).map(scopeMode => ({ kind, scopeMode }))))("bounds $kind for $scopeMode before transferring oversized fields", async ({ kind, scopeMode }) => {
    const db = new DatabaseSync(":memory:");
    const fixture = scope();
    const transferred: Record<string, unknown>[] = [];
    try {
      db.exec(`CREATE TABLE project(id TEXT); INSERT INTO project VALUES('p1');
        CREATE TABLE source(id TEXT,title TEXT,current_revision_id TEXT,state TEXT,created_at INTEGER);
        CREATE TABLE source_revision(id TEXT,readable_state TEXT,readable_size INTEGER,distill_state TEXT,guide_summary TEXT,distill_report_key TEXT,deleted_at INTEGER,claim_count INTEGER,distill_attempt_id TEXT);
        CREATE TABLE project_source(project_id TEXT,source_id TEXT,enabled INTEGER);
        CREATE TABLE claim(source_revision_id TEXT,ordinal INTEGER,statement TEXT,quote TEXT,conditions TEXT,block_index INTEGER,ambiguous INTEGER);
        INSERT INTO source VALUES('s0','Paper','r0','active',1);
        INSERT INTO source_revision VALUES('r0','readable',9000000,'done',NULL,NULL,NULL,1,NULL);
        INSERT INTO project_source VALUES('p1','s0',1);`);
      if (kind === "sources" || kind === "source NUL") db.prepare("UPDATE source SET title=?").run((kind.endsWith("NUL") ? "a\0" : "") + "t".repeat(20000));
      else if (kind === "summary NUL") db.prepare("UPDATE source_revision SET guide_summary=?").run("a\0" + "g".repeat(40000));
      else if (kind === "report NUL") db.prepare("UPDATE source_revision SET distill_report_key=?").run("a\0" + "k".repeat(20000));
      else if (kind === "IDs") {
        const id = "a\0" + "i".repeat(20000);
        db.prepare("UPDATE source SET id=?").run(id);
        db.prepare("UPDATE project_source SET source_id=?").run(id);
      } else if (kind === "source aggregate") {
        db.prepare("UPDATE source_revision SET guide_summary=?").run("g".repeat(8192));
        const source = db.prepare("INSERT INTO source VALUES(?,?,'r0','active',1)");
        const membership = db.prepare("INSERT INTO project_source VALUES('p1',?,1)");
        for (let i = 1; i <= 600; i++) { source.run("s" + i, "Paper"); membership.run("s" + i); }
      } else db.prepare("INSERT INTO claim VALUES('r0',0,'Fact',?,NULL,1,0)").run((kind.endsWith("NUL") ? "a\0" : "") + "q".repeat(limit));
      fixture.env.DB = { prepare(sql: string) {
        const statement = db.prepare(sql);
        return { bind(...params: SQLInputValue[]) { return {
          async first() { return statement.get(...params) ?? null; },
          async all() { const rows = statement.all(...params); transferred.push(...rows); return { results: rows }; },
        }; } };
      } } as unknown as D1Database;
      const sourceIds = db.prepare("SELECT id FROM source ORDER BY id").all().map(row => row.id as string);
      await expect(buildContext(fixture.env, actor, { projectId: "p1", scopeMode, sourceIds, model: MODEL }))
        .rejects.toMatchObject({ code: "invalid", status: 400 });
      expect(fixture.requested).toEqual([]);
      expect(JSON.stringify(transferred).length).toBeLessThan(kind === "source aggregate" ? (scopeMode === "explicit" ? limit / 4 + 200000 : 200000) : 2000);
    } finally { db.close(); }
  });
});

describe("Follow-up source and history budget", () => {
  it("keeps a reachable third question within HY3 capacity without shortening its latest exchange", async () => {
    const paragraph = "Canonical source evidence describes the method, its conditions and limitations. ".repeat(50);
    const text = Array(150).fill(paragraph).join("\n\n").slice(0, 535400), blocks = scanBlocks(text);
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Canonical source", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "none", guideSummary: null, deletedAt: null }],
      texts: { r0: { text, blocks } } });
    const model = { contextTokens: 192000, contextWindowTokens: 256000, maxOutputTokens: 128000, outputReserveTokens: 8192 };
    const initialInput = { projectId: "p1", scopeMode: "explicit" as const, sourceIds: ["s0"], model, question: "Summarize the method." };
    const first = await buildContext(fixture.env, actor, initialInput);
    const frozenCitation = resolveCitations("[S1:1]", first.sources).citations;
    const answer = "The study describes its method and limitations. ".repeat(21) + "[S1:1]";
    const older = [
      { role: "user" as const, content: initialInput.question, revisionIds: first.revisionIds },
      { role: "assistant" as const, content: answer, turnId: "older-turn", revisionIds: ["r0"], citations: frozenCitation },
    ];
    const latest = [
      { role: "user" as const, content: "Explain the study design.", revisionIds: first.revisionIds },
      { role: "assistant" as const, content: answer, turnId: "latest-turn", revisionIds: ["r0"], citations: frozenCitation },
    ];
    const second = await buildContext(fixture.env, actor, { ...initialInput, question: latest[0]?.content ?? "", history: older });
    expect(second.mode).toBe("whole");
    expect(second.messages.at(-1)).toMatchObject({ turnId: "older-turn", content: answer });
    const followup = { ...initialInput, question: "Explain its limitations.", history: [...older, ...latest] };
    const withoutHistory = await buildContext(fixture.env, actor, { ...followup, history: [] });
    const latestOnly = await buildContext(fixture.env, actor, { ...followup, history: latest });
    expect(latestOnly.mode).toBe("whole");
    expect(latestOnly.messages.at(-1)).toMatchObject({ turnId: "latest-turn", content: answer });
    expect(latestOnly.revisionIds).toEqual(first.revisionIds);
    expect(latestOnly.sources).toEqual(first.sources);
    const result = await buildContext(fixture.env, actor, followup);
    expect(result.mode).toBe("whole");
    expect(result.sources).toEqual(first.sources);
    expect(result.revisionIds).toEqual(first.revisionIds);
    expect(result.messages.at(-1)).toMatchObject({ turnId: "latest-turn", content: answer });
    expect(result.messages.some(message => message.content === latest[0]?.content)).toBe(true);
    expect(result.messages.some(message => message.turnId === "older-turn")).toBe(false);
    expect(result.historyNotice).toContain("Older exchanges were omitted");
    expect(result.messages.some(message => message.role === "system" && message.content === result.historyNotice)).toBe(true);
    expect(requestEstimate(result.messages, followup.question)).toBeLessThanOrEqual(modelInputLimit(model));
    expect(result.estimatedInputTokens).toBe(result.messages.reduce((sum, message) => sum + Math.ceil(new TextEncoder().encode(message.content).byteLength / 3), 0));
    expect(first.historyNotice).toBeUndefined(); expect(second.historyNotice).toBeUndefined(); expect(latestOnly.historyNotice).toBeUndefined();
    expect(requestEstimate([...withoutHistory.messages, ...followup.history], followup.question)).toBeGreaterThan(modelInputLimit(model));
    // Capacity that fits both exchanges must keep them, without a misleading notice.
    const roomy = await buildContext(fixture.env, actor, { ...followup, model: { ...model, contextTokens: 200000 } });
    expect(roomy.messages.filter(message => message.turnId).map(message => message.turnId)).toEqual(["older-turn", "latest-turn"]);
    expect(roomy.historyNotice).toBeUndefined();
    // No older exchange can be removed when the latest complete answer itself does not fit.
    await expect(buildContext(fixture.env, actor, { ...followup, history: [{ role: "user", content: "Recent question", revisionIds: first.revisionIds },
      { ...latest[1], role: "assistant", content: answer.repeat(4) }] })).rejects.toMatchObject({ code: "invalid", status: 400 });
  });
});

describe("History memory and model capacity", () => {
  it("does not spend the assembly guard on optional older text before fitting evidence", async () => {
    const text = Array(140).fill("Canonical evidence. ".repeat(200)).join("\n\n");
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Paper", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "none", guideSummary: null, deletedAt: null }],
      texts: { r0: { text, blocks: scanBlocks(text) } } });
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"],
      model: { contextTokens: 1000000, maxOutputTokens: 2000 }, question: "Continue.", history: [
        { role: "user", content: "Old question", revisionIds: ["r0"] },
        { role: "assistant", content: "A".repeat(2500000), revisionIds: ["r0"], citations: [], turnId: "old" },
        { role: "user", content: "Recent question", revisionIds: ["r0"] },
        { role: "assistant", content: "Recent answer", revisionIds: ["r0"], citations: [], turnId: "new" },
      ] });
    expect(result.mode).toBe("whole");
    expect(result.messages.some(message => message.turnId === "new")).toBe(true);
    expect(result.messages.some(message => message.turnId === "old")).toBe(false);
    expect(result.historyNotice).toBeTruthy();
    expect(requestEstimate(result.messages, "Continue.")).toBeLessThanOrEqual(1000000);
  });
});

describe("History shared input budget", () => {
  function fixture(text = "Evidence.") {
    return makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Paper", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "none", guideSummary: null, deletedAt: null }],
      texts: { r0: { text, blocks: scanBlocks(text) } } });
  }
  const model = { contextTokens: 10000, maxOutputTokens: 100 };
  it("retains a 6000-character latest answer above the former 1000-token quota", async () => {
    const f = fixture();
    const result = await buildContext(f.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"], model, question: "Continue.", history: [
      { role: "user", content: "Earlier question", revisionIds: ["r0"] },
      { role: "assistant", content: "A".repeat(6000), revisionIds: ["r0"], turnId: "latest" },
    ] });
    expect(result.messages.at(-1)).toMatchObject({ content: "A".repeat(6000), turnId: "latest" });
    expect(result.historyNotice).toBeUndefined();
    expect(requestEstimate(result.messages, "Continue.")).toBeLessThanOrEqual(10000);
  });
  it("rejects a newest 30000-character answer that cannot fit instead of silently dropping it", async () => {
    const f = fixture();
    await expect(buildContext(f.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"], model, question: "Continue.", history: [
      { role: "user", content: "Earlier question", revisionIds: ["r0"] },
      { role: "assistant", content: "A".repeat(30000), revisionIds: ["r0"], turnId: "latest" },
    ] })).rejects.toMatchObject({ code: "invalid", status: 400 });
  });
  it("discloses an out-of-scope pair while retaining the newest eligible pair", async () => {
    const f = fixture();
    const result = await buildContext(f.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"], model, question: "Continue.", history: [
      { role: "user", content: "Foreign question", revisionIds: ["foreign"] },
      { role: "assistant", content: "Foreign answer", revisionIds: ["foreign"], turnId: "foreign" },
      { role: "user", content: "Earlier question", revisionIds: ["r0"] },
      { role: "assistant", content: "Earlier answer", revisionIds: ["r0"], turnId: "latest" },
    ] });
    expect(result.messages.at(-1)).toMatchObject({ turnId: "latest" });
    expect(result.messages.some(message => message.turnId === "foreign")).toBe(false);
    expect(result.historyNotice).toBeTruthy();
    expect(result.messages.some(message => message.role === "system" && message.content === result.historyNotice)).toBe(true);
  });
});

describe("History-aware source preflight", () => {
  it("does not materialize a 1.2 MB whole source before compacting for a 600 KB latest answer", async () => {
    const text = Array(320).fill("Canonical evidence. ".repeat(200)).join("\n\n").slice(0, 1200000);
    const blocks = scanBlocks(text);
    const block = blocks[0];
    if (!block) throw new Error("Expected an evidence block.");
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Paper", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "done", guideSummary: null, deletedAt: null, claimCount: 1 }],
      texts: { r0: { text, blocks, guide: "" } },
      claims: { r0: [{ ordinal: 0, statement: "Finding", quote: sliceUtf8(text, block.start, block.end), conditions: null, blockIndex: block.id, ambiguous: 0 }] } });
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"],
      model: { contextTokens: 450000, maxOutputTokens: 100 }, question: "Continue.", history: [
        { role: "user", content: "Earlier question", revisionIds: ["r0"] },
        { role: "assistant", content: "A".repeat(600000), revisionIds: ["r0"], turnId: "latest" },
      ] });
    expect(result.mode).toBe("claims");
    expect(result.messages.at(-1)).toMatchObject({ content: "A".repeat(600000), turnId: "latest" });
    expect(result.revisionIds).toEqual(["r0"]);
    expect(fixture.requested).not.toContain("source/r0/text.md");
    expect(requestEstimate(result.messages, "Continue.")).toBeLessThanOrEqual(450000);
    expect(result.historyNotice).toBeUndefined();
  });
});


describe("History omission disclosure", () => {
  it.each([false, true])("uses the already-loaded page boundary without retrieving more history (%s)", async (earlierHistoryExists) => {
    const { env, reads } = twoSourceEnv();
    const result = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL, earlierHistoryExists,
      history: [{ role: "user", content: "Latest question" }, { role: "assistant", content: "Latest answer", turnId: "latest" }] });
    expect(result.messages.at(-1)).toMatchObject({ content: "Latest answer", turnId: "latest" });
    if (earlierHistoryExists) {
      expect(result.historyNotice).toBeTruthy();
      expect(result.messages.some(message => message.role === "system" && message.content === result.historyNotice)).toBe(true);
    } else expect(result.historyNotice).toBeUndefined();
    expect(reads()).toBe(0);
    expect(requestEstimate(result.messages)).toBeLessThanOrEqual(modelInputLimit(MODEL));
  });
  it("discloses when the latest pair is excluded by scope instead of sending its source data", async () => {
    const { env, reads } = twoSourceEnv();
    const result = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL,
      history: [{ role: "user", content: "Foreign question", revisionIds: ["r1"] },
        { role: "assistant", content: "Foreign answer", revisionIds: ["r1"] }] });
    expect(result.historyNotice).toBeTruthy();
    expect(result.messages.some(message => message.content.includes("Foreign"))).toBe(false);
    expect(result.revisionIds).toEqual([]);
    expect(reads()).toBe(0);
  });
});


describe("Optional whole-source orientation memory", () => {
  it.each([
    { oldSize: 0, olderPresent: false, guidePresent: true, historyOmitted: false },
    { oldSize: 700000, olderPresent: true, guidePresent: true, historyOmitted: false },
    { oldSize: 780000 + 477752, olderPresent: true, guidePresent: false, historyOmitted: false },
    { oldSize: 790000 + 477752, olderPresent: true, guidePresent: false, historyOmitted: false },
    { oldSize: 800000 + 477752, olderPresent: true, guidePresent: false, historyOmitted: false },
    { oldSize: 900000 + 477752, olderPresent: false, guidePresent: true, historyOmitted: true },
  ])("does not reject retained exchanges for optional guide allocation ($oldSize older characters)", async ({ oldSize, olderPresent, guidePresent, historyOmitted }) => {
    const text = "Canonical evidence. ".repeat(50000), blocks = scanBlocks(text);
    const summary = "G".repeat(32768);
    const fixture = makeEnv({ memberships: [{ projectId: "p1", sourceId: "s0", enabled: 1 }],
      sources: [{ id: "s0", title: "Paper", state: "active", currentRevisionId: "r0", createdAt: 0 }],
      revisions: [{ id: "r0", readableState: "readable", readableSize: text.length, distillState: "done", guideSummary: summary, deletedAt: null, claimCount: 0 }],
      texts: { r0: { text, blocks, guide: "" } } });
    const result = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s0"],
      model: { contextTokens: 2000000, maxOutputTokens: 100 }, question: "Continue.", history: [
        ...(oldSize ? [{ role: "user" as const, content: "Older question", revisionIds: ["r0"] },
          { role: "assistant" as const, content: "A".repeat(oldSize), revisionIds: ["r0"], turnId: "old" }] : []),
        { role: "user", content: "Newest question", revisionIds: ["r0"] },
        { role: "assistant", content: "Newest answer", revisionIds: ["r0"], turnId: "latest" },
      ] });
    expect(result.mode).toBe("whole");
    expect(result.messages.at(-1)).toMatchObject({ turnId: "latest", content: "Newest answer" });
    expect(result.messages.some(message => message.content === "Newest question")).toBe(true);
    expect(result.sources[0]?.blocks).toEqual(blocks);
    expect(result.revisionIds).toEqual(["r0"]);
    expect(fixture.requested).toEqual(["source/r0/blocks.json", "source/r0/text.md"]);
    expect(result.messages.some(message => message.turnId === "old")).toBe(olderPresent);
    expect(result.messages.some(message => message.content === "Older question")).toBe(olderPresent);
    if (olderPresent) expect(result.messages.find(message => message.turnId === "old")?.content).toBe("A".repeat(oldSize));
    if (historyOmitted) expect(result.historyNotice).toBeTruthy();
    else expect(result.historyNotice).toBeUndefined();
    expect(result.messages.some(message => message.content.includes(summary))).toBe(guidePresent);
    expect(requestEstimate(result.messages, "Continue.")).toBeLessThanOrEqual(2000000);
  });
});

describe("Partial history notices follow retained exchanges", () => {
  const partialNotice = "An earlier assistant answer was partial.";
  it("includes one bounded notice for a retained partial, without shortening its answer", async () => {
    const { env } = twoSourceEnv();
    const result = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL,
      history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Unfinished answer", turnId: "partial", partial: true }] });
    expect(result.messages.filter(message => message.content.startsWith(partialNotice))).toHaveLength(1);
    expect(result.messages.at(-1)).toMatchObject({ content: "Unfinished answer", partial: true, turnId: "partial" });
    expect(result.historyNotice).toBeUndefined();
    expect(requestEstimate(result.messages)).toBeLessThanOrEqual(modelInputLimit(MODEL));
  });
  it("drops the partial notice when the only partial exchange is omitted for budget", async () => {
    const { env } = twoSourceEnv();
    const result = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: { contextTokens: 2500, maxOutputTokens: 100 },
      history: [{ role: "user", content: "Old question" }, { role: "assistant", content: "Old partial ".repeat(400), turnId: "partial", partial: true },
        { role: "user", content: "Latest question" }, { role: "assistant", content: "Latest complete answer", turnId: "latest" }] });
    expect(result.messages.some(message => message.content.startsWith(partialNotice))).toBe(false);
    expect(result.messages.some(message => message.turnId === "partial")).toBe(false);
    expect(result.messages.at(-1)?.turnId).toBe("latest");
    expect(result.historyNotice).toBeTruthy();
  });
  it("does not hide the latest partial or its notice to rescue a too-small budget", async () => {
    const { env } = twoSourceEnv();
    const history = [{ role: "user" as const, content: "Earlier question" }, { role: "assistant" as const, content: "Unfinished answer", turnId: "latest" }];
    const base = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: MODEL, history });
    await expect(buildContext(env, actor, { projectId: "p1", scopeMode: "empty", model: { contextTokens: requestEstimate(base.messages), maxOutputTokens: 100 },
      history: [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Unfinished answer", turnId: "latest", partial: true }] })).rejects.toMatchObject({ code: "invalid", status: 400 });
  });
});


describe("Long history framing", () => {
  it("charges every JSON array separator before reserving a history suffix", async () => {
    const history = Array.from({ length: 1000 }, (_, i) => [
      { role: "user" as const, content: "Question " + i + ": уточни прежний вывод." },
      { role: "assistant" as const, content: "A".repeat(600), turnId: "turn-" + i },
    ]).flat();
    const charged = history.reduce((sum, message) => sum + estimateHistoryMessage(message), 0);
    expect(charged).toBeGreaterThanOrEqual(requestEstimate(history, "Continue.") - requestEstimate([], "Continue."));
    const { env } = twoSourceEnv();
    const result = await buildContext(env, actor, { projectId: "p1", scopeMode: "empty", question: "Continue.",
      model: { contextTokens: 192000, maxOutputTokens: 8192 }, history });
    expect(result.messages.at(-1)).toMatchObject({ content: "A".repeat(600), turnId: "turn-999" });
    const retained = result.messages.filter(message => message.turnId).length;
    expect(retained).toBeGreaterThan(50); expect(retained).toBeLessThan(1000);
    expect(result.historyNotice).toBeTruthy();
    expect(requestEstimate(result.messages, "Continue.")).toBeLessThanOrEqual(192000);
  });
});


describe("Stored history uses final source scope and passages", () => {
  it.each([["s1", "s2"], ["s2", "s1"], ["s1"]])("matches direct history selection for ordered scope %j", async (...sourceIds) => {
    const fixture = twoSourceEnv();
    const original = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1", "s2"], model: MODEL });
    const citations = resolveCitations("Answer [S2:1]", original.sources).citations;
    const history = [{ role: "user" as const, content: "Question [S2:1]", revisionIds: ["r1", "r2"] },
      { role: "assistant" as const, content: "Answer [S2:1]", revisionIds: ["r2"], citations, turnId: "prior" }];
    const input = { projectId: "p1", scopeMode: "explicit" as const, sourceIds, model: MODEL, question: "Continue." };
    const expected = await buildContext(fixture.env, actor, { ...input, history });
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL,history_version INTEGER NOT NULL); CREATE INDEX turns_by_created ON turns(created_at,id)");
    db.prepare("INSERT INTO turns VALUES('prior',?,1,1)").run(JSON.stringify({ state: "completed", question: "Question [S2:1]", answer: "Answer [S2:1]", revisionIds: ["r1", "r2"], citations }));
    let fragmentReads = 0;
    const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
      if (query.includes("SELECT payload ->")) fragmentReads++;
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } } as unknown as SqlStorage;
    const get = fixture.env.BUCKET.get.bind(fixture.env.BUCKET);
    fixture.env.BUCKET.get = (async (key: string, options?: R2GetOptions) => {
      expect(fragmentReads).toBe(0); // Only scalar newest metadata precedes source loading.
      return get(key, options);
    }) as typeof fixture.env.BUCKET.get;
    try {
      const result = await buildContext(fixture.env, actor, { ...input, historyReader: createModelHistoryReader(sql, "current") });
      expect(result).toEqual(expected);
      expect(fragmentReads).toBe(sourceIds.includes("s2") ? 1 : 0);
    } finally { db.close(); }
  });
});


describe("Stored normalized history at the input edge", () => {
  it.each(["reordered", "stale-range", "unverified", "still-too-large"])("budgets the actual cleaned messages (%s)", async (kind) => {
    const fixture = twoSourceEnv();
    const original = await buildContext(fixture.env, actor, { projectId: "p1", scopeMode: "explicit", sourceIds: ["s1", "s2"], model: MODEL });
    const resolved = resolveCitations("[S2:1]", original.sources).citations;
    const citations = kind === "unverified" ? [] : kind === "stale-range" ? resolved.map(citation => ({ ...citation, start: 1 })) : resolved;
    const question = "Earlier question", answer = "Finding " + "[S2:1] ".repeat(100) + (kind === "still-too-large" ? "X".repeat(1000) : "");
    const sourceIds = kind === "reordered" || kind === "still-too-large" ? ["s2", "s1"] : ["s1", "s2"];
    const input = { projectId: "p1", scopeMode: "explicit" as const, sourceIds, model: { contextTokens: 2000, maxOutputTokens: 100 }, question: "Continue." };
    const history = [{ role: "user" as const, content: question, revisionIds: ["r1", "r2"] },
      { role: "assistant" as const, content: answer, revisionIds: citations.map(citation => citation.revisionId), citations, turnId: "prior" }];
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL,history_version INTEGER NOT NULL); CREATE INDEX turns_by_created ON turns(created_at,id)");
    db.prepare("INSERT INTO turns VALUES('prior',?,1,1)").run(JSON.stringify({ state: "completed", question, answer, revisionIds: ["r1", "r2"], citations }));
    let fragmentReads = 0;
    const sql = { exec(query: string, ...bindings: SQLInputValue[]) {
      if (query.includes("SELECT payload ->")) fragmentReads++;
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } } as unknown as SqlStorage;
    try {
      const storedInput = { ...input, historyReader: createModelHistoryReader(sql, "current") };
      if (kind === "still-too-large") {
        await expect(buildContext(fixture.env, actor, { ...input, history })).rejects.toMatchObject({ code: "invalid", status: 400 });
        await expect(buildContext(fixture.env, actor, storedInput)).rejects.toMatchObject({ code: "invalid", status: 400 });
      } else {
        const expected = await buildContext(fixture.env, actor, { ...input, history });
        const result = await buildContext(fixture.env, actor, storedInput);
        expect(result).toEqual(expected);
        expect(result.messages.at(-1)?.content).toBe("Finding");
        expect(result.historyNotice).toBeUndefined();
        expect(requestEstimate(result.messages, input.question)).toBeLessThanOrEqual(input.model.contextTokens);
        expect(fragmentReads).toBe(1);
      }
    } finally { db.close(); }
  });
});
