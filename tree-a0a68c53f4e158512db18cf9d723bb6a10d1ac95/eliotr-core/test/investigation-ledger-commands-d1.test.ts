import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import {
  COMMAND_COLUMNS, COMMAND_SQL, buildAppendCommand,
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  readCommandFence,
  type CreateLedgerInput,
  type LedgerCommandDatabase,
  type LedgerD1Database,
  type LedgerEvent,
  type LedgerHead,
} from "@eliotr/research";

interface Migration {
  name: string;
  queries: string[];
}
const runtime = env as unknown as { CORE_DB: LedgerD1Database; CORE_MIGRATIONS: Migration[] };
const db = runtime.CORE_DB;

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const nowIso = () => new Date().toISOString();
const shifted = (ms: number) => new Date(Date.now() + ms).toISOString();

function context() {
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
  const store = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
  const service = createInvestigationLedgerService(store, fences, handles, nowIso);
  return { digests, handles, fence, fences, store, service };
}
async function seedAuthority(): Promise<void> {
  const d = db as unknown as LedgerD1Database;
  const now = "2026-09-05T00:00:00.000Z";
  const future = "2030-01-01T00:00:00.000Z";
  await d.batch([
    d.prepare("INSERT OR IGNORE INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)").bind("policy-gen-1", "policy-auth-1", now),
    d.prepare("INSERT OR IGNORE INTO investigation_current_deployment (deployment_generation, state, created_at) VALUES (?1,'ACTIVE',?2)").bind("deploy-gen-1", now),
    d.prepare("INSERT OR IGNORE INTO scope_snapshot (snapshot_id, revision, resolved_scope_expression_json, participant_generations_json, member_source_revision_refs_json, source_owner_generations_json, policy_authority_ref, disclosure_closure_digest, purge_ledger_revision, snapshot_digest, created_at, expires_at, invalidated_at) VALUES ('scope-1',1,'{}','{}','[]','{}','policy-auth-1',?1,0,?2,?3,?4,NULL)").bind("c".repeat(64), "d".repeat(64), now, future),
    d.prepare("INSERT OR IGNORE INTO scope_access_grant (snapshot_id, snapshot_revision, principal_ref, client_class, credential_generation, policy_authority_ref, allowed_use_json, disclosure_ceiling, authorization_receipt_ref, state, expires_at, created_at) VALUES ('scope-1',1,'principal-1','owner_pwa','cred-1','policy-auth-1','[]','exact','authz-scope-1-principal-1','ACTIVE',?1,?2)").bind(future, now),
  ]);
}
function baseInput(tag: string, overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput {
  return {
    investigation_id: `inv-cmd-${tag}`, goal: "answer over actual D1", scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1, evidence_grade: "E2", lane: "confirmatory",
    lane_registrations: ["lane-conf-1"], obligations: [{
      obligation_id: "obl-1", verifier_ref: "verifier-a", lane: "confirmatory",
      metric_ref: "metric-1", status: "REGISTERED", exposed: true,
    }],
    hypotheses: ["h-1"], portfolio_ref: `portfolio-cmd-${tag}`, debt_refs: ["debt-1"],
    principal_ref: "principal-1", input_digest: DIGEST_A,
    policy_generation: "policy-gen-1", policy_authority_ref: "policy-auth-1",
    deployment_generation: "deploy-gen-1", idempotency_key: `idem-cmd-${tag}`,
    model_profile_ref: "model-1", event_id: `evt-cmd-${tag}`,
    payload_handle_ref: `payload-cmd-${tag}`, payload_digest: DIGEST_B,
    created_at: nowIso(), ...overrides,
  };
}
function seedAll(ctx: ReturnType<typeof context>, input: CreateLedgerInput): void {
  ctx.digests.set(input.payload_handle_ref, input.payload_digest);
  ctx.digests.set(input.portfolio_ref, input.input_digest);
}
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    const message = error instanceof Error ? error.message : "";
    const match = /LEDGER_[A-Z_]+/.exec(message);
    if (match !== null) return match[0];
    throw error;
  }
  throw new Error("expected ledger failure");
}
async function fullState(investigationId: string): Promise<string> {
  const head = await db.prepare("SELECT revision, event_head, status FROM investigation_ledger_head WHERE investigation_id=?1").bind(investigationId).first<{ revision: number; event_head: number; status: string }>();
  const events = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?1").bind(investigationId).first<{ n: number }>();
  const commands = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_command").bind().first<{ n: number }>();
  const epoch = await db.prepare("SELECT generation AS g FROM investigation_ledger_epoch WHERE singleton=1").bind().first<{ g: number }>();
  const authority = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_authority").bind().first<{ n: number }>();
  return `${head === null ? "absent" : `${head.revision}/${head.event_head}/${head.status}`}:${events?.n ?? 0}:cmd${commands?.n ?? 0}:epoch${epoch?.g ?? 0}:auth${authority?.n ?? 0}`;
}
async function headBytes(investigationId: string): Promise<string> {
  return JSON.stringify(await db.prepare("SELECT * FROM investigation_ledger_head WHERE investigation_id=?1").bind(investigationId).first());
}

beforeEach(async () => {
  await applyD1Migrations(db as never, runtime.CORE_MIGRATIONS);
  await seedAuthority();
});

describe("atomic ledger commands over actual Cloudflare D1", () => {
  it("1 separate transactions cannot resume a command or guard", async () => {
    const ctx = context();
    const input = baseInput("f1");
    seedAll(ctx, input);
    await ctx.service.create(input);
    const before = await fullState(input.investigation_id);
    const beforeBytes = await headBytes(input.investigation_id);
    const d = db as unknown as LedgerD1Database;
    const cas = await d.prepare("UPDATE investigation_ledger_head SET revision=2, event_head=2, updated_at=?1 WHERE investigation_id=?2 AND revision=999").bind(nowIso(), input.investigation_id).run();
    expect(cas.meta.changes).toBe(0);
    await expect(d.prepare("INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) VALUES (?1,2,'evt-cmd-f1-forged','CHECKPOINT','ph-evil',?2,'actor-FORGED',NULL,?3)").bind(input.investigation_id, DIGEST_C, nowIso()).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    await expect(d.prepare("INSERT INTO investigation_ledger_guard (guard_id, op_kind, investigation_id, expected_old_revision, expected_new_revision, expected_old_event_head, expected_new_event_head, expected_event_id, principal_ref, scope_snapshot_id, scope_snapshot_revision, policy_generation, policy_authority_ref, deployment_generation, global_purge_revision, scope_purge_revision, expected_epoch, observed_at, expires_at, state) VALUES (?1,'APPEND',?2,1,2,1,2,'evt-cmd-f1-forged','principal-1','scope-1',1,'policy-gen-1','policy-auth-1','deploy-gen-1',0,0,1,?3,?4,'PENDING')").bind("guard-dead", input.investigation_id, nowIso(), shifted(5 * 60 * 1000)).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    await expect(d.prepare("UPDATE investigation_ledger_command SET op_kind='APPEND' WHERE command_id=?1").bind(`cmd-${input.event_id}`).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    await expect(d.prepare("DELETE FROM investigation_ledger_command WHERE command_id=?1").bind(`cmd-${input.event_id}`).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    expect(await fullState(input.investigation_id)).toBe(before);
    expect(await headBytes(input.investigation_id)).toBe(beforeBytes);
  });
  it("2 stale CAS aborts with no orphan event and no stray command", async () => {
    const ctx = context();
    const input = baseInput("f2");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-cmd-f2-2", DIGEST_C);
    await ctx.service.checkpoint(input.investigation_id, 1, 4, "principal-1", "evt-cmd-f2-2", "payload-cmd-f2-2", DIGEST_C);
    const before = await fullState(input.investigation_id);
    ctx.digests.set("payload-cmd-f2-stale", DIGEST_D);
    const other = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), ctx.fences, ctx.handles, nowIso);
    expect(await codeOf(other.checkpoint(input.investigation_id, 1, 9, "principal-1", "evt-cmd-f2-stale", "payload-cmd-f2-stale", DIGEST_D))).toBe("LEDGER_STALE_HEAD");
    expect(await db.prepare("SELECT event_id FROM investigation_ledger_event WHERE event_id='evt-cmd-f2-stale'").bind().first()).toBeNull();
    expect(await db.prepare("SELECT command_id FROM investigation_ledger_command WHERE command_id='cmd-evt-cmd-f2-stale'").bind().first()).toBeNull();
    expect(await fullState(input.investigation_id)).toBe(before);
  });
  it("3 create, append and supersede boundary faults roll back every row", async () => {
    const ctx = context();
    const d = db as unknown as LedgerD1Database;
    const crashing = (message: string) => {
      const proxied = new Proxy(d, {
        get(target, key) {
          if (key === "batch") return async () => { throw new Error(message); };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as LedgerD1Database;
      return createInvestigationLedgerService(createD1InvestigationLedgerStore(proxied), ctx.fences, ctx.handles, nowIso);
    };
    const epoch0 = await db.prepare("SELECT generation AS g FROM investigation_ledger_epoch WHERE singleton=1").bind().first<{ g: number }>();
    const input = baseInput("f3c");
    seedAll(ctx, input);
    expect(await codeOf(crashing("create down").create(input))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(await fullState(input.investigation_id)).toMatch(/^absent:0/);
    expect(await db.prepare("SELECT command_id FROM investigation_ledger_command WHERE command_id=?1").bind(`cmd-${input.event_id}`).first()).toBeNull();
    await ctx.service.create(input);
    const created = await fullState(input.investigation_id);
    ctx.digests.set("payload-cmd-f3a", DIGEST_C);
    expect(await codeOf(crashing("append down").checkpoint(input.investigation_id, 1, 3, "principal-1", "evt-cmd-f3a", "payload-cmd-f3a", DIGEST_C))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(await fullState(input.investigation_id)).toBe(created);
    expect(await db.prepare("SELECT command_id FROM investigation_ledger_command WHERE command_id='cmd-evt-cmd-f3a'").bind().first()).toBeNull();
    const replacement = baseInput("f3r");
    seedAll(ctx, replacement);
    expect(await codeOf(crashing("supersede down").supersede(input.investigation_id, 1, replacement, "fault injection", "principal-1"))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(await fullState(input.investigation_id)).toBe(created);
    expect(await fullState(replacement.investigation_id)).toMatch(/^absent:0/);
    expect(await db.prepare("SELECT command_id FROM investigation_ledger_command WHERE command_id=?1").bind(`cmd-supersede-${replacement.event_id}`).first()).toBeNull();
    expect((await db.prepare("SELECT generation AS g FROM investigation_ledger_epoch WHERE singleton=1").bind().first<{ g: number }>())?.g).toBe(epoch0?.g);
  });
  it("4 direct head delete and unguarded writes fail with zero effect", async () => {
    const ctx = context();
    const input = baseInput("f4");
    seedAll(ctx, input);
    await ctx.service.create(input);
    const before = await fullState(input.investigation_id);
    const beforeBytes = await headBytes(input.investigation_id);
    const d = db as unknown as LedgerD1Database;
    await expect(d.prepare("DELETE FROM investigation_ledger_head WHERE investigation_id=?1").bind(input.investigation_id).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    await expect(d.prepare("UPDATE investigation_ledger_head SET revision=99 WHERE investigation_id=?1").bind(input.investigation_id).run()).rejects.toThrow(/LEDGER_(STALE_HEAD|CONFLICT)/);
    await expect(d.prepare("UPDATE investigation_ledger_head SET goal='forged' WHERE investigation_id=?1").bind(input.investigation_id).run()).rejects.toThrow(/LEDGER_(STALE_HEAD|CONFLICT)/);
    await expect(d.prepare("INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) VALUES (?1,99,'evt-cmd-f4-raw','CHECKPOINT','ph-x',?2,'principal-1',NULL,?3)").bind(input.investigation_id, DIGEST_C, nowIso()).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    await expect(d.prepare("INSERT INTO investigation_ledger_head (investigation_id, revision, protocol_version, goal, scope_snapshot_id, scope_snapshot_revision, evidence_grade, lane, lane_registrations_json, obligations_json, hypotheses_json, portfolio_ref, debt_refs_json, checkpoint_head, principal_ref, input_digest, policy_generation, policy_authority_ref, deployment_generation, idempotency_key, model_profile_ref, observed_execution, observed_fidelity, observed_assurance, status, supersedes_id, supersession_reason, event_head, created_at, updated_at) VALUES ('inv-cmd-f4-raw',1,'eliotr.investigation.v1','g','scope-1',1,'E2','confirmatory','[]','[]','[]','pf','[]',0,'principal-1',?1,'policy-gen-1','policy-auth-1','deploy-gen-1','idem-cmd-f4-raw','model-1',NULL,NULL,NULL,'OPEN',NULL,NULL,1,?2,?2)").bind(DIGEST_A, nowIso()).run()).rejects.toThrow(/LEDGER_CONFLICT/);
    await expect(d.prepare("DELETE FROM investigation_ledger_event WHERE investigation_id=?1").bind(input.investigation_id).run()).rejects.toThrow(/append-only/);
    await expect(d.prepare("UPDATE investigation_ledger_event SET kind='CLOSED' WHERE investigation_id=?1").bind(input.investigation_id).run()).rejects.toThrow(/append-only/);
    expect(await fullState(input.investigation_id)).toBe(before);
    expect(await headBytes(input.investigation_id)).toBe(beforeBytes);
  });
  it("5 forged actor, verifier and immutable bytes fail byte-identical", async () => {
    const ctx = context();
    const input = baseInput("f5");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-cmd-f5", DIGEST_C);
    const before = await fullState(input.investigation_id);
    const beforeBytes = await headBytes(input.investigation_id);
    const snap = await ctx.store.read(input.investigation_id);
    if (snap === null) throw new Error("missing ledger");
    const stamp = nowIso();
    const cleanNext: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 4, updated_at: stamp };
    const cleanEvent: LedgerEvent = { investigation_id: input.investigation_id, sequence: 2, event_id: "evt-cmd-f5-clean", kind: "CHECKPOINT", payload_handle_ref: "payload-cmd-f5", payload_digest: DIGEST_C, actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
    expect(await codeOf(ctx.service.checkpoint(input.investigation_id, 1, 3, "actor-evil", "evt-cmd-f5-ea", "payload-cmd-f5", DIGEST_C))).toBe("LEDGER_PRINCIPAL_DENIED");
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, event_id: "evt-cmd-f5-fa", actor_ref: "actor-evil" }))).toBe("LEDGER_PRINCIPAL_DENIED");
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, event_id: "evt-cmd-f5-fv", kind: "OBLIGATION_ACCEPTED", verifier_ref: "verifier-evil" }))).toBe("LEDGER_VERIFIER_DENIED");
    const d = db as unknown as LedgerD1Database;
    const fence = await readCommandFence(d as unknown as LedgerCommandDatabase, cleanNext);
    const epoch = await d.prepare(COMMAND_SQL.selectEpoch).bind().first<{ generation: number }>();
    const raw = buildAppendCommand(cleanNext, 1, cleanEvent, fence, epoch?.generation ?? 0, stamp);
    const forgedActor = [...raw.params];
    forgedActor[COMMAND_COLUMNS.indexOf("ne_actor_ref")] = "actor-FORGED";
    await expect(d.batch([d.prepare(COMMAND_SQL.insertCommand).bind(...forgedActor)])).rejects.toThrow(/LEDGER_PRINCIPAL_DENIED/);
    const immutables: { name: string; head: LedgerHead; codes: string[] }[] = [
      { name: "grade", head: { ...cleanNext, evidence_grade: "E3" }, codes: ["LEDGER_SUPERSESSION_REQUIRED"] },
      { name: "principal", head: { ...cleanNext, principal_ref: "principal-evil" }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "scope", head: { ...cleanNext, scope_snapshot_id: "scope-foreign" }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "policy", head: { ...cleanNext, policy_generation: "policy-stale" }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "deployment", head: { ...cleanNext, deployment_generation: "deploy-stale" }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "input", head: { ...cleanNext, input_digest: DIGEST_D }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "idempotency", head: { ...cleanNext, idempotency_key: "idem-cmd-f5-evil" }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "created", head: { ...cleanNext, created_at: shifted(1000) }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "supersedes", head: { ...cleanNext, supersedes_id: "inv-evil" }, codes: ["LEDGER_INPUT_INVALID"] },
      { name: "goal", head: { ...cleanNext, goal: "forged goal" }, codes: ["LEDGER_INPUT_INVALID"] },
    ];
    for (const item of immutables) {
      const code = await codeOf(ctx.store.append(item.head, 1, { ...cleanEvent, event_id: `evt-cmd-f5-${item.name}` }));
      expect(item.codes.includes(code), item.name).toBe(true);
      expect(await fullState(input.investigation_id), `${item.name} rows`).toBe(before);
    }
    await ctx.store.append(cleanNext, 1, cleanEvent);
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, payload_digest: DIGEST_D }))).toBe("LEDGER_CONFLICT");
    expect(await codeOf(ctx.store.append(cleanNext, 1, { ...cleanEvent, created_at: shifted(2000) }))).toBe("LEDGER_CONFLICT");
    expect(await fullState(input.investigation_id)).toMatch(/^2\/2\/OPEN:2/);
    expect(await headBytes(input.investigation_id)).not.toBe(beforeBytes);
  });
  it("6 D1-time bounds reject expired, future, skewed and over-TTL commands", async () => {
    const ctx = context();
    const input = baseInput("f6");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-cmd-f6", DIGEST_C);
    const before = await fullState(input.investigation_id);
    const snap = await ctx.store.read(input.investigation_id);
    if (snap === null) throw new Error("missing ledger");
    const forged = async (stamp: string, eventId: string): Promise<string> => {
      const next: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: stamp };
      const event: LedgerEvent = { investigation_id: input.investigation_id, sequence: 2, event_id: eventId, kind: "CHECKPOINT", payload_handle_ref: "payload-cmd-f6", payload_digest: DIGEST_C, actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
      return codeOf(ctx.store.append(next, 1, event));
    };
    expect(await forged(shifted(-3600 * 1000), "evt-cmd-f6-past")).toBe("LEDGER_INPUT_INVALID");
    expect(await forged(shifted(3600 * 1000), "evt-cmd-f6-future")).toBe("LEDGER_INPUT_INVALID");
    expect(await forged(shifted(61 * 1000), "evt-cmd-f6-skew-future")).toBe("LEDGER_INPUT_INVALID");
    expect(await forged(shifted(-301 * 1000), "evt-cmd-f6-skew-past")).toBe("LEDGER_INPUT_INVALID");
    expect(await fullState(input.investigation_id)).toBe(before);
    const d = db as unknown as LedgerD1Database;
    const ttlStamp = nowIso();
    const ttlNext: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 3, updated_at: ttlStamp };
    const ttlEvent: LedgerEvent = { investigation_id: input.investigation_id, sequence: 2, event_id: "evt-cmd-f6-ttl", kind: "CHECKPOINT", payload_handle_ref: "payload-cmd-f6", payload_digest: DIGEST_C, actor_ref: "principal-1", verifier_ref: null, created_at: ttlStamp };
    const fence = await readCommandFence(d as unknown as LedgerCommandDatabase, ttlNext);
    const epoch = await d.prepare(COMMAND_SQL.selectEpoch).bind().first<{ generation: number }>();
    const ttlParams = [...buildAppendCommand(ttlNext, 1, ttlEvent, fence, epoch?.generation ?? 0, ttlStamp).params];
    ttlParams[COMMAND_COLUMNS.indexOf("expires_at")] = shifted(11 * 60 * 1000);
    await expect(d.batch([d.prepare(COMMAND_SQL.insertCommand).bind(...ttlParams)])).rejects.toThrow(/LEDGER_INPUT_INVALID/);
    expect(await fullState(input.investigation_id)).toBe(before);
  });
  it("7 authority and ledger failures leave rows byte-identical with no authority writes", async () => {
    const ctx = context();
    const input = baseInput("f7");
    seedAll(ctx, input);
    await ctx.service.create(input);
    const created = await fullState(input.investigation_id);
    expect(created).toMatch(/auth0/);
    const epochBefore = await db.prepare("SELECT generation AS g FROM investigation_ledger_epoch WHERE singleton=1").bind().first<{ g: number }>();
    ctx.digests.set("payload-cmd-f7-ok", DIGEST_C);
    await ctx.service.checkpoint(input.investigation_id, 1, 3, "principal-1", "evt-cmd-f7-ok", "payload-cmd-f7-ok", DIGEST_C);
    const afterSuccess = await fullState(input.investigation_id);
    expect(afterSuccess).toMatch(/auth0/);
    const epochAfter = await db.prepare("SELECT generation AS g FROM investigation_ledger_epoch WHERE singleton=1").bind().first<{ g: number }>();
    expect(epochAfter?.g).toBe(epochBefore?.g);
    const d = db as unknown as LedgerD1Database;
    const blind = new Proxy(d, {
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
    ctx.digests.set("payload-cmd-f7-blind", DIGEST_D);
    const blindService = createInvestigationLedgerService(createD1InvestigationLedgerStore(blind), ctx.fences, ctx.handles, nowIso);
    expect(await codeOf(blindService.checkpoint(input.investigation_id, 2, 4, "principal-1", "evt-cmd-f7-blind", "payload-cmd-f7-blind", DIGEST_D))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(await fullState(input.investigation_id)).toBe(afterSuccess);
    const crashing = new Proxy(d, {
      get(target, key) {
        if (key === "batch") return async () => { throw new Error("command D1 down"); };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as LedgerD1Database;
    const crashingService = createInvestigationLedgerService(createD1InvestigationLedgerStore(crashing), ctx.fences, ctx.handles, nowIso);
    expect(await codeOf(crashingService.checkpoint(input.investigation_id, 2, 4, "principal-1", "evt-cmd-f7-crash", "payload-cmd-f7-blind", DIGEST_D))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(await fullState(input.investigation_id)).toBe(afterSuccess);
  });
  it("8 exact replay, lost ACK, and concurrent winners settle once", async () => {
    const ctx = context();
    const input = baseInput("f8");
    seedAll(ctx, input);
    const first = await ctx.service.create(input);
    expect(await ctx.service.create(input)).toEqual(first);
    expect(await codeOf(ctx.service.create({ ...input, goal: "different goal" }))).toBe("LEDGER_CONFLICT");
    ctx.digests.set("payload-cmd-f8-a", DIGEST_C);
    let ackLost = true;
    const flaky = new Proxy(db as unknown as LedgerD1Database, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: readonly { sql: string; params: readonly unknown[] }[]) => {
            const result = await (target as unknown as { batch(s: unknown): Promise<unknown> }).batch(statements as never);
            if (ackLost) { ackLost = false; throw new Error("lost acknowledgement"); }
            return result;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as LedgerD1Database;
    const flakyService = createInvestigationLedgerService(createD1InvestigationLedgerStore(flaky), ctx.fences, ctx.handles, nowIso);
    await flakyService.checkpoint(input.investigation_id, 1, 7, "principal-1", "evt-cmd-f8-a", "payload-cmd-f8-a", DIGEST_C).catch(() => undefined);
    const reconciled = await ctx.service.checkpoint(input.investigation_id, 1, 7, "principal-1", "evt-cmd-f8-a", "payload-cmd-f8-a", DIGEST_C).catch(async () => ctx.service.read(input.investigation_id));
    expect(reconciled.revision).toBe(2);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_command WHERE command_id='cmd-evt-cmd-f8-a'").bind().first<{ n: number }>())?.n).toBe(1);
    ctx.digests.set("payload-cmd-f8-b", DIGEST_C);
    ctx.digests.set("payload-cmd-f8-c", DIGEST_D);
    const snap = await ctx.store.read(input.investigation_id);
    if (snap === null) throw new Error("missing ledger");
    const stamp = nowIso();
    const bytesFor = (eventId: string, checkpoint: number, digest: string): { head: LedgerHead; event: LedgerEvent } => ({
      head: { ...snap.head, revision: 3, event_head: 3, checkpoint_head: checkpoint, updated_at: stamp },
      event: { investigation_id: input.investigation_id, sequence: 3, event_id: eventId, kind: "CHECKPOINT", payload_handle_ref: `payload-cmd-f8-${checkpoint}`, payload_digest: digest, actor_ref: "principal-1", verifier_ref: null, created_at: stamp },
    });
    const exactA = bytesFor("evt-cmd-f8-exact", 11, DIGEST_C);
    const [left, right] = await Promise.allSettled([ctx.store.append(exactA.head, 2, exactA.event), ctx.store.append(exactA.head, 2, exactA.event)]);
    expect(left.status).toBe("fulfilled");
    expect(right.status).toBe("fulfilled");
    expect((left as PromiseFulfilledResult<LedgerHead>).value).toEqual((right as PromiseFulfilledResult<LedgerHead>).value);
    const divOutcomes = await Promise.allSettled([ctx.service.checkpoint(input.investigation_id, 3, 12, "principal-1", "evt-cmd-f8-div-a", "payload-cmd-f8-b", DIGEST_C), ctx.service.checkpoint(input.investigation_id, 3, 13, "principal-1", "evt-cmd-f8-div-b", "payload-cmd-f8-c", DIGEST_D)]);
    expect(divOutcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
    expect(divOutcomes.filter((o) => o.status === "rejected").length).toBe(1);
    expect(await fullState(input.investigation_id)).toMatch(/^4\/4\/OPEN:4/);
  });
  it("9 restart and readback reconstruct contiguous lineage", async () => {
    const ctx = context();
    const input = baseInput("f9");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-cmd-f9-c", DIGEST_C);
    await ctx.service.checkpoint(input.investigation_id, 1, 4, "principal-1", "evt-cmd-f9-c", "payload-cmd-f9-c", DIGEST_C);
    const replacement = baseInput("f9r");
    seedAll(ctx, replacement);
    const settled = await ctx.service.supersede(input.investigation_id, 2, replacement, "post-exposure metric change", "principal-1");
    expect(settled.supersedes_id).toBe(input.investigation_id);
    const restarted = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), ctx.fences, ctx.handles, nowIso);
    expect((await restarted.read(input.investigation_id)).status).toBe("SUPERSEDED");
    expect((await restarted.read(replacement.investigation_id)).supersedes_id).toBe(input.investigation_id);
    for (const id of [input.investigation_id, replacement.investigation_id]) {
      const rows = await db.prepare("SELECT sequence, kind FROM investigation_ledger_event WHERE investigation_id=?1 ORDER BY sequence ASC").bind(id).all<{ sequence: number; kind: string }>();
      const head = await db.prepare("SELECT event_head FROM investigation_ledger_head WHERE investigation_id=?1").bind(id).first<{ event_head: number }>();
      expect(rows.results.length).toBe(head?.event_head);
      expect(rows.results.map((row) => row.sequence)).toEqual(rows.results.map((_, index) => index + 1));
    }
    const kinds = await db.prepare("SELECT kind FROM investigation_ledger_event WHERE investigation_id=?1 ORDER BY sequence ASC").bind(input.investigation_id).all<{ kind: string }>();
    expect(kinds.results.map((row) => row.kind)).toEqual(["CREATED", "CHECKPOINT", "SUPERSEDED"]);
    expect(await fullState(input.investigation_id)).toMatch(/^3\/3\/SUPERSEDED:3/);
    expect(await fullState(replacement.investigation_id)).toMatch(/^1\/1\/OPEN:1/);
  });
});
