import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTurnInput, TurnView } from "./shared/api";
import type { ContextInput, ContextMessage, ContextResult } from "./context";
import type { Actor } from "./auth";
import type * as CostModule from "./cost";
import type * as ModelsModule from "./models";

interface WireAgentState { active: string | null; queued: RunTurnInput | null; stopRequested: boolean }
interface WireAgentCtx { database: DatabaseSync; waitUntil: (task: Promise<unknown>) => void }
interface WireSentMessage { role: string; content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; [key: string]: unknown }
interface WireSentBody { messages?: WireSentMessage[]; model?: unknown; [key: string]: unknown }

vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
  Agent: class {
    readonly name = "wire-chat";
    state: WireAgentState = { active: null, queued: null, stopRequested: false };
    ctx: WireAgentCtx;
    env: Env;
    constructor(ctx: { database: DatabaseSync }, env: Env) {
      this.ctx = { database: ctx.database, waitUntil: (task: Promise<unknown>) => { task.catch(() => undefined); } };
      this.env = env;
    }
    sql<T>(strings: TemplateStringsArray, ...values: SQLInputValue[]): T[] {
      const statement = this.ctx.database.prepare(strings.join("?"));
      return (statement.columns().length ? statement.all(...values) : (statement.run(...values), [])) as T[];
    }
    readonly broadcast = vi.fn<(payload: string) => void>();
    setState(state: WireAgentState) { this.state = state; }
  },
}));

vi.mock("./models", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelsModule>();
  const base = {
    route: "gateway:command-code/native-beam",
    id: "native-beam",
    label: "Beam",
    contextTokens: 1048576,
    maxOutputTokens: 8192,
    checkedOn: "2026-10-26",
    enabled: true,
    responseFormat: false,
    structuredOutputs: false,
  };
  const frozenProvider = { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true };
  const frozenRoute = (entry: typeof base, route: string) => ({ ...entry, route, routing: { provider: { ...frozenProvider }, gatewayId: "test-gw" } });
  return {
    ...actual,
    DEFAULT_MODEL: "gateway:command-code/native-beam",
    requireAvailableModel: vi.fn(async (_env: unknown, route: string) => {
      if (route === "gateway:command-code/native-beam") return frozenRoute(base, route);
      if (route === "gateway:command-code/other-beam") return frozenRoute({ ...base, id: "other-beam" }, route);
      if (route === "gateway:openrouter/test-model") return { ...base, route, id: "test-model", routing: { provider: { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", enabled: true }, gatewayId: "test-gw" } };
      throw new Error("unexpected model " + route);
    }),
    getModelConnection: vi.fn(async () => ({ gatewayId: "test-gw", provider: "ai-gateway", alias: "default" })),
  };
});

vi.mock("./cost", async (importOriginal) => {
  const actual = await importOriginal<typeof CostModule>();
  return {
    ...actual,
    admitTurn: vi.fn(async (_env: unknown, _chatId: string, _turnId: string, model: { contextTokens: number; maxOutputTokens: number | null; outputReserveTokens?: number }) => {
      const output = model.outputReserveTokens ?? model.maxOutputTokens ?? 0;
      return (model.contextTokens ?? 0) + output;
    }),
  };
});

vi.mock("./model-quota", async () => ({
  assertProviderAllowance: vi.fn(async () => {}),
}));

vi.mock("./context", async () => ({
  buildContext: vi.fn(async (_env: unknown, _actor: Actor, input: ContextInput) => {
    const messages: ContextMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "frozen [S1:1] source" },
    ];
    for (const turn of input.history ?? []) {
      if (turn.role === "user") messages.push({ role: "user", content: turn.content });
      else messages.push({ role: "assistant", content: turn.content, ...(turn.turnId ? { turnId: turn.turnId } : {}) });
    }
    return {
      mode: "whole",
      revisionIds: ["r1"],
      sources: [{ sourceId: "s1", revisionId: "r1", title: "Paper", alias: "S1", blocks: [{ id: 1, type: "paragraph", start: 0, end: 8, heading: null }] }],
      messages,
      estimatedInputTokens: 10,
    } satisfies ContextResult;
  }),
}));

import { ChatAgent } from "./chat";
import { getAgentByName } from "agents";
import { buildContext } from "./context";
import { admitTurn } from "./cost";
import { assertProviderAllowance } from "./model-quota";
import { requireAvailableModel } from "./models";
import { LibraryError } from "./library";

type SubmitResult = Awaited<ReturnType<ChatAgent["submitTurn"]>>;

const projectId = "wire-project";
const chatId = "wire-chat";

const sentBodies: WireSentBody[] = [];
let fetchCalls = 0;
let nextSSE: string | null = null;
const executedSql: string[] = [];
const TOKEN_BOUND = 1048576 + 8192;

function sse(chunks: string[]) {
  return chunks.map((c) => "data: " + c + "\n\n").join("") + "data: [DONE]\n\n";
}
function chunk(delta: unknown, finish: string | null, usage?: unknown) {
  return JSON.stringify({ id: "t1", object: "chat.completion.chunk", created: 1, model: "beam", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
}
function usageOnly(usage: unknown) {
  return JSON.stringify({ id: "t1", object: "chat.completion.chunk", created: 1, model: "beam", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
}
function usageOnlyWithoutChoices(usage: unknown) {
  return JSON.stringify({ id: "t1", object: "chat.completion.chunk", created: 1, model: "beam", choices: [], usage });
}

function makeHarness(quote = "A source", instructions = "") {
  const quoteBytes = new TextEncoder().encode(quote);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE chat(id TEXT PRIMARY KEY,project_id TEXT NOT NULL)");
  db.prepare("INSERT INTO chat VALUES ('wire-chat',?)").run(projectId);
  const d1 = new DatabaseSync(":memory:");
  d1.exec("CREATE TABLE chat(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,updated_at INTEGER)");
  d1.prepare("INSERT INTO chat(id,project_id) VALUES ('wire-chat',?)").run(projectId);
  d1.exec("CREATE TABLE chat_turn(chat_id TEXT, turn_id TEXT, model TEXT, scope_mode TEXT, scope_json TEXT, context_mode TEXT, state TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0), estimated_cost_microusd INTEGER, citations INTEGER, invalid_labels INTEGER, first_token_ms INTEGER, total_ms INTEGER, error TEXT, created_at INTEGER, PRIMARY KEY(chat_id, turn_id))");
  d1.exec("CREATE TRIGGER chat_turn_terminal_immutable BEFORE UPDATE ON chat_turn WHEN OLD.state IN ('completed','partial','failed','cancelled') BEGIN SELECT RAISE(ABORT,'terminal_chat_turn_is_immutable'); END");
  const env = {
    DB: {
      prepare(sql: string) {
        executedSql.push(sql);
        if (sql.includes("chat_turn") || sql.includes("UPDATE chat SET")) {
          return {
            first: async (): Promise<unknown> => null,
            bind: (...args: SQLInputValue[]) => ({
              first: async (): Promise<unknown> => {
                const stmt = d1.prepare(sql);
                return stmt.columns().length ? (stmt.get(...args) as unknown) : null;
              },
              run: async () => {
                const info = d1.prepare(sql).run(...args);
                return { meta: { changes: Number(info.changes) } };
              },
              all: async () => ({ results: [] as unknown[] }),
            }),
          };
        }
        return {
          first: async (): Promise<unknown> => {
            if (sql.includes("model_providers_json")) return { providers: JSON.stringify([{ id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true }, { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", enabled: true }, { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true }]) };
            return null;
          },
          bind: (..._args: SQLInputValue[]) => ({
            first: async (): Promise<unknown> => {
              if (sql.includes("FROM chat WHERE id=")) return { project_id: projectId };
              if (sql.includes("COALESCE(p.answer_model")) return { model: "gateway:command-code/native-beam", instructions };
              if (sql.includes("model_providers_json")) return { providers: JSON.stringify([{ id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true }, { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", enabled: true }, { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true }]) };
              if (sql.includes("model_gateway_id")) return { gatewayId: "test-gw" };
              if (sql.includes("FROM source_revision")) return { id: "r1", readable_state: "readable", readable_size: quoteBytes.byteLength,
                original_key: "fixture-original", original_filename: "fixture.md" };
              return null;
            },
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: [] as unknown[] }),
          }),
        };
      },
    },
    AI: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        if (typeof init?.body === "string") {
          try { sentBodies.push(JSON.parse(init.body) as WireSentBody); } catch { sentBodies.push({ raw: init.body.slice(0, 500) }); }
        }
        void url;
        return new Response(nextSSE ?? "", { headers: { "content-type": "text/event-stream" } });
      },
    },
    BUCKET: { get: async () => ({ arrayBuffer: async () => quoteBytes.buffer }) },
  } as unknown as Env;
  const agent = new ChatAgent({ database: db } as unknown as ConstructorParameters<typeof ChatAgent>[0], env);
  return { agent, db, d1, env, executedSql };
}

function requireTurn(value: SubmitResult): TurnView {
  if (!("state" in value)) throw new Error("expected a completed turn result");
  return value;
}

beforeEach(() => {
  sentBodies.length = 0;
  executedSql.length = 0;
  fetchCalls = 0;
  nextSSE = null;
  vi.clearAllMocks();
});

describe("ChatAgent older history", () => {
  const turn = (n: number): TurnView => ({ turnId: "history-" + String(n).padStart(4, "0"), question: "Question " + n, answer: "Answer " + n,
    state: "completed", model: "fixture", scopeMode: "empty", contextMode: "none", revisionIds: [], sourceIds: [], citations: [],
    invalidLabels: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: 1, error: null });
  const seed = (db: DatabaseSync, count: number, start = 1) => {
    for (let n = start; n < start + count; n++) db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,?)").run(turn(n).turnId, JSON.stringify(turn(n)), 100 + Math.floor(n / 90));
  };
  it("pages all equal-timestamp ties without gaps/duplicates, while model history stays latest 50", async () => {
    const h = makeHarness(); try {
      await h.agent.onStart(); seed(h.db, 163);
      const seen: string[] = []; let cursor: string | undefined;
      do {
        const page = await h.agent.getTurnPage(projectId, cursor);
        expect(page.turns.length).toBeLessThanOrEqual(50);
        expect(page.turns.every((t) => t.createdAt !== undefined && t.historyVersion === 0)).toBe(true);
        seen.unshift(...page.turns.map((t) => t.turnId)); cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(Array.from({ length: 163 }, (_, n) => turn(n + 1).turnId));
      expect(new Set(seen).size).toBe(163);
      expect((await h.agent.getTurns(projectId)).map((t) => t.turnId)).toEqual(seen.slice(-50));
      expect(h.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM turns WHERE (created_at,id)<(101,'history-0100') ORDER BY created_at DESC,id DESC LIMIT 50").all()).toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining("SEARCH turns USING COVERING INDEX turns_by_created") })]));
      expect(fetchCalls).toBe(0); expect(requireAvailableModel).not.toHaveBeenCalled();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("keeps a value boundary across updates, a new tied-timestamp turn, deletion of the anchor and restart", async () => {
    const h = makeHarness(); try {
      await h.agent.onStart(); seed(h.db, 120);
      const first = await h.agent.getTurnPage(projectId), oldest = first.turns[0];
      if (!oldest || !first.nextCursor) throw new Error("missing boundary");
      const before = await h.agent.getTurnPage(projectId, first.nextCursor);
      h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,101)").run(turn(121).turnId, JSON.stringify(turn(121)));
      (h.agent as unknown as { writeTurn(t: TurnView): void }).writeTurn({ ...oldest, answer: "New streamed text" });
      expect(h.db.prepare("SELECT created_at,history_version FROM turns WHERE id=?").get(oldest.turnId)).toMatchObject({ created_at: oldest.createdAt, history_version: 1 });
      h.db.prepare("DELETE FROM turns WHERE id=?").run(oldest.turnId);
      const restarted = new ChatAgent({ database: h.db } as unknown as ConstructorParameters<typeof ChatAgent>[0], h.env); await restarted.onStart();
      expect(await restarted.getTurnPage(projectId, first.nextCursor)).toEqual(before);
      const snapshot = await restarted.getSnapshot(projectId); expect(snapshot.turns.at(-1)?.turnId).toBe(turn(121).turnId);
      expect(fetchCalls).toBe(0);
    } finally { h.db.close(); h.d1.close(); }
  });
  it("adds version/index to existing storage without rewriting legacy payloads or creation timestamps", async () => {
    const h = makeHarness(); try {
      h.db.exec("CREATE TABLE turns(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL)"); seed(h.db, 1);
      const before = h.db.prepare("SELECT payload,created_at FROM turns").get(); await h.agent.onStart(); await h.agent.onStart();
      expect(h.db.prepare("SELECT payload,created_at FROM turns").get()).toEqual(before);
      const old = (await h.agent.getTurns(projectId))[0]; if (!old) throw new Error("missing legacy turn");
      expect(old.historyVersion).toBe(0);
      (h.agent as unknown as { writeTurn(t: TurnView): void }).writeTurn({ ...old, answer: "Stream one" });
      (h.agent as unknown as { writeTurn(t: TurnView): void }).writeTurn({ ...old, answer: "Stream two" });
      const frame = JSON.parse(String(vi.mocked(h.agent.broadcast).mock.calls.at(-1)?.[0] ?? "{}"));
      expect(frame.turn).toMatchObject({ answer: "Stream two", createdAt: old.createdAt, historyVersion: 2 });
      const payload = JSON.parse((h.db.prepare("SELECT payload FROM turns").get()?.payload as string));
      expect(payload.createdAt).toBeUndefined(); expect(payload.historyVersion).toBeUndefined();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("browsing older pages does not widen the next explicit turn's existing latest-50 model history", async () => {
    const h = makeHarness(); try {
      await h.agent.onStart(); seed(h.db, 120);
      let cursor = (await h.agent.getTurnPage(projectId)).nextCursor;
      while (cursor) cursor = (await h.agent.getTurnPage(projectId, cursor)).nextCursor;
      expect(fetchCalls).toBe(0);
      nextSSE = sse([chunk({ content: "Bounded answer [S1:1]." }, "stop", { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 })]);
      await h.agent.submitTurn({ projectId, chatId, turnId: "aaaaaaaa-aaaa-4aaa-8aaa-999999999999", question: "New explicit send", scopeMode: "empty", model: "gateway:openrouter/test-model" }, true);
      const history = vi.mocked(buildContext).mock.calls.at(-1)?.[2].history ?? [];
      const questions = history.filter((item) => item.role === "user").map((item) => item.content);
      expect(questions).toEqual(Array.from({ length: 49 }, (_, n) => "Question " + (n + 72)));
      expect(fetchCalls).toBe(1); // The existing in-process fake stream, never a provider call.
    } finally { h.db.close(); h.d1.close(); }
  });
  it.each(["", "{}", "[]", "null", '["other-chat",1,"turn"]', '["wire-chat",-1,"turn"]', '["wire-chat",1.5,"turn"]', '["wire-chat",1,""]', "x".repeat(513)])("rejects malformed or foreign cursor %s without model work", async (cursor) => {
    const h = makeHarness(); try {
      await h.agent.onStart(); await expect(h.agent.getTurnPage(projectId, cursor)).rejects.toMatchObject({ code: "invalid", status: 400 });
      await expect(h.agent.getTurnPage("other-project")).rejects.toMatchObject({ code: "not_found", status: 404 });
      expect(fetchCalls).toBe(0); expect(requireAvailableModel).not.toHaveBeenCalled();
    } finally { h.db.close(); h.d1.close(); }
  });
});

describe("ChatAgent interrupted queue recovery", () => {
  const activeId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
  const queuedId = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
  function queuedInput(model?: string): RunTurnInput {
    return { projectId, chatId, turnId: queuedId, question: "Keep this queued question exactly.",
      scopeMode: "explicit", sourceIds: ["s2", "s1"], ...(model ? { model } : {}) };
  }
  async function recoveryHarness(model?: string) {
    const h = makeHarness();
    await h.agent.onStart();
    const active: TurnView = { turnId: activeId, question: "Active question", answer: "Partial source answer [S1:1].", state: "started",
      model: "gateway:command-code/native-beam", scopeMode: "explicit", sourceIds: ["s1"], revisionIds: ["r1"],
      citations: [{ revisionId: "r1", sourceId: "s1", block: 1, start: 0, end: 8, sourceTitle: "Paper", deleted: false, label: "[S1:1]" }],
      invalidLabels: 0, inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: TOKEN_BOUND,
      firstTokenMs: 12, totalMs: null, error: null };
    h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,?)").run(activeId, JSON.stringify(active), 100);
    h.d1.prepare("INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,token_limit,created_at) VALUES(?,?,?,?,?,'whole','started',?,100)")
      .run(chatId, activeId, active.model, active.scopeMode, JSON.stringify(active.revisionIds), TOKEN_BOUND);
    const state: WireAgentState = { active: activeId, queued: queuedInput(model), stopRequested: false };
    return { ...h, active, state };
  }
  function restart(h: ReturnType<typeof makeHarness>, state: WireAgentState) {
    const agent = new ChatAgent({ database: h.db } as unknown as ConstructorParameters<typeof ChatAgent>[0], h.env);
    agent.setState(structuredClone(state));
    return agent;
  }
  function expectNoDispatch() {
    expect(requireAvailableModel).not.toHaveBeenCalled();
    expect(admitTurn).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
    expect(fetchCalls).toBe(0);
  }
  it.each([undefined, "gateway:must-not-resolve/queued-model"])("preserves A and queued B on startup, reconnect and repeat ID (model=%s)", async (model) => {
    const h = await recoveryHarness(model);
    try {
      const agent = restart(h, h.state);
      const setState = agent.setState.bind(agent);
      vi.spyOn(agent, "setState").mockImplementation((next) => {
        if (next.queued === null) expect(h.db.prepare("SELECT payload FROM turns WHERE id=?").get(queuedId)).toBeDefined();
        setState(next);
      });
      await agent.onStart();
      const snapshot = await agent.getSnapshot(projectId);
      expect(snapshot.queued).toBeNull();
      const a = snapshot.turns.find((turn) => turn.turnId === activeId);
      const b = snapshot.turns.find((turn) => turn.turnId === queuedId);
      expect(a).toMatchObject({ ...h.active, state: "partial", error: expect.stringContaining("interrupted") });
      expect(b).toMatchObject({ turnId: queuedId, question: h.state.queued?.question, input: h.state.queued, state: "failed",
        model: model ?? "", scopeMode: "explicit", sourceIds: ["s2", "s1"], revisionIds: [], contextMode: "none",
        answer: "", citations: [], inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0,
        error: expect.stringContaining("not sent to the model") });
      const rowBefore = h.db.prepare("SELECT payload,created_at FROM turns WHERE id=?").get(queuedId);
      // Replay the old durable state after the local write but before its clear.
      const replay = restart(h, h.state);
      await replay.onStart();
      expect(h.db.prepare("SELECT payload,created_at FROM turns WHERE id=?").get(queuedId)).toEqual(rowBefore);
      const send = vi.fn();
      vi.mocked(getAgentByName).mockResolvedValue(replay as never);
      await replay.onConnect({ send } as unknown as Parameters<ChatAgent["onConnect"]>[0],
        { request: new Request("http://localhost/?projectId=" + projectId) } as Parameters<ChatAgent["onConnect"]>[1]);
      expect(JSON.parse(send.mock.calls[0]?.[0] as string).turns).toContainEqual(b);
      expect(await replay.submitTurn(queuedInput(model), false)).toEqual(b);
      expect(await replay.submitTurn(queuedInput(model), true)).toEqual(b);
      await replay.stopTurn(projectId, queuedId);
      await expect(replay.getStoredTurn(projectId, queuedId)).rejects.toMatchObject({ code: "conflict" });
      const saved = await replay.getStoredTurn(projectId, activeId);
      expect(saved.state).toBe("partial");
      expect(saved.answer).toContain("Partial answer");
      expect(saved.citations).toEqual(h.active.citations.map((citation) => ({ ...citation, label: "[Rr1:1]" })));
      expect(h.d1.prepare("SELECT state,input_tokens,cached_tokens,output_tokens,token_limit FROM chat_turn WHERE turn_id=?").get(activeId))
        .toMatchObject({ state: "partial", input_tokens: null, cached_tokens: null, output_tokens: null, token_limit: TOKEN_BOUND });
      expect(h.d1.prepare("SELECT * FROM chat_turn WHERE turn_id=?").get(queuedId)).toBeUndefined();
      expectNoDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("recovers an orphan queue with no active turn", async () => {
    const h = await recoveryHarness();
    try {
      const agent = restart(h, { active: null, queued: queuedInput(), stopRequested: false });
      await agent.onStart();
      expect((await agent.getTurns(projectId)).find((turn) => turn.turnId === queuedId))
        .toMatchObject({ state: "failed", input: queuedInput(), tokenLimit: 0 });
      expect(agent.state.queued).toBeNull();
      expectNoDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it.each(["write", "broadcast"])("keeps B recoverable after a local %s failure", async (failure) => {
    const h = await recoveryHarness();
    try {
      const agent = restart(h, h.state);
      if (failure === "write") h.db.exec("CREATE TRIGGER fail_queued_write BEFORE INSERT ON turns WHEN NEW.id='" + queuedId + "' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
      else vi.spyOn(agent, "broadcast").mockImplementationOnce(() => { throw new Error("fixture disconnected reader"); });
      if (failure === "write") {
        await expect(agent.onStart()).rejects.toThrow();
        expect(agent.state.queued).toEqual(h.state.queued);
      } else {
        await agent.onStart();
        expect(agent.state.queued).toBeNull();
      }
      const before = h.db.prepare("SELECT payload,created_at FROM turns WHERE id=?").get(queuedId);
      if (failure === "write") h.db.exec("DROP TRIGGER fail_queued_write");
      const replay = restart(h, h.state);
      await replay.onStart();
      const after = h.db.prepare("SELECT payload,created_at FROM turns WHERE id=?").get(queuedId);
      expect(after).toBeDefined();
      if (before) expect(after).toEqual(before);
      expect(replay.state).toEqual({ active: null, queued: null, stopRequested: false });
      expectNoDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("retains B's input during promotion until its first turn payload is durable", async () => {
    const h = await recoveryHarness();
    let releaseValidation: (() => void) | undefined;
    try {
      h.agent.setState(h.state);
      const prepare = h.env.DB.prepare.bind(h.env.DB);
      h.env.DB.prepare = ((sql: string) => sql.includes("FROM chat WHERE id=") ? {
        bind: () => ({ first: () => new Promise<{ project_id: string }>((resolve) => { releaseValidation = () => resolve({ project_id: projectId }); }) }),
      } : prepare(sql)) as typeof h.env.DB.prepare;
      (h.agent as unknown as { advanceQueue(id: string): void }).advanceQueue(activeId);
      expect(h.agent.state).toMatchObject({ active: queuedId, queued: queuedInput() });
      expect(h.db.prepare("SELECT payload FROM turns WHERE id=?").get(queuedId)).toBeUndefined();
      h.env.DB.prepare = prepare;
      const replay = restart(h, h.agent.state);
      await replay.onStart();
      expect((await replay.getTurns(projectId)).find((turn) => turn.turnId === queuedId))
        .toMatchObject({ state: "failed", input: queuedInput(), inputTokens: 0, tokenLimit: 0 });
      expect(await replay.submitTurn(queuedInput(), true)).toMatchObject({ state: "failed", tokenLimit: 0 });
      expectNoDispatch();
    } finally {
      h.agent.setState({ active: null, queued: null, stopRequested: false });
      releaseValidation?.();
      await Promise.resolve(); await Promise.resolve();
      h.db.close(); h.d1.close();
    }
  });
  it.each(["queued", "turn"])("does not strand a handed-off question when the %s notification fails", async (frameType) => {
    const h = await recoveryHarness("gateway:must-not-resolve/queued-model");
    try {
      h.agent.setState(h.state);
      let failed = false;
      vi.spyOn(h.agent, "broadcast").mockImplementation((payload) => {
        if (!failed && typeof payload === "string" && JSON.parse(payload).type === frameType) { failed = true; throw new Error("fixture reader disconnected"); }
      });
      (h.agent as unknown as { advanceQueue(id: string): void }).advanceQueue(activeId);
      await (h.agent as unknown as { current: Promise<TurnView> }).current;
      expect(failed).toBe(true);
      expect(h.agent.state).toEqual({ active: null, queued: null, stopRequested: false });
      const b = (await h.agent.getTurns(projectId)).find((turn) => turn.turnId === queuedId);
      expect(b).toMatchObject({ state: "failed", inputTokens: 0, tokenLimit: 0 });
      expect(await h.agent.submitTurn(queuedInput("gateway:must-not-resolve/queued-model"), true)).toEqual(b);
      expect(requireAvailableModel).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toBe(0);
    } finally { h.db.close(); h.d1.close(); }
  });
  it("preserves B as undispatched when handoff project validation fails", async () => {
    const h = await recoveryHarness();
    try {
      h.agent.setState(h.state);
      const prepare = h.env.DB.prepare.bind(h.env.DB);
      h.env.DB.prepare = ((sql: string) => sql.includes("FROM chat WHERE id=") ? { bind: () => ({ first: async () => null }) } : prepare(sql)) as typeof h.env.DB.prepare;
      (h.agent as unknown as { advanceQueue(id: string): void }).advanceQueue(activeId);
      const b = await (h.agent as unknown as { current: Promise<TurnView> }).current;
      h.env.DB.prepare = prepare;
      expect(b).toMatchObject({ state: "failed", input: queuedInput(), inputTokens: 0, tokenLimit: 0,
        error: expect.stringContaining("could not be validated") });
      expect(h.agent.state).toEqual({ active: null, queued: null, stopRequested: false });
      expect(await h.agent.submitTurn(queuedInput(), true)).toMatchObject(b);
      expectNoDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("recovers a retained first handoff payload as known zero without changing its creation time", async () => {
    const h = await recoveryHarness();
    try {
      const initial = { ...h.active, turnId: queuedId, question: queuedInput().question, answer: "", model: "",
        sourceIds: queuedInput().sourceIds, revisionIds: [], citations: [], tokenLimit: null, firstTokenMs: null };
      h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,200)").run(queuedId, JSON.stringify(initial));
      const replay = restart(h, { active: queuedId, queued: queuedInput(), stopRequested: false });
      await replay.onStart();
      const b = (await replay.getTurns(projectId)).find((turn) => turn.turnId === queuedId);
      expect(b).toMatchObject({ state: "failed", input: queuedInput(), inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0,
        error: expect.stringContaining("not sent to the model") });
      expect(h.db.prepare("SELECT created_at FROM turns WHERE id=?").get(queuedId)).toEqual({ created_at: 200 });
      expectNoDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("stores a maximum-length Unicode queued question once while preserving its exact input", async () => {
    const h = await recoveryHarness();
    try {
      const input = { ...queuedInput(), question: "文".repeat(400000) };
      const agent = restart(h, { active: null, queued: input, stopRequested: false });
      await agent.onStart();
      const row = h.db.prepare("SELECT payload FROM turns WHERE id=?").get(queuedId) as { payload: string };
      expect(new TextEncoder().encode(row.payload).byteLength).toBeLessThan(2_000_000);
      expect(JSON.parse(row.payload).input).not.toHaveProperty("question");
      expect((await agent.getTurns(projectId)).find((turn) => turn.turnId === queuedId)?.input).toEqual(input);
      expectNoDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it.each([
    { fault: "write", persistent: false }, { fault: "state-clear", persistent: false },
    { fault: "write", persistent: true }, { fault: "state-clear", persistent: true },
  ])("recovers a live handoff after $fault failure (persistent=$persistent) without creating another Agent", async ({ fault, persistent }) => {
    const h = await recoveryHarness();
    try {
      const agent = h.agent;
      agent.setState(h.state);
      let broken = true, failedWrites = 0;
      if (fault === "write") {
        h.db.function("fail_queued_handoff", () => {
          if (persistent || failedWrites === 0) { failedWrites++; throw new Error("fixture transient write failure"); }
          return 0;
        });
        h.db.exec("CREATE TRIGGER fail_live_handoff BEFORE INSERT ON turns WHEN NEW.id='" + queuedId + "' BEGIN SELECT fail_queued_handoff(); END;");
      } else {
        const setState = agent.setState.bind(agent);
        vi.spyOn(agent, "setState").mockImplementation((state) => {
          if (broken && (persistent || failedWrites === 0) && state.queued === null && agent.state.queued?.turnId === queuedId) {
            failedWrites++; throw new Error("fixture transient state-clear failure");
          }
          setState(state);
        });
      }
      (agent as unknown as { advanceQueue(id: string): void }).advanceQueue(activeId);
      const task = (agent as unknown as { current: Promise<TurnView> }).current;
      await expect(task).rejects.toThrow();
      expect((agent as unknown as { current?: Promise<TurnView>; controller?: AbortController }).current).toBeUndefined();
      expect((agent as unknown as { controller?: AbortController }).controller).toBeUndefined();
      if (persistent) {
        await expect(agent.getSnapshot(projectId)).rejects.toMatchObject({ code: "unavailable", status: 503 });
        expect(failedWrites).toBe(3); // Initial operation, completion, then one explicit read; no loop.
        expect(agent.state).toMatchObject({ active: queuedId, queued: queuedInput() });
      } else {
        expect(failedWrites).toBe(1);
        expect(agent.state).toEqual({ active: null, queued: null, stopRequested: false });
      }
      expectNoDispatch();
      if (fault === "write") h.db.exec("DROP TRIGGER fail_live_handoff");
      broken = false;
      const send = vi.fn();
      vi.mocked(getAgentByName).mockResolvedValue(agent as never);
      await agent.onConnect({ send } as unknown as Parameters<ChatAgent["onConnect"]>[0],
        { request: new Request("http://localhost/?projectId=" + projectId) } as Parameters<ChatAgent["onConnect"]>[1]);
      const snapshot = await agent.getSnapshot(projectId);
      const b = snapshot.turns.find((turn) => turn.turnId === queuedId);
      expect(b).toMatchObject({ state: "failed", input: queuedInput(), inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0 });
      expect(JSON.parse(send.mock.calls[0]?.[0] as string).turns).toContainEqual(b);
      expect(snapshot.queued).toBeNull();
      expect(agent.state).toEqual({ active: null, queued: null, stopRequested: false });
      const stored = h.db.prepare("SELECT payload,created_at FROM turns WHERE id=?").get(queuedId);
      expect(await agent.submitTurn(queuedInput(), true)).toEqual(b);
      expect(await agent.submitTurn(queuedInput(), false)).toEqual(b);
      expect(h.db.prepare("SELECT payload,created_at FROM turns WHERE id=?").get(queuedId)).toEqual(stored);
      expectNoDispatch();
      nextSSE = sse([chunk({ content: "New explicit answer [S1:1]." }, "stop", { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 })]);
      const c = requireTurn(await agent.submitTurn({ ...queuedInput(), turnId: "cccccccc-cccc-4ccc-8ccc-000000000003",
        question: "New explicit question.", model: "gateway:command-code/native-beam" }, true));
      expect(c.state).toBe("completed");
      expect(fetchCalls).toBe(1); // Only C's explicit Send reaches the synthetic transport.
    } finally { h.db.close(); h.d1.close(); }
  });
  it("does not resurrect queued B in a snapshot whose history read was delayed until B finished", async () => {
    const h = await recoveryHarness();
    let releaseRead: (() => void) | undefined;
    try {
      const agent = h.agent;
      agent.setState(h.state);
      const getTurns = agent.getTurnPage.bind(agent);
      vi.spyOn(agent, "getTurnPage").mockImplementationOnce(async (id) => {
        await new Promise<void>((resolve) => { releaseRead = resolve; });
        return getTurns(id);
      });
      const pendingSnapshot = agent.getSnapshot(projectId);
      nextSSE = sse([chunk({ content: "B finished [S1:1]." }, "stop", { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 })]);
      (agent as unknown as { advanceQueue(id: string): void }).advanceQueue(activeId);
      await (agent as unknown as { current: Promise<TurnView> }).current;
      expect(agent.state).toEqual({ active: null, queued: null, stopRequested: false });
      releaseRead?.();
      const snapshot = await pendingSnapshot;
      expect(snapshot.turns.find((turn) => turn.turnId === queuedId)?.state).toBe("completed");
      expect(snapshot.queued).toBeNull();
      expect(fetchCalls).toBe(1);
    } finally { releaseRead?.(); h.db.close(); h.d1.close(); }
  });
});

describe("ChatAgent terminal D1 settlement", () => {
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-000000000040";
  const input: RunTurnInput = { projectId, chatId, turnId: id, question: "Preserve this completed answer.", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" };
  async function seeded(state: TurnView["state"] = "completed", active: string | null = id) {
    const h = makeHarness();
    await h.agent.onStart();
    const turn: TurnView = { turnId: id, question: input.question, model: "gateway:command-code/native-beam", answer: "Saved answer [S1:1].", state,
      scopeMode: "explicit", sourceIds: ["s1"], revisionIds: ["r1"], contextMode: "whole", citations: [{ revisionId: "r1", sourceId: "s1", block: 1, start: 0, end: 8, sourceTitle: "Paper", deleted: false, label: "[S1:1]" }],
      invalidLabels: 0, inputTokens: null, cachedTokens: null, outputTokens: 5, tokenLimit: TOKEN_BOUND, firstTokenMs: 12, totalMs: 45, error: null, settlementPending: true };
    h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,100)").run(id, JSON.stringify(turn));
    h.d1.prepare(`INSERT INTO chat_turn(chat_id,turn_id,model,scope_mode,scope_json,context_mode,state,input_tokens,cached_tokens,output_tokens,token_limit,citations,invalid_labels,first_token_ms,total_ms,error,created_at,estimated_cost_microusd)
      VALUES(?,?,?,?,?,?,'started',NULL,NULL,NULL,?,0,0,NULL,NULL,NULL,100,12345)`).run(chatId, id, turn.model, turn.scopeMode, JSON.stringify(turn.revisionIds), turn.contextMode ?? "none", TOKEN_BOUND);
    h.agent.setState({ active, queued: null, stopRequested: false });
    return { ...h, turn };
  }
  function noDispatch() {
    expect(requireAvailableModel).not.toHaveBeenCalled(); expect(admitTurn).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled(); expect(fetchCalls).toBe(0);
  }
  function terminalFault(h: ReturnType<typeof makeHarness>) {
    h.d1.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON chat_turn WHEN NEW.state<>'started' BEGIN SELECT RAISE(ABORT,'fixture D1 terminal write failure'); END");
  }
  function replay(h: ReturnType<typeof makeHarness>, state: WireAgentState) {
    const agent = new ChatAgent({ database: h.db } as unknown as ConstructorParameters<typeof ChatAgent>[0], h.env);
    agent.setState(structuredClone(state));
    return agent;
  }
  it("preserves a pending completed A and queued B in the same object, then settles without dispatching either again", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart(); terminalFault(h);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ai = h.env.AI as unknown as { fetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
      const fetch = ai.fetch.bind(ai);
      vi.spyOn(ai, "fetch").mockImplementationOnce(async (...args) => { await gate; return fetch(...args); });
      nextSSE = sse([chunk({ content: "Saved answer [S1:1]." }, "stop", { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 })]);
      await h.agent.submitTurn(input, false);
      const task = (h.agent as unknown as { current: Promise<TurnView> }).current;
      const bInput = { ...input, turnId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000041", question: "Never dispatch queued B." };
      expect(await h.agent.submitTurn(bInput, false)).toMatchObject({ queued: true });
      release(); const a = await task;
      expect(a).toMatchObject({ state: "completed", settlementPending: true, settlementError: expect.stringContaining("usage could not be confirmed"), inputTokens: 8, outputTokens: 5 });
      expect(h.agent.state).toEqual({ active: id, queued: null, stopRequested: false });
      expect(h.d1.prepare("SELECT state FROM chat_turn WHERE turn_id=?").get(id)).toEqual({ state: "started" });
      expect(h.d1.prepare("SELECT * FROM chat_turn WHERE turn_id=?").get(bInput.turnId)).toBeUndefined();
      const b = JSON.parse((h.db.prepare("SELECT payload FROM turns WHERE id=?").get(bInput.turnId) as { payload: string }).payload) as TurnView;
      expect(b).toMatchObject({ state: "failed", inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0 });
      expect(b.settlementPending).toBeUndefined();
      expect(fetchCalls).toBe(1); vi.clearAllMocks(); fetchCalls = 0;
      await h.agent.getSnapshot(projectId); noDispatch();
      h.d1.exec("DROP TRIGGER fail_settlement");
      const snapshot = await h.agent.getSnapshot(projectId);
      expect(snapshot.turns.find((turn) => turn.turnId === id)).toMatchObject({ state: "completed", inputTokens: 8, outputTokens: 5, answer: a.answer });
      expect(snapshot.turns.find((turn) => turn.turnId === id)?.settlementPending).toBeUndefined();
      expect(h.agent.state.active).toBeNull();
      expect(h.d1.prepare("SELECT state,input_tokens,output_tokens FROM chat_turn WHERE turn_id=?").get(id)).toEqual({ state: "completed", input_tokens: 8, output_tokens: 5 });
      expect(await h.agent.submitTurn(bInput, true)).toMatchObject({ ...b, input: bInput });
      const before = h.d1.prepare("SELECT * FROM chat_turn WHERE turn_id=?").get(id);
      await h.agent.getSnapshot(projectId); await h.agent.submitTurn(input, true);
      expect(h.d1.prepare("SELECT * FROM chat_turn WHERE turn_id=?").get(id)).toEqual(before);
      expect(() => h.d1.prepare("UPDATE chat_turn SET state=state WHERE turn_id=?").run(id)).toThrow("terminal_chat_turn_is_immutable");
      noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("replays a failed startup interruption across a second restart, retaining unknown usage and known D1 scope/bound", async () => {
    const h = await seeded("started");
    try {
      const behind = { ...h.turn, tokenLimit: null, revisionIds: [], contextMode: undefined, outputTokens: null, totalMs: null };
      h.db.prepare("UPDATE turns SET payload=? WHERE id=?").run(JSON.stringify(behind), id);
      terminalFault(h);
      const first = replay(h, h.agent.state); await first.onStart();
      expect(first.state.active).toBe(id);
      const interrupted = (await first.getTurns(projectId)).find((turn) => turn.turnId === id);
      expect(interrupted).toMatchObject({ state: "partial", answer: h.turn.answer, inputTokens: null, cachedTokens: null, outputTokens: null,
        tokenLimit: TOKEN_BOUND, revisionIds: ["r1"], contextMode: "whole", settlementPending: true });
      h.d1.exec("DROP TRIGGER fail_settlement");
      const second = replay(h, first.state); await second.onStart();
      const turn = (await second.getTurns(projectId)).find((item) => item.turnId === id);
      expect(turn).toMatchObject({ state: "partial", inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: TOKEN_BOUND });
      expect(turn?.settlementPending).toBeUndefined();
      expect(h.d1.prepare("SELECT state,input_tokens,cached_tokens,output_tokens,token_limit,scope_json,estimated_cost_microusd FROM chat_turn WHERE turn_id=?").get(id))
        .toEqual({ state: "partial", input_tokens: null, cached_tokens: null, output_tokens: null, token_limit: TOKEN_BOUND, scope_json: '["r1"]', estimated_cost_microusd: 12345 });
      expect(second.state.active).toBeNull(); noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it.each(["insert-before", "insert-after", "terminal-after"])("handles %s failure without a replacement execution or fabricated D1 row", async (fault) => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      if (fault === "insert-before") h.d1.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON chat_turn BEGIN SELECT RAISE(ABORT,'fixture insert unavailable'); END");
      else {
        const prepare = h.env.DB.prepare.bind(h.env.DB);
        let failed = false;
        vi.spyOn(h.env.DB, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          if (failed || !(fault === "insert-after" ? sql.startsWith("INSERT INTO chat_turn") : sql.startsWith("UPDATE chat_turn SET state="))) return statement;
          const bind = statement.bind.bind(statement);
          statement.bind = (...args) => {
            const bound = bind(...args), run = bound.run.bind(bound);
            bound.run = async <T = Record<string, unknown>>() => { const result = await run<T>(); if (!failed) { failed = true; throw new Error("fixture acknowledgement lost"); } return result; };
            return bound;
          };
          return statement;
        });
      }
      nextSSE = sse([chunk({ content: "Saved answer [S1:1]." }, "stop", { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 })]);
      const turn = requireTurn(await h.agent.submitTurn(input, true));
      expect(turn.settlementPending).toBeUndefined();
      expect(turn.settlementError).toBeUndefined();
      const row = h.d1.prepare("SELECT state,input_tokens,output_tokens,token_limit FROM chat_turn WHERE turn_id=?").get(id);
      if (fault === "insert-before") expect(row).toBeUndefined();
      else expect(row).toMatchObject(fault === "insert-after" ? { state: "failed", input_tokens: 0, output_tokens: 0, token_limit: 0 } : { state: "completed", input_tokens: 8, output_tokens: 5, token_limit: TOKEN_BOUND });
      expect(fetchCalls).toBe(fault === "terminal-after" ? 1 : 0);
      if (fault !== "terminal-after") expect(admitTurn).not.toHaveBeenCalled();
      vi.clearAllMocks(); fetchCalls = 0;
      await h.agent.getSnapshot(projectId); await h.agent.submitTurn(input, true); noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("finds a pending terminal result outside the latest 50 turns after active was cleared", async () => {
    const h = await seeded("completed", null);
    try {
      for (let n = 0; n < 51; n++) h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,?)").run("later-" + n, JSON.stringify({ ...h.turn, turnId: "later-" + n, settlementPending: undefined }), 200 + n);
      const snapshot = await h.agent.getSnapshot(projectId);
      expect(snapshot.turns).toHaveLength(50); expect(snapshot.turns.some((turn) => turn.turnId === id)).toBe(false);
      expect(h.d1.prepare("SELECT state,input_tokens,cached_tokens,output_tokens,estimated_cost_microusd FROM chat_turn WHERE turn_id=?").get(id))
        .toEqual({ state: "completed", input_tokens: null, cached_tokens: null, output_tokens: 5, estimated_cost_microusd: 12345 });
      expect(JSON.parse((h.db.prepare("SELECT payload FROM turns WHERE id=?").get(id) as { payload: string }).payload).settlementPending).toBeUndefined();
      noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("clears a pre-INSERT restart without fabricating an admission row or treating a read error as absence", async () => {
    const h = await seeded("started");
    try {
      h.d1.prepare("DELETE FROM chat_turn WHERE turn_id=?").run(id);
      h.db.prepare("UPDATE turns SET payload=? WHERE id=?").run(JSON.stringify({ ...h.turn, answer: "", revisionIds: [], citations: [],
        tokenLimit: null, inputTokens: null, cachedTokens: null, outputTokens: null, firstTokenMs: null, totalMs: null }), id);
      const prepare = h.env.DB.prepare.bind(h.env.DB);
      const failedRead = vi.spyOn(h.env.DB, "prepare").mockImplementation((sql) => {
        if (sql.includes("FROM chat_turn WHERE")) throw new Error("fixture read unavailable");
        return prepare(sql);
      });
      const agent = replay(h, h.agent.state); await agent.onStart();
      expect(agent.state.active).toBe(id);
      const pending = JSON.parse((h.db.prepare("SELECT payload FROM turns WHERE id=?").get(id) as { payload: string }).payload) as TurnView;
      expect(pending).toMatchObject({ settlementPending: true, tokenLimit: null, inputTokens: null });
      failedRead.mockRestore();
      const turn = (await agent.getTurns(projectId)).find((item) => item.turnId === id);
      expect(turn).toMatchObject({ state: "failed", tokenLimit: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
      expect(turn?.settlementPending).toBeUndefined(); expect(agent.state.active).toBeNull();
      expect(h.d1.prepare("SELECT * FROM chat_turn").all()).toEqual([]); noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("retains pending after a confirmed D1 commit if clearing the local marker fails", async () => {
    const h = await seeded();
    try {
      h.db.exec("CREATE TRIGGER fail_marker_clear BEFORE INSERT ON turns WHEN NEW.id='" + id + "' AND json_extract(NEW.payload,'$.settlementPending') IS NULL BEGIN SELECT RAISE(ABORT,'fixture DO clear failed'); END");
      const turn = (await h.agent.getTurns(projectId)).find((item) => item.turnId === id);
      expect(turn?.settlementPending).toBe(true);
      expect(h.d1.prepare("SELECT state FROM chat_turn WHERE turn_id=?").get(id)).toEqual({ state: "completed" });
      h.db.exec("DROP TRIGGER fail_marker_clear"); executedSql.length = 0;
      expect((await h.agent.getTurns(projectId)).find((item) => item.turnId === id)?.settlementPending).toBeUndefined();
      expect(executedSql.filter((sql) => sql.startsWith("UPDATE chat_turn"))).toEqual([]); noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it("limits recovery to eight indexed owning turns per read without requiring an active pointer", async () => {
    const h = await seeded("completed", null);
    try {
      for (let n = 1; n <= 8; n++) {
        const next = "pending-" + n;
        h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES(?,?,?)").run(next, JSON.stringify({ ...h.turn, turnId: next }), 100 + n);
        h.d1.prepare("INSERT INTO chat_turn SELECT chat_id,?,model,scope_mode,scope_json,context_mode,state,input_tokens,cached_tokens,output_tokens,token_limit,estimated_cost_microusd,citations,invalid_labels,first_token_ms,total_ms,error,created_at FROM chat_turn WHERE turn_id=?").run(next, id);
      }
      expect(h.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM turns WHERE json_extract(payload,'$.settlementPending')=1 ORDER BY created_at,id LIMIT 8").all())
        .toContainEqual(expect.objectContaining({ detail: expect.stringContaining("turns_pending_settlement") }));
      executedSql.length = 0; await h.agent.getTurns(projectId);
      expect(executedSql.filter((sql) => sql.startsWith("UPDATE chat_turn"))).toHaveLength(8);
      expect(h.db.prepare("SELECT count(*) AS n FROM turns WHERE json_extract(payload,'$.settlementPending')=1").get()).toEqual({ n: 1 });
      await h.agent.getTurns(projectId);
      expect(h.db.prepare("SELECT count(*) AS n FROM turns WHERE json_extract(payload,'$.settlementPending')=1").get()).toEqual({ n: 0 }); noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
  it.each([
    ["state", "partial"], ["model", "different-model"], ["scope_mode", "empty"], ["scope_json", '["other-revision"]'], ["context_mode", "claims"],
    ["input_tokens", 0], ["cached_tokens", 0], ["output_tokens", 6], ["token_limit", 999], ["citations", 2], ["invalid_labels", 1],
    ["first_token_ms", 13], ["total_ms", 46], ["error", "different-error"], ["matching", null],
  ])("compares terminal D1 %s exactly without issuing another UPDATE", async (column, value) => {
    const h = await seeded();
    try {
      h.d1.prepare("UPDATE chat_turn SET state='completed',citations=1,invalid_labels=0,first_token_ms=12,total_ms=45,output_tokens=5").run();
      // Direct fixture preparation before installing the real terminal trigger again.
      h.d1.exec("DROP TRIGGER chat_turn_terminal_immutable");
      if (column !== "matching") h.d1.prepare('UPDATE chat_turn SET ' + column + '=? WHERE turn_id=?').run(value, id);
      h.d1.exec("CREATE TRIGGER chat_turn_terminal_immutable BEFORE UPDATE ON chat_turn WHEN OLD.state IN ('completed','partial','failed','cancelled') BEGIN SELECT RAISE(ABORT,'terminal_chat_turn_is_immutable'); END");
      const before = h.d1.prepare("SELECT * FROM chat_turn WHERE turn_id=?").get(id);
      executedSql.length = 0;
      const turn = (await h.agent.getTurns(projectId)).find((item) => item.turnId === id);
      if (column === "matching") { expect(turn?.settlementPending).toBeUndefined(); expect(turn?.settlementError).toBeUndefined(); }
      else { expect(turn?.settlementPending).toBe(true); expect(turn?.settlementError).toContain("does not match"); }
      expect(executedSql.filter((sql) => sql.startsWith("UPDATE chat_turn"))).toEqual([]);
      await h.agent.getSnapshot(projectId);
      expect(h.d1.prepare("SELECT * FROM chat_turn WHERE turn_id=?").get(id)).toEqual(before); noDispatch();
    } finally { h.db.close(); h.d1.close(); }
  });
});

describe("chat-stream K2 wire regression", () => {
  it("streams explanatory multi-paragraph Markdown without sending a combined JSON schema", async () => {
    const projectInstructions = "For overview questions, explain the method's motivation and relevant background.";
    const h = makeHarness(
      "The paper describes a discriminator objective that learns from replaced tokens rather than only masked-token recovery.",
      projectInstructions,
    );
    try {
      await h.agent.onStart();
      const markdown = "The paper trains a discriminator to detect replaced tokens [S1:1].\n\n"
        + "This gives it a token-level learning signal rather than relying only on masked-token recovery [S1:1].";
      nextSSE = sse([
        chunk({ content: "The paper trains a discriminator to detect replaced tokens [S1:1].\n\n" }, null),
        chunk({ content: "This gives it a token-level learning signal rather than relying only on masked-token recovery [S1:1]." }, "stop",
          { prompt_tokens: 20, completion_tokens: 18, total_tokens: 38 }),
      ]);

      const turn = requireTurn(await h.agent.submitTurn({ projectId, chatId,
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000010", question: "Explain the method and why it helps.",
        scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));

      expect(turn).toMatchObject({ state: "completed", answer: markdown, invalidLabels: 0 });
      expect(turn.citations).toHaveLength(1);
      expect(fetchCalls).toBe(1);
      expect(turn.tokenLimit).toBe(TOKEN_BOUND);
      expect(turn.inputTokens).toBe(20);
      expect(turn.outputTokens).toBe(18);
      expect(vi.mocked(assertProviderAllowance)).not.toHaveBeenCalled();
      expect(vi.mocked(admitTurn)).toHaveBeenCalledTimes(1);
      expect(executedSql.some((s) => s.includes("token_limit"))).toBe(true);
      expect(executedSql.some((s) => s.includes("estimated_cost_microusd"))).toBe(false);
      const d1row = h.d1.prepare("SELECT token_limit AS tokenLimit, estimated_cost_microusd AS usd FROM chat_turn WHERE chat_id=? AND turn_id=?").get(chatId, "aaaaaaaa-aaaa-4aaa-8aaa-000000000010") as unknown as { tokenLimit: number; usd: number | null };
      expect(d1row.tokenLimit).toBe(TOKEN_BOUND);
      expect(d1row.usd).toBeNull();
      const contextInput = vi.mocked(buildContext).mock.calls.at(-1)?.[2];
      expect(contextInput?.instructions).toBe(projectInstructions);
      const body = sentBodies[0];
      if (!body) throw new Error("expected an outgoing chat request");
      expect(body).not.toHaveProperty("response_format");
      expect(JSON.stringify(body)).not.toContain("cited_answer");
      expect(JSON.stringify(body)).not.toContain("sentences");
      const system = body.messages?.filter((message) => message.role === "system");
      expect(system).toHaveLength(1);
      expect(system?.[0]?.content).toContain(projectInstructions);
      expect(system?.[0]?.content).not.toContain("Omit unasked background");
    } finally { h.db.close(); }
  });

  it.each([{ quote: "by A.B.C", warning: "unsupported-number" }, { quote: "score81.", warning: null }])(
    "keeps numeric coverage advisory without changing completed state: $quote",
    async ({ quote, warning }: { quote: string; warning: string | null }) => {
      const h = makeHarness(quote);
      try {
        await h.agent.onStart();
        nextSSE = sse([chunk({ content: "The result is 81 [S1:1]." }, "stop", { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
        const turn = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001", question: "Q", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
        expect(turn.state).toBe("completed");
        expect(turn.error).toBeNull();
        expect(turn.answer).toBe("The result is 81 [S1:1].");
        expect(turn.citations).toHaveLength(1);
        expect(turn.invalidLabels).toBe(0);
        if (warning) {
          expect(turn.warnings?.map((item) => item.kind)).toContain(warning);
          expect(turn.warnings?.length).toBeGreaterThan(0);
          for (const item of turn.warnings ?? []) {
            expect(item.start).toBeGreaterThanOrEqual(0);
            expect(item.end).toBeLessThanOrEqual(turn.answer.length);
            expect(item.end).toBeGreaterThan(item.start);
          }
        } else {
          expect(turn.warnings ?? []).toEqual([]);
        }
        expect(fetchCalls).toBe(1);
      } finally { h.db.close(); }
    },
  );
  it("uncited sentence settles completed with a missing-citation warning", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Supported fact [S1:1]. Uncited factual sentence." }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 })]);
      const t1 = "55555555-5555-4555-8555-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("completed");
      expect(r1.error).toBeNull();
      expect(r1.citations.length).toBe(1);
      expect(r1.invalidLabels).toBe(0);
      expect(r1.warnings?.map((item) => item.kind)).toContain("missing-citation");
      expect(r1.warnings?.length).toBeGreaterThan(0);
      for (const item of r1.warnings ?? []) {
        expect(item.start).toBeGreaterThanOrEqual(0);
        expect(item.end).toBeLessThanOrEqual(r1.answer.length);
        expect(item.end).toBeGreaterThan(item.start);
      }
      expect(r1.answer.slice(r1.warnings?.[0]?.start ?? 0, r1.warnings?.[0]?.end ?? 0).length).toBeGreaterThan(0);
      expect(fetchCalls).toBe(1);
      const saved = await h.agent.getStoredTurn(projectId, t1);
      expect(saved.answer).toContain("Supported fact [R");
      expect(saved.answer).toContain("Note:");
      expect(saved.answer).toContain("lack a verified adjacent citation");
      expect(saved.citations.length).toBe(1);
    } finally { h.db.close(); }
  });

  it("source-grounded output with no resolved citation stays partial without retry", async () => {
    const h = makeHarness("A source");
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "The source describes its method." }, "stop", { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 })]);
      const r = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: "99999999-9999-4999-8999-000000000001", question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r.state).toBe("partial");
      expect(r.error).toContain("No source citations were resolved");
      expect(r.answer).toBe("The source describes its method.");
      expect(r.citations).toHaveLength(0);
      expect(r.invalidLabels).toBe(0);
      expect(r.tokenLimit).toBe(TOKEN_BOUND);
      expect(fetchCalls).toBe(1);
    } finally { h.db.close(); }
  });

  it("interrupted text after partial content settles exact partial with no retry", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const bad = sse([chunk({ content: "Held [S1:1] " }, null), JSON.stringify({ error: { message: "mid-stream failure", type: "server_error" } })]);
      nextSSE = bad;
      const t1 = "66666666-6666-4666-8666-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("partial");
      expect(r1.answer).toBe("Held [S1:1] ");
      expect(r1.error).toBe("External model request failed. Check the Gateway connection and provider status; no retry was started.");
      expect(r1.tokenLimit).toBe(TOKEN_BOUND);
      expect(r1.inputTokens).toBeNull();
      expect(r1.cachedTokens).toBeNull();
      expect(r1.outputTokens).toBeNull();
      expect(fetchCalls).toBe(1);
      expect(sentBodies).toHaveLength(1);
    } finally { h.db.close(); }
  });

  it("clean SSE fixture still completes even though the terminal usage chunk carries no finish", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([
        chunk({ content: "Clean [S1:1]" }, "stop"),
        usageOnlyWithoutChoices({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }),
      ]);
      const t1 = "77777777-7777-4777-8777-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("completed");
      expect(r1.answer).toBe("Clean [S1:1]");
    } finally { h.db.close(); }
  });

  it("command-code second turn sends question plus frozen context without prior history", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "First [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000021";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("completed");
      sentBodies.length = 0;
      const callsBefore = fetchCalls;
      nextSSE = sse([chunk({ content: "Second [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000022";
      const r2 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r2.state).toBe("completed");
      expect(fetchCalls).toBe(callsBefore + 1);
      const body = sentBodies[0];
      if (!body) throw new Error("expected an outgoing CC body");
      const assistants = body.messages?.filter((m) => m.role === "assistant") ?? [];
      expect(assistants).toHaveLength(0);
      expect(JSON.stringify(body)).not.toContain("reasoning_content");
      expect(JSON.stringify(body)).not.toContain("reasoning_details");
      expect(JSON.stringify(body)).not.toContain("thought_signature");
      expect(body.messages?.some((m) => m.role === "user" && m.content === "Q2")).toBe(true);
    } finally { h.db.close(); }
  });

  it("command-code keeps no-history when catalogue base URL changes but frozen gateway slug stays", async () => {
    const models = await import("./models");
    const mocked = vi.mocked(models.requireAvailableModel);
    const prevImpl = mocked.getMockImplementation();
    if (!prevImpl) throw new Error("missing model mock");
    mocked.mockImplementation(async (env, route) => {
      const spec = await prevImpl(env, route);
      if (!spec.routing) return spec;
      return { ...spec, routing: { ...spec.routing, provider: { ...spec.routing.provider, baseUrl: "https://edited.example.invalid/custom" } } };
    });
    try {
      const h = makeHarness();
      try {
        await h.agent.onStart();
        nextSSE = sse([chunk({ content: "First [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
        const t1 = "cccccccc-cccc-4ccc-8ccc-000000000031";
        const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
        expect(r1.state).toBe("completed");
        sentBodies.length = 0;
        const callsBefore = fetchCalls;
        nextSSE = sse([chunk({ content: "Second [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
        const t2 = "cccccccc-cccc-4ccc-8ccc-000000000032";
        const r2 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
        expect(r2.state).toBe("completed");
        expect(fetchCalls).toBe(callsBefore + 1);
        const body = sentBodies[0];
        if (!body) throw new Error("expected an outgoing CC body");
        const assistants = body.messages?.filter((m) => m.role === "assistant") ?? [];
        expect(assistants).toHaveLength(0);
        expect(JSON.stringify(body)).not.toContain("reasoning_content");
        expect(JSON.stringify(body)).not.toContain("reasoning_details");
        expect(JSON.stringify(body)).not.toContain("thought_signature");
        expect(body.messages?.some((m) => m.role === "user" && m.content === "Q2")).toBe(true);
      } finally { h.db.close(); }
    } finally {
      if (prevImpl) mocked.mockImplementation(prevImpl);
    }
  });

  it("explicit Stop settles cancelled with the owner-stop message and keeps the held reservation", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const callsBefore = fetchCalls;
      (h.env.AI as unknown as { fetch: (url: unknown, init?: { signal?: AbortSignal }) => Promise<Response> }).fetch = (_url: unknown, init?: { signal?: AbortSignal }) => {
        fetchCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      };
      const turnId = "eeeeeeee-eeee-4eee-8eee-000000000001";
      const pending = h.agent.submitTurn({ projectId, chatId, turnId, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true) as Promise<TurnView>;
      for (let i = 0; i < 50 && fetchCalls === callsBefore; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(fetchCalls).toBeGreaterThan(callsBefore);
      await h.agent.stopTurn(projectId, turnId);
      const turn = requireTurn(await pending);
      expect(turn.state).toBe("cancelled");
      expect(turn.error).toBe("Stopped. A new Send starts a new turn.");
      expect(turn.tokenLimit).toBe(TOKEN_BOUND);
      expect(turn.inputTokens).toBeNull();
    } finally { h.db.close(); }
  });
  it("deadline abort without an owner Stop settles failed with a time-bound message and keeps the held reservation", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const callsBefore = fetchCalls;
      (h.env.AI as unknown as { fetch: (url: unknown, init?: { signal?: AbortSignal }) => Promise<Response> }).fetch = (_url: unknown, init?: { signal?: AbortSignal }) => {
        fetchCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      };
      const turnId = "dddddddd-dddd-4ddd-8ddd-000000000001";
      const pending = h.agent.submitTurn({ projectId, chatId, turnId, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true) as Promise<TurnView>;
      for (let i = 0; i < 50 && fetchCalls === callsBefore; i += 1) await vi.advanceTimersByTimeAsync(10);
      expect(fetchCalls).toBeGreaterThan(callsBefore);
      await vi.advanceTimersByTimeAsync(90_000);
      const turn = requireTurn(await pending);
      expect(turn.state).toBe("failed");
      expect(turn.error ?? "").toContain("time bound");
      expect(turn.error ?? "").not.toContain("Stopped.");
      expect(turn.tokenLimit).toBe(TOKEN_BOUND);
      expect(turn.inputTokens).toBeNull();
    } finally { h.db.close(); vi.useRealTimers(); }
  });
  it("truncated answer with an uncited sentence stays partial and keeps warnings", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Supported fact [S1:1]. Uncited factual sentence." }, "length", { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 })]);
      const t1 = "66666666-6666-4666-8666-000000000011";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("partial");
      expect(r1.error ?? "").toContain("stopped before a normal completion");
      expect(r1.citations.length).toBe(1);
      expect(r1.invalidLabels).toBe(0);
      expect(r1.warnings?.map((item) => item.kind)).toContain("missing-citation");
      expect(fetchCalls).toBe(1);
    } finally { h.db.close(); }
  });
  it("owner Stop just before the deadline keeps cancelled when the timer fires late", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const callsBefore = fetchCalls;
      (h.env.AI as unknown as { fetch: (url: unknown, init?: { signal?: AbortSignal }) => Promise<Response> }).fetch = (_url: unknown, init?: { signal?: AbortSignal }) => {
        fetchCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      };
      const turnId = "ffffffff-ffff-4fff-8fff-000000000001";
      const pending = h.agent.submitTurn({ projectId, chatId, turnId, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true) as Promise<TurnView>;
      for (let i = 0; i < 50 && fetchCalls === callsBefore; i += 1) await vi.advanceTimersByTimeAsync(10);
      expect(fetchCalls).toBeGreaterThan(callsBefore);
      await vi.advanceTimersByTimeAsync(89_000);
      await h.agent.stopTurn(projectId, turnId);
      await vi.advanceTimersByTimeAsync(5_000);
      const turn = requireTurn(await pending);
      expect(turn.state).toBe("cancelled");
      expect(turn.error).toBe("Stopped. A new Send starts a new turn.");
      expect(turn.error ?? "").not.toContain("time bound");
      expect(turn.tokenLimit).toBe(TOKEN_BOUND);
      expect(turn.inputTokens).toBeNull();
    } finally { h.db.close(); vi.useRealTimers(); }
  });
  it("first dispatch is idempotent with one model call and recorded token limit", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Held [S1:1]" }, "stop", { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-000000000099";
      const input = { projectId, chatId, turnId, question: "Q idem", scopeMode: "explicit" as const, sourceIds: ["s1"], model: "gateway:command-code/native-beam" };
      const first = requireTurn(await h.agent.submitTurn(input, true));
      expect(first.state).toBe("completed");
      expect(first.tokenLimit).toBe(TOKEN_BOUND);
      expect(fetchCalls).toBe(1);
      nextSSE = sse([chunk({ content: "Second should not dispatch [S1:1]" }, "stop", { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const second = requireTurn(await h.agent.submitTurn(input, true));
      expect(second.turnId).toBe(turnId);
      expect(second.answer).toBe(first.answer);
      expect(second.tokenLimit).toBe(TOKEN_BOUND);
      expect(fetchCalls).toBe(1);
      expect(executedSql.some((s) => s.includes("token_limit"))).toBe(true);
      const row = h.d1.prepare("SELECT token_limit AS tokenLimit FROM chat_turn WHERE chat_id=? AND turn_id=?").get(chatId, turnId) as unknown as { tokenLimit: number };
      expect(row.tokenLimit).toBe(TOKEN_BOUND);
    } finally { h.db.close(); h.d1.close(); }
  });
  it("non-command-code history includes prior turns while command-code stays question-only", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "First [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t1 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000021";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:openrouter/test-model" }, true));
      expect(r1.state).toBe("completed");
      expect(r1.tokenLimit).toBe(TOKEN_BOUND);
      sentBodies.length = 0;
      nextSSE = sse([chunk({ content: "Second [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t2 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000022";
      const r2 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:openrouter/test-model" }, true));
      expect(r2.state).toBe("completed");
      const body = sentBodies[0];
      if (!body) throw new Error("expected outgoing openrouter body");
      const texts = JSON.stringify(body);
      expect(texts).toContain("Q1");
      expect(texts).toContain("First [S1:1]");
      expect(r2.tokenLimit).toBe(TOKEN_BOUND);
      expect(fetchCalls).toBe(2);
    } finally { h.db.close(); h.d1.close(); }
  });
  it("undispatched oversized scope settles tokenLimit 0 with zeroed counts and no model call", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const huge = "x".repeat(1300000);
      const t1 = "cccccccc-cccc-4ccc-8ccc-000000000099";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: huge, scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("failed");
      expect(r1.tokenLimit).toBe(0);
      expect(r1.inputTokens).toBe(0);
      expect(r1.cachedTokens).toBe(0);
      expect(r1.outputTokens).toBe(0);
      expect(fetchCalls).toBe(0);
      const row = h.d1.prepare("SELECT token_limit AS tokenLimit FROM chat_turn WHERE chat_id=? AND turn_id=?").get(chatId, t1) as unknown as { tokenLimit: number };
      expect(row.tokenLimit).toBe(0);
    } finally { h.db.close(); h.d1.close(); }
  });
  it("admission failure settles tokenLimit 0 with known zero counts and no model call", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      vi.mocked(admitTurn).mockRejectedValueOnce(new LibraryError("budget", "Workers AI daily allowance is not configured. No model call was started.", 409));
      const t1 = "eeeeeeee-eeee-4eee-8eee-000000000099";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q blocked", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("failed");
      expect(r1.tokenLimit).toBe(0);
      expect(r1.inputTokens).toBe(0);
      expect(r1.cachedTokens).toBe(0);
      expect(r1.outputTokens).toBe(0);
      expect(r1.error ?? "").toMatch(/allowance|budget|configured/i);
      expect(fetchCalls).toBe(0);
      expect(vi.mocked(assertProviderAllowance)).not.toHaveBeenCalled();
      const row = h.d1.prepare("SELECT token_limit AS tokenLimit, input_tokens AS inputTokens, output_tokens AS outputTokens FROM chat_turn WHERE chat_id=? AND turn_id=?").get(chatId, t1) as unknown as { tokenLimit: number | null; inputTokens: number | null; outputTokens: number | null };
      expect(row.tokenLimit).toBe(0);
      expect(row.inputTokens).toBe(0);
      expect(row.outputTokens).toBe(0);
    } finally { h.db.close(); h.d1.close(); }
  });
  it("legacy stored turn normalizes tokenLimit null without dropping historical USD", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const legacyId = "dddddddd-dddd-4ddd-8ddd-000000000099";
      const legacy = { turnId: legacyId, question: "Q legacy", answer: "Old [S1:1]", state: "completed", model: "gateway:command-code/native-beam", scopeMode: "explicit", revisionIds: [], sourceIds: ["s1"], citations: [], invalidLabels: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 5, estimatedCostMicrousd: 123, firstTokenMs: 10, totalMs: 100, error: null };
      h.db.prepare("INSERT INTO turns(id,payload,created_at) VALUES (?,?,?)").run(legacyId, JSON.stringify(legacy), Date.now());
      const turns = await h.agent.getTurns(projectId);
      const found = turns.find((t) => t.turnId === legacyId);
      if (!found) throw new Error("legacy turn missing");
      expect(found.tokenLimit).toBeNull();
      expect((found as unknown as { estimatedCostMicrousd: number }).estimatedCostMicrousd).toBe(123);
      expect(found.inputTokens).toBe(10);
    } finally { h.db.close(); h.d1.close(); }
  });

  it("streams grouped citations to a normal completed turn with one AI call", async () => {
    const h = makeHarness("A source");
    try {
      await h.agent.onStart();
      const answer = "Both points hold [S1:1, S1:1].";
      nextSSE = sse([chunk({ content: answer }, "stop", { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 })]);
      const turn = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: "cccccccc-cccc-4ccc-8ccc-000000000010", question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(turn.state).toBe("completed");
      expect(turn.error).toBeNull();
      expect(turn.answer).toBe("Both points hold [S1:1][S1:1].");
      expect(turn.citations).toHaveLength(1);
      expect(turn.citations[0]).toMatchObject({ sourceId: "s1", block: 1, start: 0, end: 8 });
      expect(turn.invalidLabels).toBe(0);
      expect(fetchCalls).toBe(1);
      const saved = await h.agent.getStoredTurn(projectId, "cccccccc-cccc-4ccc-8ccc-000000000010");
      expect(saved.answer).toContain("[Rr1:1]");
      expect(saved.citations).toHaveLength(1);
      expect(saved.citations[0]).toMatchObject({ block: 1, start: 0, end: 8 });
    } finally { h.db.close(); h.d1.close(); }
  });

});

