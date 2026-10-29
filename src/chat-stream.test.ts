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
import { buildContext } from "./context";
import { admitTurn } from "./cost";
import { assertProviderAllowance } from "./model-quota";
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
  d1.exec("CREATE TABLE chat(id TEXT PRIMARY KEY,project_id TEXT NOT NULL)");
  d1.prepare("INSERT INTO chat VALUES ('wire-chat',?)").run(projectId);
  d1.exec("CREATE TABLE chat_turn(chat_id TEXT, turn_id TEXT, model TEXT, scope_mode TEXT, scope_json TEXT, context_mode TEXT, state TEXT, input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER, token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0), estimated_cost_microusd INTEGER, citations INTEGER, invalid_labels INTEGER, first_token_ms INTEGER, total_ms INTEGER, error TEXT, created_at INTEGER, PRIMARY KEY(chat_id, turn_id))");
  const env = {
    DB: {
      prepare(sql: string) {
        executedSql.push(sql);
        if (sql.includes("chat_turn") || sql.includes("UPDATE chat SET")) {
          return {
            first: async (): Promise<unknown> => null,
            bind: (...args: SQLInputValue[]) => ({
              first: async (): Promise<unknown> => {
                try {
                  const stmt = d1.prepare(sql);
                  return stmt.columns().length ? (stmt.get(...args) as unknown) : null;
                } catch { return null; }
              },
              run: async () => {
                try {
                  const info = d1.prepare(sql).run(...args);
                  return { meta: { changes: Number(info.changes) } };
                } catch { return { meta: { changes: 1 } }; }
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
});

