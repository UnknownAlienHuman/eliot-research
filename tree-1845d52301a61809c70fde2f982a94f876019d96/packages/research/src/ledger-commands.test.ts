// ER-08/ER-13 FIX4: atomic single-statement ledger command closure over committed migrations.
// Proves the Luna rejects stay closed: no resumable guard phase, no head delete, D1-time
// bounds, no error-swallowing authority side effects, full-byte binding, exact replay.
import {
  COMMAND_COLUMNS, COMMAND_SQL, buildAppendCommand,
  hasCommittedCommand, ledgerCommandIdFor, readCommandFence,
  type LedgerCommandDatabase, type LedgerCommandReader,
} from "./index.js";
// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1InvestigationLedgerStore, createInvestigationLedgerService,
  type CreateLedgerInput, type LedgerD1Database, type LedgerEvent, type LedgerHead,
} from "./index.js";
import { LedgerError } from "./index.js";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; query: string; import: string }): Record<string, string>;
  }
}

// Committed Core migration stream is the only schema authority; no in-test DDL.
const CORE_MIGRATIONS = import.meta.glob("../../../infra/d1/core/migrations/*.sql", { eager: true, query: "?raw", import: "default" });

interface ShimStatement {  readonly sql: string;
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
const nowIso = () => new Date().toISOString();
const shifted = (ms: number) => new Date(Date.now() + ms).toISOString();
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
  const service = createInvestigationLedgerService(store, fences, handles, nowIso);
  return { raw, d1, digests, handles, fence, fences, store, service };
}
function baseInput(overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput {
  return {
    investigation_id: "inv-c1", goal: "answer the question", scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1, evidence_grade: "E2", lane: "confirmatory",
    lane_registrations: ["lane-conf-1"], obligations: [{
      obligation_id: "obl-1", verifier_ref: "verifier-a", lane: "confirmatory",
      metric_ref: "metric-1", status: "REGISTERED", exposed: true,
    }],
    hypotheses: ["h-1"], portfolio_ref: "portfolio-c1", debt_refs: ["debt-1"],
    principal_ref: "principal-1", input_digest: "a".repeat(64),
    policy_generation: "policy-gen-1", policy_authority_ref: "policy-auth-1",
    deployment_generation: "deploy-gen-1", idempotency_key: "idem-c1",
    model_profile_ref: "model-1", event_id: "evt-c1",
    payload_handle_ref: "payload-c1", payload_digest: "b".repeat(64),
    created_at: nowIso(), ...overrides,
  };
}
function seedHandles(ctx: ReturnType<typeof setup>, input: CreateLedgerInput): void { ctx.digests.set(input.payload_handle_ref, input.payload_digest); ctx.digests.set(input.portfolio_ref, input.input_digest); }
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof LedgerError) return error.code;
    const message = error instanceof Error ? error.message : "";
    const match = /LEDGER_[A-Z_]+/.exec(message);
    if (match !== null) return match[0];
    throw error;
  }
  throw new Error("expected LedgerError");
}
function snapshot(ctx: ReturnType<typeof setup>, id: string): string {
  const head = ctx.raw.prepare("SELECT revision, event_head, status FROM investigation_ledger_head WHERE investigation_id=?").get(id) as unknown as { revision: number; event_head: number; status: string } | undefined;
  const events = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?").get(id) as unknown as { n: number }).n;
  const commands = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_command").get() as unknown as { n: number }).n;
  const epoch = (ctx.raw.prepare("SELECT generation AS g FROM investigation_ledger_epoch WHERE singleton=1").get() as unknown as { g: number }).g;
  const authority = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_authority").get() as unknown as { n: number }).n;
  const guards = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_guard").get() as unknown as { n: number }).n;
  return `${head === undefined ? "absent" : `${head.revision}/${head.event_head}/${head.status}`}:${events}:cmd${commands}:epoch${epoch}:auth${authority}:guards${guards}`;
}
function headBytes(ctx: ReturnType<typeof setup>, id: string): string {
  return JSON.stringify(ctx.raw.prepare("SELECT * FROM investigation_ledger_head WHERE investigation_id=?").get(id));
}

describe("atomic ledger commands over committed migrations", () => {
  it("command columns mirror the migrated table and builders bind every slot", async () => {
    const ctx = setup();
    const cols = (ctx.raw.prepare("SELECT name FROM pragma_table_info('investigation_ledger_command') ORDER BY cid").all() as unknown as { name: string }[]).map((row) => row.name);
    expect([...COMMAND_COLUMNS]).toEqual(cols);
    expect(COMMAND_SQL.insertCommand.split("?").length - 1).toBe(COMMAND_COLUMNS.length);
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const snap = await ctx.store.read("inv-c1");
    if (snap === null) throw new Error("missing ledger");
    const stamp = nowIso();
    const next: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 4, updated_at: stamp };
    const event: LedgerEvent = { investigation_id: "inv-c1", sequence: 2, event_id: "evt-c1b", kind: "CHECKPOINT", payload_handle_ref: "payload-c1", payload_digest: "b".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
    const fence = await readCommandFence(ctx.d1 as unknown as LedgerCommandDatabase, next);
    const epochRow = await ctx.d1.prepare(COMMAND_SQL.selectEpoch).bind().first<{ generation: number }>();
    const built = buildAppendCommand(next, 1, event, fence, epochRow?.generation ?? 0, stamp);
    expect(built.commandId).toBe(ledgerCommandIdFor("evt-c1b"));
    expect(built.params.length).toBe(COMMAND_COLUMNS.length);
    expect(await hasCommittedCommand(ctx.d1 as unknown as LedgerCommandReader, built.commandId)).toBe(false);
    await ctx.d1.batch([ctx.d1.prepare(COMMAND_SQL.insertCommand).bind(...built.params)]);
    expect(await hasCommittedCommand(ctx.d1 as unknown as LedgerCommandReader, built.commandId)).toBe(true);
    expect((await ctx.service.read("inv-c1")).revision).toBe(2);
  });
  it("R1 closed: separate-transaction CAS plus forged event cannot resume a command", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const before = snapshot(ctx, "inv-c1");
    const beforeBytes = headBytes(ctx, "inv-c1");
    // Separate transaction zero-row CAS: no trigger fires, zero changes, no authorization.
    const cas = ctx.raw.prepare("UPDATE investigation_ledger_head SET revision=2, event_head=2, updated_at=? WHERE investigation_id='inv-c1' AND revision=999").run(nowIso()) as unknown as { changes: number | bigint };
    expect(Number(cas.changes)).toBe(0);
    // Separate transaction forged seq-2 event: no matching command row, must abort.
    expect(() => ctx.raw.prepare("INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("inv-c1", 2, "evt-forged", "CHECKPOINT", "ph-evil", "e".repeat(64), "actor-FORGED", null, nowIso())).toThrow(/LEDGER_CONFLICT/);
    // The retired guard path accepts no new rows.
    expect(() => ctx.raw.prepare("INSERT INTO investigation_ledger_guard (guard_id, op_kind, investigation_id, expected_old_revision, expected_new_revision, expected_old_event_head, expected_new_event_head, expected_event_id, principal_ref, scope_snapshot_id, scope_snapshot_revision, policy_generation, policy_authority_ref, deployment_generation, global_purge_revision, scope_purge_revision, expected_epoch, observed_at, expires_at, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING')").run("guard-dead", "APPEND", "inv-c1", 1, 2, 1, 2, "evt-forged", "principal-1", "scope-1", 1, "policy-gen-1", "policy-auth-1", "deploy-gen-1", 0, 0, 1, nowIso(), shifted(5 * 60 * 1000))).toThrow(/LEDGER_CONFLICT/);
    // Command receipts are immutable: no update, no delete, no resume.
    expect(() => ctx.raw.prepare("UPDATE investigation_ledger_command SET op_kind='APPEND' WHERE command_id=?").run(ledgerCommandIdFor("evt-c1"))).toThrow(/LEDGER_CONFLICT/);
    expect(() => ctx.raw.prepare("DELETE FROM investigation_ledger_command WHERE command_id=?").run(ledgerCommandIdFor("evt-c1"))).toThrow(/LEDGER_CONFLICT/);
    expect(snapshot(ctx, "inv-c1")).toBe(before);
    expect(headBytes(ctx, "inv-c1")).toBe(beforeBytes);
  });
  it("R2 closed: direct head DELETE fails and events stay pinned", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const before = snapshot(ctx, "inv-c1");
    expect(() => ctx.raw.prepare("DELETE FROM investigation_ledger_head WHERE investigation_id='inv-c1'").run()).toThrow(/LEDGER_CONFLICT/);
    expect(() => ctx.raw.prepare("DELETE FROM investigation_ledger_event WHERE investigation_id='inv-c1'").run()).toThrow(/append-only/);
    expect(() => ctx.raw.prepare("UPDATE investigation_ledger_event SET kind='CLOSED' WHERE investigation_id='inv-c1'").run()).toThrow(/append-only/);
    expect(snapshot(ctx, "inv-c1")).toBe(before);
  });
  it("R3 closed: D1-time bounds reject expired, future, skewed and over-TTL commands", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-t", "c".repeat(64));
    const before = snapshot(ctx, "inv-c1");
    const snap = await ctx.store.read("inv-c1");
    if (snap === null) throw new Error("missing ledger");
    const forged = async (stamp: string, eventId: string): Promise<string> => {
      const next: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: stamp };
      const event: LedgerEvent = { investigation_id: "inv-c1", sequence: 2, event_id: eventId, kind: "CHECKPOINT", payload_handle_ref: "payload-t", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
      return codeOf(ctx.store.append(next, 1, event));
    };
    expect(await forged(shifted(-3600 * 1000), "evt-past")).toBe("LEDGER_INPUT_INVALID");
    expect(await forged(shifted(3600 * 1000), "evt-future")).toBe("LEDGER_INPUT_INVALID");
    expect(await forged(shifted(61 * 1000), "evt-skew-future")).toBe("LEDGER_INPUT_INVALID");
    expect(await forged(shifted(-301 * 1000), "evt-skew-past")).toBe("LEDGER_INPUT_INVALID");
    expect(snapshot(ctx, "inv-c1")).toBe(before);
    // Bounded skew accepts a mildly future instant; over-TTL expiry fails even when fresh.
    const ttlCtx = setup();
    const ttlInput = baseInput({ investigation_id: "inv-ttl", idempotency_key: "idem-ttl", event_id: "evt-ttl", portfolio_ref: "portfolio-ttl", payload_handle_ref: "payload-ttl" });
    seedHandles(ttlCtx, ttlInput);
    await ttlCtx.service.create(ttlInput);
    const ttlSnap = await ttlCtx.store.read("inv-ttl");
    if (ttlSnap === null) throw new Error("missing ledger");
    const ttlStamp = nowIso();
    const ttlNext: LedgerHead = { ...ttlSnap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: ttlStamp };
    const ttlEvent: LedgerEvent = { investigation_id: "inv-ttl", sequence: 2, event_id: "evt-ttl-2", kind: "CHECKPOINT", payload_handle_ref: "payload-ttl", payload_digest: "b".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: ttlStamp };
    const ttlFence = await readCommandFence(ttlCtx.d1 as unknown as LedgerCommandDatabase, ttlNext);
    const ttlEpoch = await ttlCtx.d1.prepare(COMMAND_SQL.selectEpoch).bind().first<{ generation: number }>();
    const ttlBuilt = buildAppendCommand(ttlNext, 1, ttlEvent, ttlFence, ttlEpoch?.generation ?? 0, ttlStamp);
    const ttlParams = [...ttlBuilt.params];
    ttlParams[COMMAND_COLUMNS.indexOf("expires_at")] = shifted(11 * 60 * 1000);
    const ttlBefore = snapshot(ttlCtx, "inv-ttl");
    await expect(ttlCtx.d1.batch([ttlCtx.d1.prepare(COMMAND_SQL.insertCommand).bind(...ttlParams)])).rejects.toThrow(/LEDGER_INPUT_INVALID/);
    expect(snapshot(ttlCtx, "inv-ttl")).toBe(ttlBefore);
  });
  it("bounded skew accepts a mildly future instant", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-t", "c".repeat(64));
    const snap = await ctx.store.read("inv-c1");
    if (snap === null) throw new Error("missing ledger");
    const stamp = shifted(30 * 1000);
    const next: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: stamp };
    const event: LedgerEvent = { investigation_id: "inv-c1", sequence: 2, event_id: "evt-skew-ok", kind: "CHECKPOINT", payload_handle_ref: "payload-t", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
    expect((await ctx.store.append(next, 1, event)).revision).toBe(2);
  });
  it("R4 closed: fence-read failure and command failure leave everything byte-identical", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    const before = snapshot(ctx, "inv-c1");
    const beforeBytes = headBytes(ctx, "inv-c1");
    expect(before).toMatch(/auth0/);
    // Fence read failure aborts before any command with no mutation and no suppression.
    const blind = new Proxy(ctx.d1, {
      get(target, key) {
        if (key === "prepare") {
          return (sql: string) => {
            if (sql.includes("purge_ledger")) throw new Error("fence D1 down");
            return (target as unknown as { prepare(s: string): unknown }).prepare(sql);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as LedgerD1Database;
    const blindStore = createD1InvestigationLedgerStore(blind);
    const blindService = createInvestigationLedgerService(blindStore, ctx.fences, ctx.handles, nowIso);
    ctx.digests.set("payload-blind", "c".repeat(64));
    expect(await codeOf(blindService.checkpoint("inv-c1", 1, 3, "principal-1", "evt-blind", "payload-blind", "c".repeat(64)))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(snapshot(ctx, "inv-c1")).toBe(before);
    expect(headBytes(ctx, "inv-c1")).toBe(beforeBytes);
    // Command statement failure commits nothing: no head, event, command, authority or epoch effect.
    const crashing = new Proxy(ctx.d1, {
      get(target, key) {
        if (key === "batch") return async () => { throw new Error("command D1 down"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as LedgerD1Database;
    const crashingService = createInvestigationLedgerService(createD1InvestigationLedgerStore(crashing), ctx.fences, ctx.handles, nowIso);
    expect(await codeOf(crashingService.checkpoint("inv-c1", 1, 3, "principal-1", "evt-crash", "payload-blind", "c".repeat(64)))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(snapshot(ctx, "inv-c1")).toBe(before);
    expect(headBytes(ctx, "inv-c1")).toBe(beforeBytes);
    // The write path never materializes authority rows: the table stays empty throughout.
    ctx.digests.set("payload-ok", "d".repeat(64));
    await ctx.service.checkpoint("inv-c1", 1, 3, "principal-1", "evt-ok", "payload-ok", "d".repeat(64));
    expect((await ctx.service.read("inv-c1")).revision).toBe(2);
    expect(snapshot(ctx, "inv-c1")).toMatch(/auth0/);
  });
  it("forged actor, verifier, payload, digest, created_at and immutable head bytes fail closed", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-f", "c".repeat(64));
    const before = snapshot(ctx, "inv-c1");
    const beforeBytes = headBytes(ctx, "inv-c1");
    const snap = await ctx.store.read("inv-c1");
    if (snap === null) throw new Error("missing ledger");
    const stamp = nowIso();
    const cleanNext: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 4, updated_at: stamp };
    const cleanEvent: LedgerEvent = { investigation_id: "inv-c1", sequence: 2, event_id: "evt-clean", kind: "CHECKPOINT", payload_handle_ref: "payload-f", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
    // Forged actor on a non-acceptance kind and forged verifier binding both abort.
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, event_id: "evt-evil-actor", actor_ref: "actor-evil" }))).toBe("LEDGER_PRINCIPAL_DENIED");
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, event_id: "evt-evil-ver", kind: "OBLIGATION_ACCEPTED", verifier_ref: "verifier-evil" }))).toBe("LEDGER_VERIFIER_DENIED");
    // Every immutable head field diverges the command bytes and fails with no effect.
    const immutables: { name: string; head: LedgerHead }[] = [
      { name: "grade", head: { ...cleanNext, evidence_grade: "E3" } },
      { name: "lane", head: { ...cleanNext, lane: "exploratory" } },
      { name: "principal", head: { ...cleanNext, principal_ref: "principal-evil" } },
      { name: "scope", head: { ...cleanNext, scope_snapshot_id: "scope-foreign" } },
      { name: "policy", head: { ...cleanNext, policy_generation: "policy-stale" } },
      { name: "deployment", head: { ...cleanNext, deployment_generation: "deploy-stale" } },
      { name: "input_digest", head: { ...cleanNext, input_digest: "f".repeat(64) } },
      { name: "idempotency", head: { ...cleanNext, idempotency_key: "idem-evil" } },
      { name: "protocol", head: { ...cleanNext, protocol_version: "eliotr.evil.v9" } },
      { name: "goal", head: { ...cleanNext, goal: "forged goal" } },
      { name: "model", head: { ...cleanNext, model_profile_ref: "model-evil" } },
      { name: "created_at", head: { ...cleanNext, created_at: shifted(1000) } },
      { name: "supersedes", head: { ...cleanNext, supersedes_id: "inv-evil" } },
    ];
    for (const item of immutables) {
      const code = await codeOf(ctx.store.append(item.head, 1, { ...cleanEvent, event_id: `evt-imm-${item.name}` }));
      expect(["LEDGER_INPUT_INVALID", "LEDGER_CONFLICT", "LEDGER_PRINCIPAL_DENIED", "LEDGER_SCOPE_FOREIGN", "LEDGER_POLICY_STALE", "LEDGER_DEPLOYMENT_STALE", "LEDGER_SUPERSESSION_REQUIRED"].includes(code), item.name).toBe(true);
      expect(snapshot(ctx, "inv-c1"), `${item.name} rows`).toBe(before);
    }
    // Reused event id with divergent payload/digest/created_at conflicts; exact bytes replay once.
    await ctx.store.append(cleanNext, 1, cleanEvent);
    expect(snapshot(ctx, "inv-c1")).toMatch(/^2\/2\/OPEN:2/);
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, payload_digest: "d".repeat(64) }))).toBe("LEDGER_CONFLICT");
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, payload_handle_ref: "ph-other" }))).toBe("LEDGER_CONFLICT");
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, created_at: shifted(2000) }))).toBe("LEDGER_CONFLICT");
    expect(await ctx.store.append(cleanNext, 1, cleanEvent)).toEqual(await ctx.service.read("inv-c1"));
    expect(snapshot(ctx, "inv-c1")).toMatch(/^2\/2\/OPEN:2/);
    expect(headBytes(ctx, "inv-c1")).not.toBe(beforeBytes);
  });
  it("exact replay settles once, divergent supersede conflicts, restart reads contiguously", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-r", "c".repeat(64));
    // Exact replay needs byte-identical input: same expected revision and same bytes twice.
    const frozen = nowIso();
    const snap = await ctx.store.read("inv-c1");
    if (snap === null) throw new Error("missing ledger");
    const next = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 7, updated_at: frozen };
    const event = { investigation_id: "inv-c1", sequence: 2, event_id: "evt-r", kind: "CHECKPOINT" as const, payload_handle_ref: "payload-r", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: frozen };
    const once = await ctx.store.append(next, 1, event);
    const twice = await ctx.store.append(next, 1, event);
    expect(twice).toEqual(once);
    expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_command").get() as unknown as { n: number }).n).toBe(2);
    const replacement = baseInput({ investigation_id: "inv-c2", idempotency_key: "idem-c2", event_id: "evt-c2", portfolio_ref: "portfolio-c2", payload_handle_ref: "payload-c2" });
    seedHandles(ctx, replacement);
    const settled = await ctx.service.supersede("inv-c1", 2, replacement, "post-exposure metric change", "principal-1");
    expect(settled.supersedes_id).toBe("inv-c1");
    expect(await ctx.service.supersede("inv-c1", 2, replacement, "post-exposure metric change", "principal-1")).toEqual(settled);
    expect(await codeOf(ctx.service.supersede("inv-c1", 2, replacement, "a different reason", "principal-1"))).toBe("LEDGER_CONFLICT");
    const restarted = createInvestigationLedgerService(createD1InvestigationLedgerStore(ctx.d1), ctx.fences, ctx.handles, nowIso);
    const oldHead = await restarted.read("inv-c1");
    const newHead = await restarted.read("inv-c2");
    expect(oldHead.status).toBe("SUPERSEDED");
    expect(newHead.supersedes_id).toBe("inv-c1");
    for (const id of ["inv-c1", "inv-c2"]) {
      const snap = await ctx.store.read(id);
      if (snap === null) throw new Error(`missing ${id}`);
      expect(snap.events.length).toBe(snap.head.event_head);
      expect(snap.events.map((event) => event.sequence)).toEqual(snap.events.map((_, index) => index + 1));
    }
  });
  it("FIX5 P1-A: forged ordinary events cannot mutate any protected family", async () => {
    const ctx = setup();
    const input = baseInput();
    seedHandles(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-x", "c".repeat(64));
    const snap = await ctx.store.read("inv-c1");
    if (snap === null) throw new Error("missing ledger");
    const stamp = nowIso();
    let tag = 0;
    const chk = (head: LedgerHead, kind: LedgerEvent["kind"], extra: Partial<LedgerEvent> = {}): LedgerEvent => ({
      investigation_id: "inv-c1", sequence: 2, event_id: `evt-fix5-${(tag += 1)}`,
      kind, payload_handle_ref: "payload-x", payload_digest: "c".repeat(64),
      actor_ref: "principal-1", verifier_ref: null, created_at: stamp, ...extra,
    });
    const base: LedgerHead = { ...snap.head, revision: 2, event_head: 2, updated_at: stamp };
    const evilObl = [{ obligation_id: "obl-1", verifier_ref: "verifier-evil", lane: "confirmatory" as const, metric_ref: "metric-evil", status: "ACCEPTED" as const, exposed: true }];
    const cases: { name: string; head: LedgerHead; event: LedgerEvent; code: string }[] = [
      { name: "obligations", head: { ...base, obligations: evilObl }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "oblig-verifier", head: { ...base, obligations: [{ ...snap.head.obligations[0] as LedgerHead["obligations"][number], verifier_ref: "verifier-evil" }] }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "hypotheses", head: { ...base, hypotheses: ["h-evil"] }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "hyp-order", head: { ...base, hypotheses: ["h-1", "h-2"] }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "lane-reg", head: { ...base, lane_registrations: ["lane-evil"] }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "portfolio", head: { ...base, portfolio_ref: "portfolio-evil" }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "debt", head: { ...base, debt_refs: ["debt-evil"] }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "observed", head: { ...base, observed_execution: "evil-obs" }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "status", head: { ...base, status: "CLOSED" }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "supersede-reason", head: { ...base, supersession_reason: "evil" }, event: chk(base, "CHECKPOINT"), code: "LEDGER_INPUT_INVALID" },
      { name: "grade", head: { ...base, evidence_grade: "E3" }, event: chk(base, "CHECKPOINT"), code: "LEDGER_SUPERSESSION_REQUIRED" },
      { name: "checkpoint-via-accept", head: { ...base, checkpoint_head: 99, obligations: [{ ...snap.head.obligations[0] as LedgerHead["obligations"][number], status: "ACCEPTED" as const }] }, event: chk(base, "OBLIGATION_ACCEPTED", { actor_ref: "verifier-a", verifier_ref: "verifier-a" }), code: "LEDGER_INPUT_INVALID" },
      { name: "created-kind", head: { ...base }, event: chk(base, "CREATED"), code: "LEDGER_INPUT_INVALID" },
      { name: "superseded-kind", head: { ...base }, event: chk(base, "SUPERSEDED"), code: "LEDGER_INPUT_INVALID" },
      { name: "obl-via-observed", head: { ...base, obligations: evilObl, observed_execution: "e", observed_fidelity: "f", observed_assurance: "a" }, event: chk(base, "OBSERVED"), code: "LEDGER_INPUT_INVALID" },
    ];
    for (const item of cases) {
      const before = snapshot(ctx, "inv-c1");
      const beforeBytes = headBytes(ctx, "inv-c1");
      const beforeEvents = JSON.stringify(ctx.raw.prepare("SELECT event_id, kind, sequence FROM investigation_ledger_event WHERE investigation_id='inv-c1' ORDER BY sequence").all());
      const beforeCmds = (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_command").get() as unknown as { n: number }).n;
      expect(await codeOf(ctx.store.append(item.head, 1, item.event)), item.name).toBe(item.code);
      expect(snapshot(ctx, "inv-c1"), `${item.name} rows`).toBe(before);
      expect(headBytes(ctx, "inv-c1"), `${item.name} head`).toBe(beforeBytes);
      expect(JSON.stringify(ctx.raw.prepare("SELECT event_id, kind, sequence FROM investigation_ledger_event WHERE investigation_id='inv-c1' ORDER BY sequence").all()), `${item.name} events`).toBe(beforeEvents);
      expect((ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_command").get() as unknown as { n: number }).n, `${item.name} cmds`).toBe(beforeCmds);
    }
  });
  it("FIX5 P1-B: malformed and noncanonical timestamps fail at both layers with zero effects", async () => {
    const bad: string[] = ["not-a-date", "", "null", "NULL", "undefined", "2026-13-01T00:00:00.000Z", "2026-02-30T00:00:00.000Z", "2026-09-06T05:00:00+02:00", "2026-09-06T05:00:00Z", "2026-09-06T05:00:00.00Z", "2026-09-06T05:00:00.0000Z", "2026-09-06 05:00:00.000Z", "2026-09-06T24:00:00.000Z", "2026-02-29T00:00:00.000Z"];
    for (const stamp of bad) {
      const ctx = setup();
      const input = baseInput();
      seedHandles(ctx, input);
      await ctx.service.create(input);
      ctx.digests.set("payload-t", "c".repeat(64));
      const snap = await ctx.store.read("inv-c1");
      if (snap === null) throw new Error("missing ledger");
      const before = snapshot(ctx, "inv-c1");
      const beforeBytes = headBytes(ctx, "inv-c1");
      const forgedNext: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: stamp };
      const forgedEvent: LedgerEvent = { investigation_id: "inv-c1", sequence: 2, event_id: `evt-ts-${bad.indexOf(stamp)}`, kind: "CHECKPOINT", payload_handle_ref: "payload-t", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
      expect(await codeOf(ctx.store.append(forgedNext, 1, forgedEvent)), `service:${stamp}`).toBe("LEDGER_INPUT_INVALID");
      expect(snapshot(ctx, "inv-c1"), `service-rows:${stamp}`).toBe(before);
      // Raw D1 command insert with every time slot forged: must fail closed too.
      const good = nowIso();
      const validNext: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: good };
      const validEvent: LedgerEvent = { investigation_id: "inv-c1", sequence: 2, event_id: `evt-raw-${bad.indexOf(stamp)}`, kind: "CHECKPOINT", payload_handle_ref: "payload-t", payload_digest: "c".repeat(64), actor_ref: "principal-1", verifier_ref: null, created_at: good };
      const fence = await readCommandFence(ctx.d1 as unknown as LedgerCommandDatabase, validNext);
      const epochRow = await ctx.d1.prepare(COMMAND_SQL.selectEpoch).bind().first<{ generation: number }>();
      const params = [...buildAppendCommand(validNext, 1, validEvent, fence, epochRow?.generation ?? 1, good).params];
      for (const col of ["observed_at", "expires_at", "nh_updated_at", "ne_created_at"]) params[COMMAND_COLUMNS.indexOf(col)] = stamp;
      await expect(ctx.d1.batch([ctx.d1.prepare(COMMAND_SQL.insertCommand).bind(...params)]), `d1:${stamp}`).rejects.toThrow(/LEDGER_INPUT_INVALID/);
      expect(snapshot(ctx, "inv-c1"), `d1-rows:${stamp}`).toBe(before);
      expect(headBytes(ctx, "inv-c1"), `d1-head:${stamp}`).toBe(beforeBytes);
    }
  });
});
