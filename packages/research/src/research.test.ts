// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LEDGER_SCHEMA_SQL,
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  type CreateLedgerInput,
  type LedgerD1Database,
} from "./index.js";
import { LedgerError } from "./index.js";
import { defaultResearchWorkflowPlan } from "./index.js";

type AgnosticRow = Record<string, unknown>;
interface ShimStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
interface RawStatement {
  get(...args: never[]): unknown;
  all(...args: never[]): unknown[];
  run(...args: never[]): { changes?: unknown };
}
interface RawDatabase {
  prepare(sql: string): RawStatement;
  exec(sql: string): void;
}
function toChanges(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}
function spread(params: readonly unknown[]): never[] {
  return params as never[];
}
function makeD1(database: RawDatabase): LedgerD1Database & { raw: RawDatabase } {
  const prepare = (sql: string) => ({
    bind(...params: unknown[]): ShimStatement {
      return {
        sql,
        params,
        async first<T>() {
          const statement = database.prepare(sql);
          const row = (params.length === 0 ? statement.get() : statement.get(...spread(params))) as T | undefined;
          return (row ?? null) as T | null;
        },
        async all<T>() {
          const statement = database.prepare(sql);
          const rows = (params.length === 0 ? statement.all() : statement.all(...spread(params))) as unknown as T[];
          return { results: rows };
        },
        async run() {
          const statement = database.prepare(sql);
          const info = (params.length === 0 ? statement.run() : statement.run(...spread(params))) as unknown as { changes?: unknown };
          return { meta: { changes: toChanges(info.changes) } };
        },
      };
    },
  });
  const db = {
    raw: database,
    prepare,
    async batch(statements: readonly { sql: string; params: readonly unknown[] }[]) {
      database.exec("BEGIN");
      const out: { meta: { changes: number } }[] = [];
      try {
        for (const item of statements) {
          const statement = database.prepare(item.sql);
          const info = (item.params.length === 0 ? statement.run() : statement.run(...spread(item.params))) as unknown as { changes?: unknown };
          out.push({ meta: { changes: toChanges(info.changes) } });
        }
        database.exec("COMMIT");
        return out;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
    },
  } as unknown as LedgerD1Database & { raw: RawDatabase };
  return db;
}
function setup() {
  const raw = new DatabaseSync(":memory:");
  for (const sql of LEDGER_SCHEMA_SQL) raw.exec(sql);
  const d1 = makeD1(raw);
  const digests = new Map<string, string>();
  const handles = {
    async has(ref: string) { return digests.has(ref); },
    async digestFor(ref: string) { return digests.get(ref) ?? null; },
  };
  const fence = {
    principal_ref: "principal-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 1,
    policy_generation: "policy-gen-1", deployment_generation: "deploy-gen-1",
    purge_revision: 0, scope_purge_revision: 0,
  };
  const fences = { current: async () => ({ ...fence }) };
  const store = createD1InvestigationLedgerStore(d1);
  const service = createInvestigationLedgerService(store, fences, handles, () => "2026-09-05T00:00:00.000Z");
  return { raw, d1, digests, handles, fence, fences, store, service };
}
function baseInput(overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput {
  return {
    investigation_id: "inv-1", goal: "answer the question", scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1, evidence_grade: "E2", lane: "confirmatory",
    lane_registrations: ["lane-conf-1"], obligations: [{
      obligation_id: "obl-1", verifier_ref: "verifier-a", lane: "confirmatory",
      metric_ref: "metric-1", status: "REGISTERED", exposed: true,
    }],
    hypotheses: ["h-1"], portfolio_ref: "portfolio-1", debt_refs: ["debt-1"],
    principal_ref: "principal-1", input_digest: "a".repeat(64),
    policy_generation: "policy-gen-1", policy_authority_ref: "policy-auth-1",
    deployment_generation: "deploy-gen-1", idempotency_key: "idem-1",
    model_profile_ref: "model-1", event_id: "evt-1",
    payload_handle_ref: "payload-1", payload_digest: "b".repeat(64),
    created_at: "2026-09-05T00:00:00.000Z", ...overrides,
  };
}
function seedHandles(ctx: ReturnType<typeof setup>, input: CreateLedgerInput): void {
  ctx.digests.set(input.payload_handle_ref, input.payload_digest);
  ctx.digests.set(input.portfolio_ref, input.input_digest);
}
async function invariant(ctx: ReturnType<typeof setup>, id: string): Promise<void> {
  const head = ctx.raw.prepare("SELECT revision, event_head FROM investigation_ledger_head WHERE investigation_id=?").get(id) as unknown as { revision: number; event_head: number } | undefined;
  if (head === undefined) return;
  const count = ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?").get(id) as unknown as { n: number };
  expect(count.n).toBe(head.event_head);
  const rows = ctx.raw.prepare("SELECT sequence FROM investigation_ledger_event WHERE investigation_id=? ORDER BY sequence ASC").all(id) as unknown as { sequence: number }[];
  expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1));
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  throw new Error("expected LedgerError");
}

describe("research workflow", () => {
  it("freezes evidence before synthesis", () => {
    const stages = defaultResearchWorkflowPlan().stages;
    expect(stages.indexOf("FREEZE_EVIDENCE")).toBeLessThan(stages.indexOf("SYNTHESIZE"));
    expect(stages.at(-1)).toBe("MATERIALIZE");
  });
});

describe("investigation ledger over actual D1 rows", () => {
  it("1 creates and replays the same idempotency identity", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    const first = await ctx.service.create(input);
    expect(first.revision).toBe(1);
    const second = await ctx.service.create(input);
    expect(second).toEqual(first);
    const rows = ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number };
    const events = ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event").get() as unknown as { n: number };
    expect(rows.n).toBe(1);
    expect(events.n).toBe(1);
    await invariant(ctx, "inv-1");
  });
  it("2 conflicting replay creates no second effect", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const conflict = baseInput({ goal: "different goal" });
    ctx.digests.set(conflict.payload_handle_ref, conflict.payload_digest);
    expect(await codeOf(ctx.service.create(conflict))).toBe("LEDGER_CONFLICT");
    expect(ctx.raw.prepare("SELECT goal FROM investigation_ledger_head WHERE investigation_id=?").get("inv-1") as unknown as { goal: string }).toMatchObject({ goal: "answer the question" });
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event").get() as unknown as { n: number }).n).toBe(1);
    await invariant(ctx, "inv-1");
  });
  it("3 concurrent head updates elect one CAS winner", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-2", "c".repeat(64));
    ctx.digests.set("payload-3", "d".repeat(64));
    const left = ctx.service.checkpoint("inv-1", 1, 7, "principal-1", "evt-2", "payload-2", "c".repeat(64));
    const right = ctx.service.checkpoint("inv-1", 1, 8, "principal-1", "evt-3", "payload-3", "d".repeat(64));
    const outcomes = await Promise.allSettled([left, right]);
    const won = outcomes.filter((item) => item.status === "fulfilled");
    const lost = outcomes.filter((item) => item.status === "rejected");
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    expect((lost[0] as PromiseRejectedResult).reason.code).toMatch(/LEDGER_STALE_HEAD|LEDGER_CONFLICT/);
    const head = await ctx.service.read("inv-1");
    expect(head.revision).toBe(2);
    await invariant(ctx, "inv-1");
  });
  it("4 lost-ACK retry settles to one effect", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    let throws = true;
    const flaky = new Proxy(ctx.d1, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: readonly { sql: string; params: readonly unknown[] }[]) => {
            const result = await (target as unknown as { batch(stmts: unknown): Promise<unknown> }).batch(statements as never);
            if (throws) { throws = false; throw new Error("lost acknowledgement"); }
            return result;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LedgerD1Database;
    const flakyStore = createD1InvestigationLedgerStore(flaky);
    const flakyService = createInvestigationLedgerService(flakyStore, ctx.fences, ctx.handles, () => "2026-09-05T00:00:00.000Z");
    const firstAttempt = await flakyService.create(input).then((head) => ({ ok: true as const, head }), (error: unknown) => ({ ok: false as const, error }));
    expect(firstAttempt.ok === true || String(firstAttempt).includes("lost")).toBe(true);
    const retry = await ctx.service.create(input);
    expect(retry.revision).toBe(1);
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n).toBe(1);
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event").get() as unknown as { n: number }).n).toBe(1);
    await invariant(ctx, "inv-1");
  });
  it("5 close, reopen and restart reconstruct the same ledger from D1", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-close", "c".repeat(64));
    ctx.digests.set("payload-reopen", "d".repeat(64));
    await ctx.service.close("inv-1", 1, "principal-1", "evt-close", "payload-close", "c".repeat(64));
    expect((await ctx.service.read("inv-1")).status).toBe("CLOSED");
    const restarted = createInvestigationLedgerService(createD1InvestigationLedgerStore(ctx.d1), ctx.fences, ctx.handles, () => "2026-09-05T01:00:00.000Z");
    await restarted.reopen("inv-1", 2, "principal-1", "evt-reopen", "payload-reopen", "d".repeat(64));
    const head = await restarted.read("inv-1");
    expect(head.status).toBe("OPEN");
    expect(head.revision).toBe(3);
    expect(head.investigation_id).toBe("inv-1");
    expect(head.evidence_grade).toBe("E2");
    await invariant(ctx, "inv-1");
  });
  it("6 model swap and observed values never move required grade or authority", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-obs", "c".repeat(64));
    const before = await ctx.service.read("inv-1");
    await ctx.service.recordObserved("inv-1", 1, "exec-1", "fid-1", "ass-1", "principal-1", "evt-obs", "payload-obs", "c".repeat(64));
    const after = await ctx.service.read("inv-1");
    expect(after.evidence_grade).toBe(before.evidence_grade);
    expect(after.principal_ref).toBe(before.principal_ref);
    expect(after.input_digest).toBe(before.input_digest);
    expect(after.observed_execution).toBe("exec-1");
    const swapped = createInvestigationLedgerService(createD1InvestigationLedgerStore(ctx.d1), ctx.fences, ctx.handles, () => "2026-09-05T02:00:00.000Z");
    expect((await swapped.read("inv-1")).evidence_grade).toBe("E2");
    await invariant(ctx, "inv-1");
  });
  it("7 only the named verifier accepts and 8 wrong verifier leaves no mutation", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-ok", "c".repeat(64));
    ctx.digests.set("payload-bad", "d".repeat(64));
    expect(await codeOf(ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-evil", "metric-1", "principal-1", "evt-bad", "payload-bad", "d".repeat(64)))).toBe("LEDGER_VERIFIER_DENIED");
    expect((await ctx.service.read("inv-1")).revision).toBe(1);
    await ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-1", "principal-1", "evt-ok", "payload-ok", "c".repeat(64));
    expect((await ctx.service.read("inv-1")).obligations[0]?.status).toBe("ACCEPTED");
    await invariant(ctx, "inv-1");
  });
  it("9 changed confirmatory metric forces deviation, never silent confirmatory", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-changed", "c".repeat(64));
    ctx.digests.set("payload-dev", "d".repeat(64));
    expect(await codeOf(ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-2", "principal-1", "evt-changed", "payload-changed", "c".repeat(64)))).toBe("LEDGER_SUPERSESSION_REQUIRED");
    expect((await ctx.service.read("inv-1")).revision).toBe(1);
    await ctx.service.recordDeviation("inv-1", 1, "obl-1", "principal-1", "evt-dev", "payload-dev", "d".repeat(64), "metric moved after exposure");
    const head = await ctx.service.read("inv-1");
    expect(head.obligations[0]?.status).toBe("DEVIATED");
    expect(head.observed_execution).toBe("metric moved after exposure");
    const kinds = (ctx.raw.prepare("SELECT kind FROM investigation_ledger_event WHERE investigation_id=? ORDER BY sequence ASC").all("inv-1") as unknown as { kind: string }[]).map((row) => row.kind);
    expect(kinds).toEqual(["CREATED", "DEVIATION"]);
    await invariant(ctx, "inv-1");
  });
  it("10 persists actual D1 rows with readback and rejects silent protocol rewrite", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const headRow = ctx.raw.prepare("SELECT investigation_id, revision, evidence_grade, principal_ref, input_digest, policy_generation, deployment_generation, idempotency_key FROM investigation_ledger_head WHERE investigation_id=?").get("inv-1") as unknown as AgnosticRow;
    expect(headRow).toMatchObject({ investigation_id: "inv-1", revision: 1, evidence_grade: "E2", principal_ref: "principal-1", input_digest: "a".repeat(64), policy_generation: "policy-gen-1", deployment_generation: "deploy-gen-1", idempotency_key: "idem-1" });
    const eventRow = ctx.raw.prepare("SELECT investigation_id, sequence, event_id, kind FROM investigation_ledger_event WHERE investigation_id=?").get("inv-1") as unknown as AgnosticRow;
    expect(eventRow).toMatchObject({ investigation_id: "inv-1", sequence: 1, event_id: "evt-1", kind: "CREATED" });
    const snapshot = await ctx.store.read("inv-1");
    expect(snapshot?.head.investigation_id).toBe("inv-1");
    ctx.digests.set("payload-direct", "e".repeat(64));
    const current = (await ctx.service.read("inv-1"));
    await expect(ctx.store.append({ ...current, revision: 2, event_head: 2, evidence_grade: "E3", updated_at: "2026-09-05T01:00:00.000Z" }, 1, {
      investigation_id: "inv-1", sequence: 2, event_id: "evt-direct", kind: "OBSERVED",
      payload_handle_ref: "payload-direct", payload_digest: "e".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: "2026-09-05T01:00:00.000Z",
    })).rejects.toMatchObject({ code: "LEDGER_SUPERSESSION_REQUIRED" });
    expect(ctx.raw.prepare("SELECT evidence_grade FROM investigation_ledger_head WHERE investigation_id=?").get("inv-1") as unknown as { evidence_grade: string }).toMatchObject({ evidence_grade: "E2" });
    await invariant(ctx, "inv-1");
  });
  it("negatives fence principal, scope, policy, deployment and purge without effects", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    expect(await codeOf(ctx.service.create({ ...input, principal_ref: "principal-evil" }))).toBe("LEDGER_PRINCIPAL_DENIED");
    expect(await codeOf(ctx.service.create({ ...input, scope_snapshot_id: "scope-foreign" }))).toBe("LEDGER_SCOPE_FOREIGN");
    expect(await codeOf(ctx.service.create({ ...input, policy_generation: "policy-stale" }))).toBe("LEDGER_POLICY_STALE");
    expect(await codeOf(ctx.service.create({ ...input, deployment_generation: "deploy-stale" }))).toBe("LEDGER_DEPLOYMENT_STALE");
    ctx.fence.purge_revision = 2;
    expect(await codeOf(ctx.service.create(input))).toBe("LEDGER_PURGE_STALE");
    ctx.fence.purge_revision = 0;
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n).toBe(0);
  });
  it("negatives reject unknown fields, malformed digests, duplicates, bounds, stale checkpoints and bad handles", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await expect(ctx.store.create({ ...(input as unknown as Record<string, unknown>), surprise: 1 } as never, {
      investigation_id: "inv-1", sequence: 1, event_id: "evt-1", kind: "CREATED",
      payload_handle_ref: "payload-1", payload_digest: "b".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: "2026-09-05T00:00:00.000Z",
    })).rejects.toThrow();
    expect(await codeOf(ctx.service.create({ ...input, input_digest: "not-hex" }))).toBe("LEDGER_INPUT_INVALID");
    expect(await codeOf(ctx.service.create({ ...input, scope_snapshot_revision: 0 as unknown as number }))).toBe("LEDGER_INPUT_INVALID");
    const dup = baseInput({ investigation_id: "inv-dup", idempotency_key: "idem-dup", event_id: "evt-dup", obligations: [
      { obligation_id: "same", verifier_ref: "v", lane: "confirmatory", metric_ref: "m", status: "REGISTERED", exposed: false },
      { obligation_id: "same", verifier_ref: "v", lane: "confirmatory", metric_ref: "m", status: "REGISTERED", exposed: false },
    ] });
    ctx.digests.set("payload-1", "b".repeat(64));
    ctx.digests.set("portfolio-1", "a".repeat(64));
    expect(await codeOf(ctx.service.create(dup))).toBe("LEDGER_CONFLICT");
    expect(await codeOf(ctx.service.create({ ...input, goal: "g".repeat(2001) }))).toBe("LEDGER_INPUT_INVALID");
    await ctx.service.create(input);
    expect(await codeOf(ctx.service.create({ ...input, investigation_id: "inv-2", goal: "g".repeat(2001) }))).toBe("LEDGER_INPUT_INVALID");
    const maxed = baseInput({ investigation_id: "inv-max", idempotency_key: "idem-max", event_id: "evt-max", lane_registrations: Array.from({ length: 16 }, (_, i) => `lane-${i}`) });
    ctx.digests.set("payload-1", "b".repeat(64));
    await ctx.service.create(maxed);
    const over = baseInput({ investigation_id: "inv-over", idempotency_key: "idem-over", event_id: "evt-over", lane_registrations: Array.from({ length: 17 }, (_, i) => `lane-${i}`) });
    expect(await codeOf(ctx.service.create(over))).toBe("LEDGER_INPUT_INVALID");
    ctx.digests.set("payload-stale", "c".repeat(64));
    expect(await codeOf(ctx.service.checkpoint("inv-1", 99, 1, "principal-1", "evt-stale", "payload-stale", "c".repeat(64)))).toBe("LEDGER_STALE_HEAD");
    expect(await codeOf(ctx.service.checkpoint("inv-1", 1, 1, "principal-1", "evt-miss", "missing-handle", "c".repeat(64)))).toBe("LEDGER_HANDLE_MISSING");
    ctx.digests.set("payload-mismatch", "c".repeat(64));
    expect(await codeOf(ctx.service.checkpoint("inv-1", 1, 1, "principal-1", "evt-mismatch", "payload-mismatch", "d".repeat(64)))).toBe("LEDGER_HANDLE_MISSING");
    const dupEvent = baseInput({ investigation_id: "inv-dup-event", idempotency_key: "idem-dup-event", event_id: "evt-1" });
    ctx.digests.set("payload-1", "b".repeat(64));
    expect(await codeOf(ctx.service.create(dupEvent))).toBe("LEDGER_CONFLICT");
    await invariant(ctx, "inv-1");
    await invariant(ctx, "inv-max");
  });
});
