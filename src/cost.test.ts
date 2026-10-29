import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { admitDistill, admitTurn, failUndispatchedDistill } from "./cost.js";
import { LibraryError } from "./library.js";
import { assertProviderAllowance } from "./model-quota.js";
import type * as ModelQuota from "./model-quota.js";
import type { ModelSpec } from "./models.js";

// Provider allowance is mocked: the real model-quota module currently holds
// a closed native placeholder, so admission tests pin allow/deny directly
// instead of depending on registry or provider state.
vi.mock("./model-quota", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelQuota>();
  return { ...actual, assertProviderAllowance: vi.fn() };
});
const allowance = vi.mocked(assertProviderAllowance);

const FLASH_ROUTE = "workers-ai:@cf/zai-org/glm-5.3-flash";
function flashModel(): ModelSpec {
  return {
    route: FLASH_ROUTE,
    id: "@cf/zai-org/glm-5.3-flash",
    label: "GLM 5.3 Flash",
    contextTokens: 1048576,
    maxOutputTokens: null,
    outputReserveTokens: 8192,
    checkedOn: "2026-10-27",
    enabled: true,
  };
}
const FLASH_BOUND = 1048576 + 8192;
const ALLOWANCE_CLOSED = new LibraryError("budget", "Workers AI daily allowance is not configured. No model call was started.", 409);

const CHAT_DDL = "CREATE TABLE chat_turn (" +
  "chat_id TEXT NOT NULL, turn_id TEXT NOT NULL," +
  " state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started','completed','partial','failed','cancelled'))," +
  " token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0)," +
  " input_tokens INTEGER, cached_tokens INTEGER, output_tokens INTEGER," +
  " created_at INTEGER NOT NULL, PRIMARY KEY (chat_id, turn_id))";
const DISTILL_DDL = "CREATE TABLE source_revision (" +
  "id TEXT PRIMARY KEY," +
  " distill_state TEXT NOT NULL DEFAULT 'none' CHECK (distill_state IN ('none','queued','running','paused','done','partial','failed'))," +
  " distill_model TEXT, distill_started_at INTEGER," +
  " distill_token_limit INTEGER CHECK (distill_token_limit IS NULL OR distill_token_limit >= 0)," +
  " distill_error TEXT," +
  " distill_calls INTEGER NOT NULL DEFAULT 0 CHECK (distill_calls BETWEEN 0 AND 2)," +
  " distill_input_tokens INTEGER, distill_cached_tokens INTEGER, distill_output_tokens INTEGER," +
  " distill_estimated_cost_microusd INTEGER CHECK (distill_estimated_cost_microusd IS NULL OR distill_estimated_cost_microusd >= 0)," +
  " distill_ms INTEGER)";

// Minimal D1-shaped shim over real SQLite: the helpers under test only use
// prepare/bind/run/first. The env deliberately exposes no BUCKET, so any R2
// report write before the distill CAS would throw here.
function testEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(CHAT_DDL);
  db.exec(DISTILL_DDL);
  const shim = {
    prepare(sql: string) {
      return {
        bind(...params: Array<string | number | null>) {
          return {
            run() {
              return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
            },
            first() {
              return (db.prepare(sql).get(...params) as Record<string, unknown> | undefined) ?? null;
            },
          };
        },
      };
    },
  };
  return { db, env: { DB: shim } as unknown as Env };
}
function chatRow(db: DatabaseSync, chatId: string, turnId: string) {
  return db.prepare("SELECT state, token_limit AS tokenLimit FROM chat_turn WHERE chat_id = ? AND turn_id = ?").get(chatId, turnId) as { state: string; tokenLimit: number | null };
}
function distillRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT distill_state AS state, distill_error AS error, distill_calls AS calls," +
    " distill_model AS model, distill_started_at AS startedAt, distill_token_limit AS tokenLimit," +
    " distill_input_tokens AS inputTokens, distill_cached_tokens AS cachedTokens," +
    " distill_output_tokens AS outputTokens, distill_estimated_cost_microusd AS legacyCost," +
    " distill_ms AS ms FROM source_revision WHERE id = ?").get(id) as Record<string, unknown>;
}

beforeEach(() => {
  allowance.mockReset();
  allowance.mockResolvedValue(undefined);
});

describe("admitTurn", () => {
  it("reserves the context+output bound on a started turn and returns it", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO chat_turn (chat_id, turn_id, state, created_at) VALUES (?, ?, 'started', ?)").run("c1", "t1", Date.now());
    const bound = await admitTurn(fixed.env, "c1", "t1", flashModel());
    expect(bound).toBe(FLASH_BOUND);
    expect(allowance).toHaveBeenCalledOnce();
    expect(chatRow(fixed.db, "c1", "t1")).toEqual({ state: "started", tokenLimit: FLASH_BOUND });
  });
  it("throws a safe error and writes nothing when provider allowance is closed", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO chat_turn (chat_id, turn_id, state, created_at) VALUES (?, ?, 'started', ?)").run("c1", "t1", Date.now());
    allowance.mockRejectedValue(ALLOWANCE_CLOSED);
    await expect(admitTurn(fixed.env, "c1", "t1", flashModel())).rejects.toMatchObject({ code: "budget", status: 409 });
    expect(chatRow(fixed.db, "c1", "t1").tokenLimit).toBeNull();
  });
  it("throws without writing when the model has no usable limits", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO chat_turn (chat_id, turn_id, state, created_at) VALUES (?, ?, 'started', ?)").run("c1", "t1", Date.now());
    const broken = { ...flashModel(), contextTokens: null } as unknown as ModelSpec;
    await expect(admitTurn(fixed.env, "c1", "t1", broken)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(allowance).not.toHaveBeenCalled();
    expect(chatRow(fixed.db, "c1", "t1").tokenLimit).toBeNull();
  });
  it("admits a turn exactly once; a repeat or terminal row throws", async () => {
    const fixed = testEnv();
    const created = Date.now();
    fixed.db.prepare("INSERT INTO chat_turn (chat_id, turn_id, state, created_at) VALUES (?, ?, 'started', ?)").run("c1", "t1", created);
    fixed.db.prepare("INSERT INTO chat_turn (chat_id, turn_id, state, created_at) VALUES (?, ?, 'completed', ?)").run("c1", "t-done", created);
    await admitTurn(fixed.env, "c1", "t1", flashModel());
    await expect(admitTurn(fixed.env, "c1", "t1", flashModel())).rejects.toMatchObject({ code: "conflict" });
    await expect(admitTurn(fixed.env, "c1", "t-done", flashModel())).rejects.toMatchObject({ code: "conflict" });
    await expect(admitTurn(fixed.env, "c1", "missing", flashModel())).rejects.toMatchObject({ code: "conflict" });
    expect(chatRow(fixed.db, "c1", "t1").tokenLimit).toBe(FLASH_BOUND);
  });
});

describe("admitDistill", () => {
  it("runs an explicitly queued revision with twice the bound", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'queued')").run("r1");
    const before = Date.now();
    await expect(admitDistill(fixed.env, "r1", flashModel())).resolves.toBe(true);
    const row = distillRow(fixed.db, "r1");
    expect(row.state).toBe("running");
    expect(row.model).toBe(FLASH_ROUTE);
    expect(row.tokenLimit).toBe(2 * FLASH_BOUND);
    expect(row.error).toBeNull();
    expect(Number(row.startedAt)).toBeGreaterThanOrEqual(before);
  });
  it("holds a third revision queued while two are already running", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'running')").run("r1");
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'running')").run("r2");
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'queued')").run("r3");
    await expect(admitDistill(fixed.env, "r3", flashModel())).resolves.toBe(false);
    const row = distillRow(fixed.db, "r3");
    expect(row.state).toBe("queued");
    expect(row.tokenLimit).toBeNull();
  });
  it("pauses with a safe error and no token limit when provider allowance is closed", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'queued')").run("r1");
    allowance.mockRejectedValue(ALLOWANCE_CLOSED);
    await expect(admitDistill(fixed.env, "r1", flashModel())).resolves.toBe(false);
    const row = distillRow(fixed.db, "r1");
    expect(row.state).toBe("paused");
    expect(row.error).toBe(ALLOWANCE_CLOSED.message);
    expect(row.tokenLimit).toBeNull();
  });
  it("pauses with a safe error when the model has no usable limits", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'queued')").run("r1");
    const broken = { ...flashModel(), contextTokens: null } as unknown as ModelSpec;
    await expect(admitDistill(fixed.env, "r1", broken)).resolves.toBe(false);
    const row = distillRow(fixed.db, "r1");
    expect(row.state).toBe("paused");
    expect(row.tokenLimit).toBeNull();
  });
  it("leaves non-queued rows alone", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state) VALUES (?, 'done')").run("r-done");
    await expect(admitDistill(fixed.env, "r-done", flashModel())).resolves.toBe(false);
    await expect(admitDistill(fixed.env, "missing", flashModel())).resolves.toBe(false);
    expect(distillRow(fixed.db, "r-done").state).toBe("done");
  });
});

describe("failUndispatchedDistill", () => {
  it("releases a stuck undispatched slot with zeroed token usage and keeps legacy cost", async () => {
    const fixed = testEnv();
    const started = Date.now() - 5000;
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state, distill_calls, distill_started_at," +
      " distill_input_tokens, distill_cached_tokens, distill_output_tokens," +
      " distill_token_limit, distill_estimated_cost_microusd, distill_ms)" +
      " VALUES (?, 'running', 0, ?, 100, 5, 8000, 2113536, 322766, NULL)").run("r1", started);
    await expect(failUndispatchedDistill(fixed.env, "r1", "create failed")).resolves.toBe(true);
    const row = distillRow(fixed.db, "r1");
    expect(row.state).toBe("failed");
    expect(row.error).toBe("create failed");
    expect(row.calls).toBe(0);
    expect(row.tokenLimit).toBe(0);
    expect(row.inputTokens).toBe(0);
    expect(row.cachedTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
    expect(row.legacyCost).toBe(322766);
    expect(Number(row.ms)).toBeGreaterThanOrEqual(0);
    expect(Number(row.ms)).toBeLessThanOrEqual(Date.now() - started);
  });
  it("keeps the reservation when a paid call already dispatched", async () => {
    const fixed = testEnv();
    const started = Date.now() - 9000;
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state, distill_error, distill_calls, distill_started_at," +
      " distill_input_tokens, distill_cached_tokens, distill_output_tokens," +
      " distill_token_limit, distill_estimated_cost_microusd, distill_ms)" +
      " VALUES (?, 'running', 'queued note', 1, ?, 100, 5, 8000, 2113536, 322766, 123)").run("r1", started);
    await expect(failUndispatchedDistill(fixed.env, "r1", "create failed")).resolves.toBe(false);
    const row = distillRow(fixed.db, "r1");
    expect(row.state).toBe("running");
    expect(row.error).toBe("queued note");
    expect(row.calls).toBe(1);
    expect(row.tokenLimit).toBe(2113536);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(8000);
    expect(row.legacyCost).toBe(322766);
    expect(row.ms).toBe(123);
  });
  it("returns false for terminal or missing rows without touching them", async () => {
    const fixed = testEnv();
    fixed.db.prepare("INSERT INTO source_revision (id, distill_state, distill_calls, distill_token_limit, distill_estimated_cost_microusd) VALUES (?, 'done', 2, 2113536, 4444)").run("r9");
    await expect(failUndispatchedDistill(fixed.env, "r9", "create failed")).resolves.toBe(false);
    await expect(failUndispatchedDistill(fixed.env, "no-such-row", "create failed")).resolves.toBe(false);
    const row = distillRow(fixed.db, "r9");
    expect(row.state).toBe("done");
    expect(row.calls).toBe(2);
    expect(row.tokenLimit).toBe(2113536);
    expect(row.legacyCost).toBe(4444);
  });
});
