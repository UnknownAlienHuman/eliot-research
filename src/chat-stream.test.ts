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
interface WireStoredMessage { content: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown }
interface WireStoredRow { payload: string }

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
    id: "native-beam-id",
    label: "Beam",
    contextTokens: 1048576,
    maxOutputTokens: 8192,
    inputMicrousdPerMillion: 150000,
    cachedMicrousdPerMillion: 30000,
    outputMicrousdPerMillion: 500000,
    checkedOn: "2026-10-26",
    enabled: true,
    responseFormat: false,
    structuredOutputs: false,
  };
  return {
    ...actual,
    DEFAULT_MODEL: "gateway:command-code/native-beam",
    requireAvailableModel: vi.fn(async (_env: unknown, route: string) => {
      if (route === "gateway:command-code/native-beam") return { ...base, route };
      if (route === "gateway:command-code/other-beam") return { ...base, id: "other-beam-id", route };
      throw new Error("unexpected model " + route);
    }),
    getModelConnection: vi.fn(async () => ({ gatewayId: "test-gw", provider: "ai-gateway", alias: "default" })),
  };
});

vi.mock("./cost", async (importOriginal) => {
  const actual = await importOriginal<typeof CostModule>();
  return {
    ...actual,
    admitTurn: vi.fn(async () => 123),
    estimateCost: vi.fn(() => 7),
  };
});

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

type SubmitResult = Awaited<ReturnType<ChatAgent["submitTurn"]>>;

const projectId = "wire-project";
const chatId = "wire-chat";
const WIRE_MSG = "This history has no complete original protocol state for the selected model. Start a new chat; no model call was made.";
const CAPTURE_MSG = "The original assistant protocol state could not be preserved. Start a new chat; no retry was started.";

const sentBodies: WireSentBody[] = [];
let fetchCalls = 0;
let nextSSE: string | null = null;

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

function makeHarness() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE chat(id TEXT PRIMARY KEY,project_id TEXT NOT NULL)");
  db.prepare("INSERT INTO chat VALUES ('wire-chat',?)").run(projectId);
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (..._args: SQLInputValue[]) => ({
            first: async (): Promise<unknown> => {
              if (sql.includes("FROM chat WHERE id=")) return { project_id: projectId };
              if (sql.includes("COALESCE(p.answer_model")) return { model: "gateway:command-code/native-beam", instructions: "" };
              if (sql.includes("model_gateway_id")) return { gatewayId: "test-gw" };
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
    BUCKET: {},
  } as unknown as Env;
  const agent = new ChatAgent({ database: db } as unknown as ConstructorParameters<typeof ChatAgent>[0], env);
  return { agent, db, env };
}

function requireTurn(value: SubmitResult): TurnView {
  if (!("state" in value)) throw new Error("expected a completed turn result");
  return value;
}
function replayedAssistant(body: WireSentBody): WireSentMessage {
  const found = body.messages?.find((m) => m.role === "assistant");
  if (!found) throw new Error("expected a replayed assistant message");
  return found;
}
function storedWire(db: DatabaseSync, turnId: string): { modelId: unknown; message: WireStoredMessage } {
  const row = db.prepare("SELECT payload FROM assistant_wire WHERE turn_id=?").get(turnId) as WireStoredRow | undefined;
  if (!row) throw new Error("expected a stored wire row");
  return JSON.parse(row.payload) as { modelId: unknown; message: WireStoredMessage };
}

beforeEach(() => {
  sentBodies.length = 0;
  fetchCalls = 0;
  nextSSE = null;
  vi.clearAllMocks();
});

describe("chat-stream K2 wire regression", () => {
  it("marks selected partial history without changing its original protocol message", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Unfinished result [S1:1]", reasoning: "Original reasoning" }, "length",
        { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const first = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
      const prior = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: first, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(prior.state).toBe("partial");
      const original = storedWire(h.db, first).message;
      nextSSE = sse([chunk({ content: "New answer [S1:1]" }, "stop", { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const next = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002", question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(next.state).toBe("completed");
      const body = sentBodies.at(-1);
      if (!body) throw new Error("Missing second request");
      expect(replayedAssistant(body)).toMatchObject(original);
      expect(body.messages?.some((message) => message.role === "system" && typeof message.content === "string"
        && message.content.includes("An earlier assistant answer was partial"))).toBe(true);
      const input = vi.mocked(buildContext).mock.calls.at(-1)?.[2];
      expect(input?.instructions).toContain("An earlier assistant answer was partial");
      expect(fetchCalls).toBe(2);
    } finally { h.db.close(); }
  });
  it("captures fragmented reasoning/content then reloads same DB for exact replay without leaks", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([
        chunk({ role: "assistant", reasoning_content: "think-" }, null),
        chunk({ reasoning_content: "ing deep" }, null),
        chunk({ content: "Held " }, null),
        chunk({ content: "result [S1:1]" }, null),
        usageOnly({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      ]);
      const t1 = "11111111-1111-4111-8111-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("completed");
      expect(r1.answer).toContain("[S1:1]");
      expect(r1.estimatedCostMicrousd).toBe(7);
      const stored = storedWire(h.db, t1);
      expect(stored.modelId).toBe("native-beam-id");
      expect(stored.message.content).toBe("Held result [S1:1]");
      expect(stored.message.reasoning_content).toBe("think-ing deep");
      const snap = await h.agent.getSnapshot(projectId);
      expect(JSON.stringify(snap)).not.toContain("think-ing deep");
      expect(JSON.stringify(r1)).not.toContain("reasoning_content");
      expect(JSON.stringify(r1)).not.toContain("reasoning_details");
      for (const call of vi.mocked(h.agent.broadcast).mock.calls) expect(JSON.stringify(call)).not.toContain("think-ing deep");
      const saved = await h.agent.getStoredTurn(projectId, t1);
      expect(JSON.stringify(saved)).not.toContain("think-ing deep");
      const agent2 = new ChatAgent({ database: h.db } as unknown as ConstructorParameters<typeof ChatAgent>[0], h.env);
      await agent2.onStart();
      sentBodies.length = 0;
      const callsBefore = fetchCalls;
      nextSSE = sse([chunk({ content: "Second [S1:1]" }, null), usageOnly({ prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })]);
      const t2 = "11111111-1111-4111-8111-000000000002";
      const r2 = requireTurn(await agent2.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r2.state).toBe("completed");
      expect(fetchCalls).toBe(callsBefore + 1);
      const last = sentBodies.at(-1);
      if (!last) throw new Error("expected an outgoing CC body");
      const replayed = replayedAssistant(last);
      expect(replayed.content).toBe("Held result [S1:1]");
      expect(replayed.reasoning_content).toBe("think-ing deep");
    } finally { h.db.close(); }
  });

  it("plain non-reasoning history sends no marker across two turns", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Plain [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t1 = "22222222-2222-4222-8222-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("completed");
      const stored = storedWire(h.db, t1);
      expect(stored.message).toEqual({ content: "Plain [S1:1]" });
      sentBodies.length = 0;
      nextSSE = sse([chunk({ content: "Again [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t2 = "22222222-2222-4222-8222-000000000002";
      const r2 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r2.state).toBe("completed");
      const first = sentBodies[0];
      if (!first) throw new Error("expected an outgoing CC body");
      expect(replayedAssistant(first)).toEqual({ role: "assistant", content: "Plain [S1:1]" });
    } finally { h.db.close(); }
  });

  it("changed model fails before dispatch while its matching wire row is present", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "First [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t1 = "33333333-3333-4333-8333-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("completed");
      const storedBefore = storedWire(h.db, t1);
      expect(storedBefore.modelId).toBe("native-beam-id");
      sentBodies.length = 0;
      const callsBefore = fetchCalls;
      nextSSE = sse([chunk({ content: "never" }, null)]);
      const t2 = "33333333-3333-4333-8333-000000000002";
      const r2 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/other-beam" }, true));
      expect(r2.state).toBe("failed");
      expect(r2.error).toBe(WIRE_MSG);
      expect(r2.estimatedCostMicrousd).toBe(0);
      expect(r2.inputTokens).toBe(0);
      expect(r2.outputTokens).toBe(0);
      expect(fetchCalls).toBe(callsBefore);
      expect(sentBodies.length).toBe(0);
      const kept = storedWire(h.db, t1);
      expect(kept.message.content).toBe("First [S1:1]");
    } finally { h.db.close(); }
  });

  it("legacy missing wire row fails before dispatch and settles its reservation", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Legacy [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const t1 = "44444444-4444-4444-8444-000000000001";
      const first = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(first.state).toBe("completed");
      expect(storedWire(h.db, t1).modelId).toBe("native-beam-id");
      h.db.prepare("DELETE FROM assistant_wire WHERE turn_id=?").run(t1);
      sentBodies.length = 0;
      const callsBefore = fetchCalls;
      const t2 = "44444444-4444-4444-8444-000000000002";
      const missing = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t2, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(missing.state).toBe("failed");
      expect(missing.error).toBe(WIRE_MSG);
      expect(missing.estimatedCostMicrousd).toBe(0);
      expect(missing.inputTokens).toBe(0);
      expect(missing.outputTokens).toBe(0);
      expect(fetchCalls).toBe(callsBefore);
      expect(sentBodies.length).toBe(0);
    } finally { h.db.close(); }
  });

  it("partially cited answer settles partial with invalidLabels 0", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Supported fact [S1:1]. Uncited factual sentence." }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 })]);
      const t1 = "55555555-5555-4555-8555-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("partial");
      expect(r1.error ?? "").toContain("adjacent verified source reference");
      expect(r1.citations.length).toBe(1);
      expect(r1.invalidLabels).toBe(0);
      expect(fetchCalls).toBe(1);
    } finally { h.db.close(); }
  });

  it("interrupted text after partial content settles exact partial with no retry and no wire row", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      const bad = sse([chunk({ content: "Held [S1:1] " }, null), JSON.stringify({ error: { message: "mid-stream failure", type: "server_error" } })]);
      nextSSE = bad;
      const t1 = "66666666-6666-4666-8666-000000000001";
      const r1 = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: t1, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(r1.state).toBe("partial");
      expect(r1.answer).toBe("Held [S1:1] ");
      expect(r1.error).toBe("External model request failed (cause: AI_StreamProviderError:server_error). Check the Gateway connection and provider status; no retry was started.");
      expect(r1.estimatedCostMicrousd).toBe(123);
      expect(r1.inputTokens).toBeNull();
      expect(r1.cachedTokens).toBeNull();
      expect(r1.outputTokens).toBeNull();
      expect(fetchCalls).toBe(1);
      expect(sentBodies).toHaveLength(1);
      expect(h.db.prepare("SELECT payload FROM assistant_wire WHERE turn_id=?").get(t1)).toBeUndefined();
    } finally { h.db.close(); }
  });

  it("demotes a complete answer when private wire capture cannot be persisted", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      h.db.exec("CREATE TRIGGER reject_assistant_wire BEFORE INSERT ON assistant_wire BEGIN SELECT RAISE(ABORT, 'private capture unavailable'); END");
      nextSSE = sse([chunk({ content: "Complete [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const turnId = "99999999-9999-4999-8999-000000000001";
      const turn = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(turn.state).toBe("partial");
      expect(turn.answer).toBe("Complete [S1:1]");
      expect(turn.error).toBe(CAPTURE_MSG);
      expect(turn.estimatedCostMicrousd).toBe(7);
      expect(fetchCalls).toBe(1);
      expect(sentBodies).toHaveLength(1);
      expect(h.db.prepare("SELECT payload FROM assistant_wire WHERE turn_id=?").get(turnId)).toBeUndefined();
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
      expect(storedWire(h.db, t1).message).toEqual({ content: "Clean [S1:1]" });
    } finally { h.db.close(); }
  });

  it("keeps buildContext turnId identity inside the selected assistant message", async () => {
    const h = makeHarness();
    try {
      await h.agent.onStart();
      nextSSE = sse([chunk({ content: "Second [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const first = "88888888-8888-4888-8888-000000000001";
      const firstTurn = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: first, question: "Q1", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(firstTurn.state).toBe("completed");
      vi.mocked(buildContext).mockClear();
      nextSSE = sse([chunk({ content: "Again [S1:1]" }, null), usageOnly({ prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 })]);
      const second = "88888888-8888-4888-8888-000000000002";
      const secondTurn = requireTurn(await h.agent.submitTurn({ projectId, chatId, turnId: second, question: "Q2", scopeMode: "explicit", sourceIds: ["s1"], model: "gateway:command-code/native-beam" }, true));
      expect(secondTurn.state).toBe("completed");
      const seen = vi.mocked(buildContext).mock.calls[0]?.[2];
      if (!seen) throw new Error("expected buildContext input");
      const assistants = (seen.history ?? []).filter((turn) => turn.role === "assistant");
      expect(assistants.length).toBe(1);
      expect(assistants[0]?.turnId).toBe(first);
    } finally { h.db.close(); }
  });
});

