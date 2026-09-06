// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1InvestigationLedgerStore, createInvestigationLedgerService,
  type CreateLedgerInput, type LedgerD1Database, type LedgerEvent, type LedgerHead,
} from "./index.js";
import { LedgerError } from "./index.js";
import { defaultResearchWorkflowPlan } from "./index.js";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; query: string; import: string }): Record<string, string>;
  }
}

// Committed Core migration stream is the only schema authority; no in-test DDL.
const CORE_MIGRATIONS = import.meta.glob("../../../infra/d1/core/migrations/*.sql", { eager: true, query: "?raw", import: "default" });

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
function spread(params: readonly unknown[]): never[] { return params as never[]; }
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
  for (const key of Object.keys(CORE_MIGRATIONS).sort()) raw.exec(CORE_MIGRATIONS[key] as string);
  raw.exec("INSERT OR IGNORE INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES ('policy-gen-1','policy-auth-1','ACTIVE','2026-09-05T00:00:00.000Z'); INSERT OR IGNORE INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES ('deploy-gen-1','ACTIVE','2026-09-05T00:00:00.000Z');");
  raw.exec(`INSERT OR IGNORE INTO scope_snapshot (snapshot_id, revision, resolved_scope_expression_json, participant_generations_json, member_source_revision_refs_json, source_owner_generations_json, policy_authority_ref, disclosure_closure_digest, purge_ledger_revision, snapshot_digest, created_at, expires_at, invalidated_at) VALUES ('scope-1',1,'{}','{}','[]','{}','policy-auth-1','${"c".repeat(64)}',0,'${"d".repeat(64)}','2026-09-05T00:00:00.000Z','2030-01-01T00:00:00.000Z',NULL); INSERT OR IGNORE INTO scope_access_grant (snapshot_id, snapshot_revision, principal_ref, client_class, credential_generation, policy_authority_ref, allowed_use_json, disclosure_ceiling, authorization_receipt_ref, state, expires_at, created_at) VALUES ('scope-1',1,'principal-1','owner_pwa','cred-1','policy-auth-1','[]','exact','authz-scope-1-principal-1','ACTIVE','2030-01-01T00:00:00.000Z','2026-09-05T00:00:00.000Z');`);
  const d1 = makeD1(raw);
  const digests = new Map<string, string>();
  const handles = {
    async has(ref: string) { return digests.has(ref); },
    async digestFor(ref: string) { return digests.get(ref) ?? null; },
  };
  const fence = {
    principal_ref: "principal-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 1,
    policy_generation: "policy-gen-1", policy_authority_ref: "policy-auth-1", deployment_generation: "deploy-gen-1",
    purge_revision: 0, scope_purge_revision: 0,
  };
  const fences = { current: async () => ({ ...fence }) };
  const store = createD1InvestigationLedgerStore(d1);
  const service = createInvestigationLedgerService(store, fences, handles, () => new Date().toISOString());
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
    created_at: new Date().toISOString(), ...overrides,
  };
}
function nextInput(tag: string, overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput { return baseInput({ investigation_id: `inv-${tag}`, idempotency_key: `idem-${tag}`, event_id: `evt-${tag}`, ...overrides }); }
function seedHandles(ctx: ReturnType<typeof setup>, input: CreateLedgerInput): void { ctx.digests.set(input.payload_handle_ref, input.payload_digest); ctx.digests.set(input.portfolio_ref, input.input_digest); }
async function invariant(ctx: ReturnType<typeof setup>, id: string): Promise<void> {
  const head = ctx.raw.prepare("SELECT revision, event_head FROM investigation_ledger_head WHERE investigation_id=?").get(id) as unknown as { revision: number; event_head: number } | undefined;
  if (head === undefined) return;
  const rows = ctx.raw.prepare("SELECT sequence FROM investigation_ledger_event WHERE investigation_id=? ORDER BY sequence ASC").all(id) as unknown as { sequence: number }[];
  expect(rows.length).toBe(head.event_head);
  expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1));
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  throw new Error("expected LedgerError");
}
function eventCount(ctx: ReturnType<typeof setup>, id: string): number { return (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?").get(id) as unknown as { n: number }).n; }
function headCount(ctx: ReturnType<typeof setup>): number { return (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n; }

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
  it("2b same key with different initial event bytes is a conflict with no effect", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const sameHead = baseInput({ event_id: "evt-other" });
    ctx.digests.set(sameHead.payload_handle_ref, sameHead.payload_digest);
    expect(await codeOf(ctx.service.create(sameHead))).toBe("LEDGER_CONFLICT");
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n).toBe(1);
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event").get() as unknown as { n: number }).n).toBe(1);
    expect(ctx.raw.prepare("SELECT event_id FROM investigation_ledger_event WHERE investigation_id=?").get("inv-1") as unknown as { event_id: string }).toMatchObject({ event_id: "evt-1" });
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
    expect((lost[0] as PromiseRejectedResult).reason.code).toMatch(/LEDGER_(STALE_HEAD|CONFLICT)/);
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
    const flakyService = createInvestigationLedgerService(flakyStore, ctx.fences, ctx.handles, () => new Date().toISOString());
    const firstAttempt = await flakyService.create(input).then((head) => ({ ok: true as const, head }), (error: unknown) => ({ ok: false as const, error }));
    expect(firstAttempt.ok === true || String(firstAttempt).includes("lost")).toBe(true);
    const retry = await ctx.service.create(input);
    expect(retry.revision).toBe(1);
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n).toBe(1);
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event").get() as unknown as { n: number }).n).toBe(1);
    await invariant(ctx, "inv-1");
  });
  it("4b atomic append: crash before, lost ACK after, and stale CAS rollback leave old-complete or new-complete", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-crash", "c".repeat(64));
    ctx.digests.set("payload-ack", "d".repeat(64));
    // Crash before the atomic batch commits: the effect must be entirely absent.
    const preCrash = new Proxy(ctx.d1, {
      get(target, key) {
        if (key === "batch") return async () => { throw new Error("crash before commit"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LedgerD1Database;
    const preStore = createD1InvestigationLedgerStore(preCrash);
    const preService = createInvestigationLedgerService(preStore, ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(await codeOf(preService.checkpoint("inv-1", 1, 4, "principal-1", "evt-crash", "payload-crash", "c".repeat(64)))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect((await ctx.service.read("inv-1")).revision).toBe(1);
    expect(ctx.raw.prepare("SELECT * FROM investigation_ledger_event WHERE event_id=?").get("evt-crash")).toBeUndefined();
    // Lost ACK after the atomic batch committed: a retry reconciles to the single effect.
    let ackLost = true;
    const ackFlaky = new Proxy(ctx.d1, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: readonly { sql: string; params: readonly unknown[] }[]) => {
            const result = await (target as unknown as { batch(stmts: unknown): Promise<unknown> }).batch(statements as never);
            if (ackLost) { ackLost = false; throw new Error("lost acknowledgement"); }
            return result;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LedgerD1Database;
    const ackService = createInvestigationLedgerService(createD1InvestigationLedgerStore(ackFlaky), ctx.fences, ctx.handles, () => new Date().toISOString());
    await ackService.checkpoint("inv-1", 1, 5, "principal-1", "evt-ack", "payload-ack", "d".repeat(64)).catch(() => undefined);
    const reconciled = await ctx.service.checkpoint("inv-1", 1, 5, "principal-1", "evt-ack", "payload-ack", "d".repeat(64)).catch(async () => ctx.service.read("inv-1"));
    expect(reconciled.revision).toBe(2);
    expect(eventCount(ctx, "inv-1")).toBe(2);
    // Stale CAS from a second store rolls back the whole effect: no orphan event row.
    ctx.digests.set("payload-stale", "e".repeat(64));
    const other = createInvestigationLedgerService(createD1InvestigationLedgerStore(ctx.d1), ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(await codeOf(other.checkpoint("inv-1", 1, 6, "principal-1", "evt-stale", "payload-stale", "e".repeat(64)))).toBe("LEDGER_STALE_HEAD");
    expect(ctx.raw.prepare("SELECT * FROM investigation_ledger_event WHERE event_id=?").get("evt-stale")).toBeUndefined();
    expect((await ctx.service.read("inv-1")).revision).toBe(2);
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
    const restarted = createInvestigationLedgerService(createD1InvestigationLedgerStore(ctx.d1), ctx.fences, ctx.handles, () => new Date().toISOString());
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
    const swapped = createInvestigationLedgerService(createD1InvestigationLedgerStore(ctx.d1), ctx.fences, ctx.handles, () => new Date().toISOString());
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
    ctx.digests.set("payload-fake", "e".repeat(64));
    expect(await codeOf(ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-evil", "metric-1", "verifier-evil", "evt-bad", "payload-bad", "d".repeat(64)))).toBe("LEDGER_VERIFIER_DENIED");
    expect(await codeOf(ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-1", "principal-1", "evt-fake", "payload-fake", "e".repeat(64)))).toBe("LEDGER_VERIFIER_DENIED");
    expect((await ctx.service.read("inv-1")).revision).toBe(1);
    expect(eventCount(ctx, "inv-1")).toBe(1);
    await ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-1", "verifier-a", "evt-ok", "payload-ok", "c".repeat(64));
    expect((await ctx.service.read("inv-1")).obligations[0]?.status).toBe("ACCEPTED");
    await invariant(ctx, "inv-1");
  });
  it("8b deviated obligations never silently return to accepted; explicit supersession carries lineage", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-dev", "c".repeat(64));
    ctx.digests.set("payload-reaccept", "d".repeat(64));
    await ctx.service.recordDeviation("inv-1", 1, "obl-1", "principal-1", "evt-dev", "payload-dev", "c".repeat(64), "metric moved after exposure");
    expect((await ctx.service.read("inv-1")).obligations[0]?.status).toBe("DEVIATED");
    expect(await codeOf(ctx.service.acceptObligation("inv-1", 2, "obl-1", "verifier-a", "metric-1", "verifier-a", "evt-reaccept", "payload-reaccept", "d".repeat(64)))).toBe("LEDGER_SUPERSESSION_REQUIRED");
    expect((await ctx.service.read("inv-1")).obligations[0]?.status).toBe("DEVIATED");
    expect((await ctx.service.read("inv-1")).revision).toBe(2);
    const replacement = nextInput("2");
    seedHandles(ctx, replacement);
    const superseded = await ctx.service.supersede("inv-1", 2, replacement, "post-exposure metric change", "principal-1");
    expect(superseded.investigation_id).toBe("inv-2");
    expect(superseded.supersedes_id).toBe("inv-1");
    expect(superseded.status).toBe("OPEN");
    const oldHead = await ctx.service.read("inv-1");
    expect(oldHead.status).toBe("SUPERSEDED");
    expect(oldHead.supersession_reason).toBe("post-exposure metric change");
    expect(oldHead.obligations[0]?.status).toBe("DEVIATED");
    const kinds = (ctx.raw.prepare("SELECT kind FROM investigation_ledger_event WHERE investigation_id=? ORDER BY sequence ASC").all("inv-1") as unknown as { kind: string }[]).map((row) => row.kind);
    expect(kinds).toEqual(["CREATED", "DEVIATION", "SUPERSEDED"]);
    await invariant(ctx, "inv-1");
    await invariant(ctx, "inv-2");
  });
  it("8c atomic supersession fault injection never leaves a superseded head without its replacement", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const replacement = nextInput("2");
    seedHandles(ctx, replacement);
    let armed = true;
    const faulty = new Proxy(ctx.d1, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: readonly { sql: string; params: readonly unknown[] }[]) => {
            if (armed && statements.length === 1) { armed = false; throw new Error("crash inside supersession command"); }
            return (target as unknown as { batch(stmts: unknown): Promise<unknown> }).batch(statements as never);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LedgerD1Database;
    const faultyService = createInvestigationLedgerService(createD1InvestigationLedgerStore(faulty), ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(await codeOf(faultyService.supersede("inv-1", 1, replacement, "fault injection", "principal-1"))).toMatch(/LEDGER_SETTLEMENT_UNCERTAIN|LEDGER_CONFLICT/);
    expect((await ctx.service.read("inv-1")).status).toBe("OPEN");
    expect(ctx.raw.prepare("SELECT * FROM investigation_ledger_head WHERE investigation_id=?").get("inv-2")).toBeUndefined();
    const settled = await ctx.service.supersede("inv-1", 1, replacement, "fault injection", "principal-1");
    expect(settled.supersedes_id).toBe("inv-1");
    expect((await ctx.service.read("inv-1")).status).toBe("SUPERSEDED");
    await invariant(ctx, "inv-1");
    await invariant(ctx, "inv-2");
  });
  it("9 changed confirmatory metric forces deviation, never silent confirmatory", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-changed", "c".repeat(64));
    ctx.digests.set("payload-dev", "d".repeat(64));
    expect(await codeOf(ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-2", "verifier-a", "evt-changed", "payload-changed", "c".repeat(64)))).toBe("LEDGER_SUPERSESSION_REQUIRED");
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
  it("fences deny every mutation for wrong principal, foreign scope, stale policy, stale deployment, purge and foreign actor", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const H = "c".repeat(64);
    ctx.digests.set("payload-m", H);
    const pristine = { ...ctx.fence };
    const dims = [
      { code: "LEDGER_PRINCIPAL_DENIED", apply: () => { ctx.fence.principal_ref = "principal-evil"; } },
      { code: "LEDGER_SCOPE_FOREIGN", apply: () => { ctx.fence.scope_snapshot_id = "scope-foreign"; } }, { code: "LEDGER_SCOPE_FOREIGN", apply: () => { ctx.fence.scope_snapshot_revision = 999; } },
      { code: "LEDGER_POLICY_STALE", apply: () => { ctx.fence.policy_generation = "policy-stale"; } }, { code: "LEDGER_POLICY_STALE", apply: () => { ctx.fence.policy_authority_ref = "policy-auth-evil"; } },
      { code: "LEDGER_DEPLOYMENT_STALE", apply: () => { ctx.fence.deployment_generation = "deploy-stale"; } }, { code: "LEDGER_PURGE_STALE", apply: () => { ctx.fence.purge_revision = 2; } },
    ];
    let tag = 0;
    const next = () => `evt-fence-${(tag += 1)}`;
    const openMutations: { name: string; run: () => Promise<unknown>; actorCode: string }[] = [
      { name: "checkpoint", run: () => ctx.service.checkpoint("inv-1", 1, 3, "principal-1", next(), "payload-m", H), actorCode: "LEDGER_PRINCIPAL_DENIED" },
      { name: "accept", run: () => ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-1", "verifier-a", next(), "payload-m", H), actorCode: "LEDGER_VERIFIER_DENIED" },
      { name: "deviation", run: () => ctx.service.recordDeviation("inv-1", 1, "obl-1", "principal-1", next(), "payload-m", H, "note"), actorCode: "LEDGER_PRINCIPAL_DENIED" },
      { name: "observed", run: () => ctx.service.recordObserved("inv-1", 1, "x", "y", "z", "principal-1", next(), "payload-m", H), actorCode: "LEDGER_PRINCIPAL_DENIED" },
      { name: "close", run: () => ctx.service.close("inv-1", 1, "principal-1", next(), "payload-m", H), actorCode: "LEDGER_PRINCIPAL_DENIED" },
    ];
    for (const mutation of openMutations) {
      for (const dim of dims) {
        Object.assign(ctx.fence, pristine);
        dim.apply();
        await expect(mutation.run(), `${mutation.name}/${dim.code}`).rejects.toMatchObject({ code: dim.code });
        expect((await ctx.service.read("inv-1")).revision).toBe(1);
        expect(eventCount(ctx, "inv-1")).toBe(1);
      }
      Object.assign(ctx.fence, pristine);
      const foreign = mutation.name === "accept"
        ? ctx.service.acceptObligation("inv-1", 1, "obl-1", "verifier-a", "metric-1", "actor-foreign", next(), "payload-m", H)
        : mutation.name === "checkpoint" ? ctx.service.checkpoint("inv-1", 1, 3, "actor-foreign", next(), "payload-m", H)
          : mutation.name === "deviation" ? ctx.service.recordDeviation("inv-1", 1, "obl-1", "actor-foreign", next(), "payload-m", H, "note")
            : mutation.name === "observed" ? ctx.service.recordObserved("inv-1", 1, "x", "y", "z", "actor-foreign", next(), "payload-m", H)
              : ctx.service.close("inv-1", 1, "actor-foreign", next(), "payload-m", H);
      await expect(foreign, `${mutation.name}/foreign-actor`).rejects.toMatchObject({ code: mutation.actorCode });
      expect((await ctx.service.read("inv-1")).revision).toBe(1);
      expect(eventCount(ctx, "inv-1")).toBe(1);
    }
    await ctx.service.close("inv-1", 1, "principal-1", "evt-fence-close", "payload-m", H);
    expect((await ctx.service.read("inv-1")).status).toBe("CLOSED");
    for (const dim of dims) {
      Object.assign(ctx.fence, pristine);
      dim.apply();
      await expect(ctx.service.reopen("inv-1", 2, "principal-1", next(), "payload-m", H), `reopen/${dim.code}`).rejects.toMatchObject({ code: dim.code });
      expect((await ctx.service.read("inv-1")).status).toBe("CLOSED");
    }
    Object.assign(ctx.fence, pristine);
    await expect(ctx.service.reopen("inv-1", 2, "actor-foreign", next(), "payload-m", H)).rejects.toMatchObject({ code: "LEDGER_PRINCIPAL_DENIED" });
    await ctx.service.reopen("inv-1", 2, "principal-1", "evt-fence-reopen", "payload-m", H);
    expect((await ctx.service.read("inv-1")).status).toBe("OPEN");
    for (const dim of dims) {
      Object.assign(ctx.fence, pristine);
      dim.apply();
      const candidate = nextInput(`fence-${tag}`);
      seedHandles(ctx, candidate);
      await expect(ctx.service.supersede("inv-1", 3, candidate, "fenced", "principal-1"), `supersede/${dim.code}`).rejects.toMatchObject({ code: dim.code });
      expect(ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).toMatchObject({ n: 1 });
    }
    Object.assign(ctx.fence, pristine);
    const foreignNew = nextInput("fence-foreign");
    seedHandles(ctx, foreignNew);
    await expect(ctx.service.supersede("inv-1", 3, foreignNew, "fenced", "actor-foreign")).rejects.toMatchObject({ code: "LEDGER_PRINCIPAL_DENIED" });
    await invariant(ctx, "inv-1");
  });
  it("portfolio verification fails closed on missing, mismatch, malformed and backend errors", async () => {
    const ctx = setup();
    const missing = baseInput({ investigation_id: "inv-missing", idempotency_key: "idem-missing", event_id: "evt-missing" });
    ctx.digests.set(missing.payload_handle_ref, missing.payload_digest);
    expect(await codeOf(ctx.service.create(missing))).toBe("LEDGER_HANDLE_MISSING");
    const mismatch = baseInput({ investigation_id: "inv-mismatch", idempotency_key: "idem-mismatch", event_id: "evt-mismatch" });
    ctx.digests.set(mismatch.payload_handle_ref, mismatch.payload_digest);
    ctx.digests.set(mismatch.portfolio_ref, "f".repeat(64));
    expect(await codeOf(ctx.service.create(mismatch))).toBe("LEDGER_HANDLE_MISSING");
    const malformed = baseInput({ investigation_id: "inv-malformed", idempotency_key: "idem-malformed", event_id: "evt-malformed", input_digest: "not-hex" });
    ctx.digests.set(malformed.payload_handle_ref, malformed.payload_digest);
    expect(await codeOf(ctx.service.create(malformed))).toBe("LEDGER_INPUT_INVALID");
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n).toBe(0);
    const backendDown = { has: async () => { throw new Error("backend down"); }, digestFor: async () => null as unknown as string | null };
    const downService = createInvestigationLedgerService(ctx.store, ctx.fences, backendDown, () => new Date().toISOString());
    const input = baseInput();
    seedHandles(ctx, input);
    expect(await codeOf(downService.create(input))).toBe("LEDGER_HANDLE_MISSING");
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n).toBe(0);
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
  it("11 same event id with any divergent byte conflicts; exact supersession replay settles to one effect", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-div", "c".repeat(64));
    const snap = await ctx.store.read("inv-1");
    if (snap === null) throw new Error("missing ledger");
    expect(snap.head.revision).toBe(1);
    const badHead: LedgerHead = { ...snap.head, revision: 2, event_head: 2, updated_at: "2026-09-05T01:00:00.000Z" };
    const badEvent: LedgerEvent = { investigation_id: "inv-1", sequence: 2, event_id: "evt-1", kind: "OBSERVED", payload_handle_ref: "payload-div", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: "2026-09-05T01:00:00.000Z" };
    expect(await codeOf(ctx.store.append(badHead, 1, badEvent))).toBe("LEDGER_CONFLICT");
    expect(eventCount(ctx, "inv-1")).toBe(1);
    expect((await ctx.service.read("inv-1")).revision).toBe(1);
    const replacement = nextInput("2");
    seedHandles(ctx, replacement);
    const settled = await ctx.service.supersede("inv-1", 1, replacement, "post-exposure metric change", "principal-1");
    expect(settled.supersedes_id).toBe("inv-1");
    const replayed = await ctx.service.supersede("inv-1", 1, replacement, "post-exposure metric change", "principal-1");
    expect(replayed).toEqual(settled);
    expect(headCount(ctx)).toBe(2);
    expect(await codeOf(ctx.service.supersede("inv-1", 1, replacement, "a different reason", "principal-1"))).toBe("LEDGER_CONFLICT");
    expect(headCount(ctx)).toBe(2);
    expect(eventCount(ctx, "inv-1")).toBe(2);
    expect(eventCount(ctx, "inv-2")).toBe(1);
    await invariant(ctx, "inv-1");
    await invariant(ctx, "inv-2");
  });
});
