import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  type CreateLedgerInput,
  type LedgerD1Database,
  type LedgerD1Statement,
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
  const service = createInvestigationLedgerService(store, fences, handles, () => new Date().toISOString());
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
    investigation_id: `inv-d1-${tag}`, goal: "answer over actual D1", scope_snapshot_id: "scope-1",
    scope_snapshot_revision: 1, evidence_grade: "E2", lane: "confirmatory",
    lane_registrations: ["lane-conf-1"], obligations: [{
      obligation_id: "obl-1", verifier_ref: "verifier-a", lane: "confirmatory",
      metric_ref: "metric-1", status: "REGISTERED", exposed: true,
    }],
    hypotheses: ["h-1"], portfolio_ref: `portfolio-d1-${tag}`, debt_refs: ["debt-1"],
    principal_ref: "principal-1", input_digest: DIGEST_A,
    policy_generation: "policy-gen-1", policy_authority_ref: "policy-auth-1",
    deployment_generation: "deploy-gen-1", idempotency_key: `idem-d1-${tag}`,
    model_profile_ref: "model-1", event_id: `evt-d1-${tag}`,
    payload_handle_ref: `payload-d1-${tag}`, payload_digest: DIGEST_B,
    created_at: new Date().toISOString(), ...overrides,
  };
}

function seedAll(ctx: ReturnType<typeof context>, input: CreateLedgerInput): void {
  ctx.digests.set(input.payload_handle_ref, input.payload_digest);
  ctx.digests.set(input.portfolio_ref, input.input_digest);
}

async function invariant(investigationId: string): Promise<void> {
  const head = await db.prepare("SELECT revision, event_head FROM investigation_ledger_head WHERE investigation_id=?1").bind(investigationId).first<{ revision: number; event_head: number }>();
  if (head === null) return;
  const events = await db.prepare("SELECT sequence FROM investigation_ledger_event WHERE investigation_id=?1 ORDER BY sequence ASC").bind(investigationId).all<{ sequence: number }>();
  expect(events.results.length).toBe(head.event_head);
  expect(events.results.map((row) => row.sequence)).toEqual(events.results.map((_, index) => index + 1));
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    throw error;
  }
  throw new Error("expected ledger failure");
}

async function rowState(investigationId: string): Promise<string> {
  const head = await db.prepare("SELECT revision, event_head, status FROM investigation_ledger_head WHERE investigation_id=?1").bind(investigationId).first<{ revision: number; event_head: number; status: string }>();
  const events = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?1").bind(investigationId).first<{ n: number }>();
  return `${head === null ? "absent" : `${head.revision}/${head.event_head}/${head.status}`}:${events?.n ?? 0}`;
}

async function eventKinds(investigationId: string): Promise<string[]> {
  const rows = await db.prepare("SELECT kind FROM investigation_ledger_event WHERE investigation_id=?1 ORDER BY sequence ASC").bind(investigationId).all<{ kind: string }>();
  return rows.results.map((row) => row.kind);
}

function interceptBatch(database: LedgerD1Database, onBatch: (statements: readonly LedgerD1Statement[]) => Promise<void>): LedgerD1Database {
  return new Proxy(database, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: readonly LedgerD1Statement[]) => {
          await onBatch(statements);
          return (target as LedgerD1Database).batch(statements);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LedgerD1Database;
}

beforeEach(async () => {
  await applyD1Migrations(db as never, runtime.CORE_MIGRATIONS);
  await seedAuthority();
});

describe("investigation ledger over actual Cloudflare D1", () => {
  it("creates, appends and reconstructs from committed migration rows with readback", async () => {
    const ctx = context();
    const input = baseInput("t1");
    seedAll(ctx, input);
    const created = await ctx.service.create(input);
    expect(created.revision).toBe(1);
    const headRow = await db.prepare("SELECT investigation_id, revision, evidence_grade, principal_ref, input_digest, idempotency_key FROM investigation_ledger_head WHERE investigation_id=?1").bind(input.investigation_id).first<Record<string, unknown>>();
    expect(headRow).toMatchObject({ investigation_id: input.investigation_id, revision: 1, evidence_grade: "E2", principal_ref: "principal-1", input_digest: DIGEST_A, idempotency_key: input.idempotency_key });
    const eventRow = await db.prepare("SELECT investigation_id, sequence, event_id, kind FROM investigation_ledger_event WHERE investigation_id=?1").bind(input.investigation_id).first<Record<string, unknown>>();
    expect(eventRow).toMatchObject({ investigation_id: input.investigation_id, sequence: 1, event_id: input.event_id, kind: "CREATED" });
    ctx.digests.set("payload-d1-t1-2", DIGEST_C);
    await ctx.service.checkpoint(input.investigation_id, 1, 4, "principal-1", "evt-d1-t1-2", "payload-d1-t1-2", DIGEST_C);
    const restarted = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), ctx.fences, ctx.handles, () => new Date().toISOString());
    const head = await restarted.read(input.investigation_id);
    expect(head.revision).toBe(2);
    expect(head.checkpoint_head).toBe(4);
    await invariant(input.investigation_id);
  });
  it("stale CAS from a second store rolls back with no orphan event", async () => {
    const ctx = context();
    const input = baseInput("t2");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-d1-t2-2", DIGEST_C);
    ctx.digests.set("payload-d1-t2-stale", DIGEST_D);
    await ctx.service.checkpoint(input.investigation_id, 1, 4, "principal-1", "evt-d1-t2-2", "payload-d1-t2-2", DIGEST_C);
    const other = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(await codeOf(other.checkpoint(input.investigation_id, 1, 9, "principal-1", "evt-d1-t2-stale", "payload-d1-t2-stale", DIGEST_D))).toBe("LEDGER_STALE_HEAD");
    expect(await db.prepare("SELECT event_id FROM investigation_ledger_event WHERE event_id=?1").bind("evt-d1-t2-stale").first()).toBeNull();
    expect((await ctx.service.read(input.investigation_id)).revision).toBe(2);
    await invariant(input.investigation_id);
  });
  it("fences, verifier binding, deviation and explicit supersession hold over D1", async () => {
    const ctx = context();
    const input = baseInput("t3");
    seedAll(ctx, input);
    await ctx.service.create(input);
    expect(await codeOf(ctx.service.create({ ...input, investigation_id: "inv-d1-t3-x", idempotency_key: "idem-d1-t3-x", event_id: "evt-d1-t3-x", payload_handle_ref: "payload-d1-t3-x", portfolio_ref: "portfolio-d1-t3-x", principal_ref: "principal-evil" }))).toBe("LEDGER_PRINCIPAL_DENIED");
    ctx.digests.set("payload-d1-t3-bad", DIGEST_C);
    expect(await codeOf(ctx.service.acceptObligation(input.investigation_id, 1, "obl-1", "verifier-a", "metric-1", "principal-1", "evt-d1-t3-fake", "payload-d1-t3-bad", DIGEST_C))).toBe("LEDGER_VERIFIER_DENIED");
    ctx.digests.set("payload-d1-t3-dev", DIGEST_D);
    await ctx.service.recordDeviation(input.investigation_id, 1, "obl-1", "principal-1", "evt-d1-t3-dev", "payload-d1-t3-dev", DIGEST_D, "metric moved after exposure");
    ctx.digests.set("payload-d1-t3-re", DIGEST_C);
    expect(await codeOf(ctx.service.acceptObligation(input.investigation_id, 2, "obl-1", "verifier-a", "metric-1", "verifier-a", "evt-d1-t3-re", "payload-d1-t3-re", DIGEST_C))).toBe("LEDGER_SUPERSESSION_REQUIRED");
    const replacement = baseInput("t3r");
    seedAll(ctx, replacement);
    const settled = await ctx.service.supersede(input.investigation_id, 2, replacement, "post-exposure metric change", "principal-1");
    expect(settled.investigation_id).toBe(replacement.investigation_id);
    expect(settled.supersedes_id).toBe(input.investigation_id);
    expect((await ctx.service.read(input.investigation_id)).status).toBe("SUPERSEDED");
    const kinds = await db.prepare("SELECT kind FROM investigation_ledger_event WHERE investigation_id=?1 ORDER BY sequence ASC").bind(input.investigation_id).all<{ kind: string }>();
    expect(kinds.results.map((row) => row.kind)).toEqual(["CREATED", "DEVIATION", "SUPERSEDED"]);
    await invariant(input.investigation_id);
    await invariant(replacement.investigation_id);
  });
  it("conflicting idempotent replay over D1 has no second effect", async () => {
    const ctx = context();
    const input = baseInput("t4");
    seedAll(ctx, input);
    await ctx.service.create(input);
    expect(await codeOf(ctx.service.create({ ...input, goal: "different goal" }))).toBe("LEDGER_CONFLICT");
    const heads = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head WHERE investigation_id=?1").bind(input.investigation_id).first<{ n: number }>();
    const events = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?1").bind(input.investigation_id).first<{ n: number }>();
    expect(heads?.n).toBe(1);
    expect(events?.n).toBe(1);
    await invariant(input.investigation_id);
  });
  it("supersession CAS loss at the in-batch boundary leaves the complete old winner with no orphan replacement", async () => {
    const ctx = context();
    const input = baseInput("t5");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-d1-t5-win", DIGEST_C);
    const replacement = baseInput("t5r");
    seedAll(ctx, replacement);
    let winnerCommitted = false;
    const loserDb = interceptBatch(db as unknown as LedgerD1Database, async (statements) => {
      if (statements.length === 1 && !winnerCommitted) {
        winnerCommitted = true;
        await ctx.service.checkpoint(input.investigation_id, 1, 4, "principal-1", "evt-d1-t5-win", "payload-d1-t5-win", DIGEST_C);
      }
    });
    const loser = createInvestigationLedgerService(createD1InvestigationLedgerStore(loserDb), ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(winnerCommitted).toBe(false);
    expect(await codeOf(loser.supersede(input.investigation_id, 1, replacement, "raced supersession", "principal-1"))).toBe("LEDGER_STALE_HEAD");
    expect(winnerCommitted).toBe(true);
    expect(await rowState(input.investigation_id)).toBe("2/2/OPEN:2");
    expect(await eventKinds(input.investigation_id)).toEqual(["CREATED", "CHECKPOINT"]);
    expect(await rowState(replacement.investigation_id)).toBe("absent:0");
    expect(await db.prepare("SELECT investigation_id FROM investigation_ledger_head WHERE supersedes_id=?1").bind(input.investigation_id).first()).toBeNull();
    await invariant(input.investigation_id);
  });
  it("supersession fault injection before the batch and lost ACK after it never duplicate the effect", async () => {
    const ctx = context();
    const input = baseInput("t6");
    seedAll(ctx, input);
    await ctx.service.create(input);
    const replacement = baseInput("t6r");
    seedAll(ctx, replacement);
    const crashing = interceptBatch(db as unknown as LedgerD1Database, async (statements) => {
      if (statements.length === 1) throw new Error("crash before supersession command");
    });
    const crashingService = createInvestigationLedgerService(createD1InvestigationLedgerStore(crashing), ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(await codeOf(crashingService.supersede(input.investigation_id, 1, replacement, "fault injection", "principal-1"))).toBe("LEDGER_SETTLEMENT_UNCERTAIN");
    expect(await rowState(input.investigation_id)).toBe("1/1/OPEN:1");
    expect(await rowState(replacement.investigation_id)).toBe("absent:0");
    let ackLost = true;
    const ackStore = {
      ...ctx.store,
      supersede: async (oldHead: LedgerHead, oldEvent: LedgerEvent, expectedOldRevision: number, newHead: LedgerHead, newEvent: LedgerEvent) => {
        const out = await ctx.store.supersede(oldHead, oldEvent, expectedOldRevision, newHead, newEvent);
        if (ackLost) { ackLost = false; throw new Error("lost acknowledgement"); }
        return out;
      },
    };
    const ackService = createInvestigationLedgerService(ackStore, ctx.fences, ctx.handles, () => new Date().toISOString());
    await expect(ackService.supersede(input.investigation_id, 1, replacement, "fault injection", "principal-1")).rejects.toThrow("lost acknowledgement");
    const reconciled = await ctx.service.supersede(input.investigation_id, 1, replacement, "fault injection", "principal-1");
    expect(reconciled.supersedes_id).toBe(input.investigation_id);
    expect(await rowState(input.investigation_id)).toBe("2/2/SUPERSEDED:2");
    expect(await eventKinds(input.investigation_id)).toEqual(["CREATED", "SUPERSEDED"]);
    expect(await rowState(replacement.investigation_id)).toBe("1/1/OPEN:1");
    const link = await db.prepare("SELECT supersedes_id FROM investigation_ledger_head WHERE investigation_id=?1").bind(replacement.investigation_id).first<{ supersedes_id: string }>();
    expect(link?.supersedes_id).toBe(input.investigation_id);
    await invariant(input.investigation_id);
    await invariant(replacement.investigation_id);
  });
  it("divergent event-id reuse over D1 conflicts on append and supersede; exact store replay settles once", async () => {
    const ctx = context();
    const input = baseInput("t7");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("payload-d1-t7-re", DIGEST_C);
    const snap = await ctx.store.read(input.investigation_id);
    if (snap === null) throw new Error("missing ledger");
    const stamp = new Date().toISOString();
    const next: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 4, updated_at: stamp };
    const exact: LedgerEvent = { investigation_id: input.investigation_id, sequence: 2, event_id: "evt-d1-t7-re", kind: "CHECKPOINT", payload_handle_ref: "payload-d1-t7-re", payload_digest: DIGEST_C, actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
    const first = await ctx.store.append(next, 1, exact);
    expect(first.revision).toBe(2);
    expect(await ctx.store.append(next, 1, exact)).toEqual(first);
    expect(await rowState(input.investigation_id)).toBe("2/2/OPEN:2");
    const divergent: LedgerEvent = { ...exact, kind: "OBSERVED", payload_digest: DIGEST_D };
    ctx.digests.set("payload-d1-t7-div", DIGEST_D);
    expect(await codeOf(ctx.store.append(next, 1, divergent))).toBe("LEDGER_CONFLICT");
    expect(await rowState(input.investigation_id)).toBe("2/2/OPEN:2");
    const replacement = baseInput("t7r");
    seedAll(ctx, replacement);
    const settled = await ctx.service.supersede(input.investigation_id, 2, replacement, "post-exposure metric change", "principal-1");
    expect(settled.supersedes_id).toBe(input.investigation_id);
    expect(await ctx.service.supersede(input.investigation_id, 2, replacement, "post-exposure metric change", "principal-1")).toEqual(settled);
    expect(await codeOf(ctx.service.supersede(input.investigation_id, 2, replacement, "a different reason", "principal-1"))).toBe("LEDGER_CONFLICT");
    expect(await rowState(input.investigation_id)).toBe("3/3/SUPERSEDED:3");
    expect(await rowState(replacement.investigation_id)).toBe("1/1/OPEN:1");
    await invariant(input.investigation_id);
    await invariant(replacement.investigation_id);
  });
  // Test-isolation note: this matrix previously ran as a single `it` performing
  // 7 fence flips x 8 mutations = 56 sequential create/mutate/readback/invariant
  // cycles against the shared module-level Miniflare D1 instance. Under parallel CI
  // that single test exceeded the default timeout (unknown outcome per failure-model,
  // not a product failure) while staying green in isolation. It is split into one
  // `it` per mutation with identical assertions so each keeps its own timeout budget.
  // No timeout was raised and no assertion was weakened.
  describe("fence changes after preflight but before the D1 write deny every mutation with zero committed effect", () => {
    const good = { principal_ref: "principal-1", scope_snapshot_id: "scope-1", scope_snapshot_revision: 1, policy_generation: "policy-gen-1", policy_authority_ref: "policy-auth-1", deployment_generation: "deploy-gen-1", purge_revision: 0, scope_purge_revision: 0 };
    const dims: { code: string; apply: (fence: Record<string, unknown>) => void }[] = [
      { code: "LEDGER_PRINCIPAL_DENIED", apply: (fence) => { fence.principal_ref = "principal-evil"; } },
      { code: "LEDGER_SCOPE_FOREIGN", apply: (fence) => { fence.scope_snapshot_id = "scope-foreign"; } },
      { code: "LEDGER_SCOPE_FOREIGN", apply: (fence) => { fence.scope_snapshot_revision = 999; } },
      { code: "LEDGER_POLICY_STALE", apply: (fence) => { fence.policy_generation = "policy-stale"; } },
      { code: "LEDGER_POLICY_STALE", apply: (fence) => { fence.policy_authority_ref = "policy-auth-evil"; } },
      { code: "LEDGER_DEPLOYMENT_STALE", apply: (fence) => { fence.deployment_generation = "deploy-stale"; } },
      { code: "LEDGER_PURGE_STALE", apply: (fence) => { fence.purge_revision = 2; } },
    ];
    type Ctx = ReturnType<typeof context>;
    // Identity scope: the parent investigation id and every seed/event/idempotency
    // key below live in the module-shared Miniflare D1 instance across the 8 tests,
    // so each carries the mutation-name prefix. Only the fence-flip dimension loops
    // inside one `it`; the mutation under test is fixed per `it`.
    const mutationNames = ["checkpoint", "accept", "deviation", "observed", "close", "reopen", "supersede", "create"] as const;
    type MutationName = (typeof mutationNames)[number];
    const mutationNeeds: Record<MutationName, "open" | "closed" | "create"> = {
      checkpoint: "open", accept: "open", deviation: "open", observed: "open",
      close: "open", reopen: "closed", supersede: "open", create: "create",
    };
    async function runMutation(name: MutationName, c: Ctx, id: string, rev: number, tag: string): Promise<unknown> {
      const eventId = `evt-f-${tag}`;
      const payloadRef = `ph-f-${tag}`;
      switch (name) {
        case "checkpoint": return c.service.checkpoint(id, rev, 3, "principal-1", eventId, payloadRef, DIGEST_C);
        case "accept": return c.service.acceptObligation(id, rev, "obl-1", "verifier-a", "metric-1", "verifier-a", eventId, payloadRef, DIGEST_C);
        case "deviation": return c.service.recordDeviation(id, rev, "obl-1", "principal-1", eventId, payloadRef, DIGEST_C, "note");
        case "observed": return c.service.recordObserved(id, rev, "x", "y", "z", "principal-1", eventId, payloadRef, DIGEST_C);
        case "close": return c.service.close(id, rev, "principal-1", eventId, payloadRef, DIGEST_C);
        case "reopen": return c.service.reopen(id, rev, "principal-1", eventId, payloadRef, DIGEST_C);
        case "supersede": {
          const r = baseInput(`fr-${tag}`, { payload_handle_ref: `ph-fr-${tag}`, portfolio_ref: `pf-fr-${tag}` });
          c.digests.set(r.payload_handle_ref, r.payload_digest);
          c.digests.set(r.portfolio_ref, r.input_digest);
          return c.service.supersede(id, rev, r, "fenced", "principal-1");
        }
        case "create": {
          const r = baseInput(`fc-${tag}`, { investigation_id: id, idempotency_key: `idem-fc-${tag}`, event_id: `evt-fc-${tag}`, payload_handle_ref: payloadRef, portfolio_ref: `pf-f-${tag}` });
          c.digests.set(r.payload_handle_ref, r.payload_digest);
          c.digests.set(r.portfolio_ref, r.input_digest);
          return c.service.create(r);
        }
      }
    }
    for (const name of mutationNames) {
      it(`${name} denies every fence flip with zero committed effect`, async () => {
        const needs = mutationNeeds[name];
        let tag = 0;
        for (const dim of dims) {
          tag += 1;
          const key = `${name}-${tag}`;
          const c = context();
          const id = `inv-d1-flip-${key}`;
          c.digests.set(`ph-f-${key}`, DIGEST_C);
          if (needs !== "create") {
            const input = baseInput(`flip-${key}`, { investigation_id: id, idempotency_key: `idem-d1-flip-${key}`, event_id: `evt-d1-flip-${key}`, payload_handle_ref: `ph-seed-${key}`, portfolio_ref: `pf-seed-${key}` });
            c.digests.set(input.payload_handle_ref, input.payload_digest);
            c.digests.set(input.portfolio_ref, input.input_digest);
            await c.service.create(input);
            if (needs === "closed") await c.service.close(id, 1, "principal-1", `evt-fc-${key}`, `ph-f-${key}`, DIGEST_C);
          }
          const before = await rowState(id);
          const evil = { ...good };
          dim.apply(evil as unknown as Record<string, unknown>);
          let calls = 0;
          c.fences.current = async () => ({ ...(calls++ === 0 ? good : evil) });
          const rev = needs === "closed" ? 2 : 1;
          expect(await codeOf(runMutation(name, c, id, rev, key)), `${name}/${dim.code}`).toBe(dim.code);
          expect(await rowState(id), `${name}/${dim.code} rows`).toBe(before);
          await invariant(id);
        }
      });
    }
  });
  it("d1 authority mutations after preflight abort the batch with zero effect", async () => {
    const d = db as unknown as LedgerD1Database;
    const cases: { name: string; code: string; mutate: () => Promise<void> }[] = [
      { name: "scope-invalidated", code: "LEDGER_SCOPE_FOREIGN", mutate: async () => { await d.batch([d.prepare("UPDATE scope_snapshot SET invalidated_at = '2026-09-06T00:00:00.000Z', invalidation_reason = 'TEST' WHERE snapshot_id = 'scope-1' AND revision = 1").bind()]); } },
      { name: "grant-revoked", code: "LEDGER_PRINCIPAL_DENIED", mutate: async () => { await d.batch([d.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = 'scope-1' AND snapshot_revision = 1 AND principal_ref = 'principal-1'").bind()]); } },
      { name: "policy-rotated", code: "LEDGER_POLICY_STALE", mutate: async () => { await d.batch([d.prepare("UPDATE investigation_current_policy SET policy_generation = 'policy-stale' WHERE policy_generation = 'policy-gen-1'").bind()]); } },
      { name: "policy-ref", code: "LEDGER_POLICY_STALE", mutate: async () => { await d.batch([d.prepare("UPDATE investigation_current_policy SET policy_authority_ref = 'policy-auth-evil' WHERE policy_generation = 'policy-gen-1'").bind()]); } },
      { name: "deployment-rotated", code: "LEDGER_DEPLOYMENT_STALE", mutate: async () => { await d.batch([d.prepare("UPDATE investigation_current_deployment SET deployment_generation = 'deploy-stale' WHERE deployment_generation = 'deploy-gen-1'").bind()]); } },
      { name: "global-purge", code: "LEDGER_PURGE_STALE", mutate: async () => { await d.batch([d.prepare("INSERT INTO purge_ledger (erasure_id, non_revealing_subject_digest, disposition, receipt_ref, created_at) VALUES (?1,?2,'COMPLETE',?3,'2026-09-06T00:00:00.000Z')").bind(`e-test-${n}`, "f".repeat(64), `r-test-${n}`)]); } },
      { name: "epoch-bumped", code: "LEDGER_STALE_HEAD", mutate: async () => { await d.batch([d.prepare("UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1").bind()]); } },
    ];
    let n = 0;
    for (const item of cases) {
      n += 1;
      const ctx = context();
      const input = baseInput(`auth-${n}`, { payload_handle_ref: `ph-auth-${n}`, portfolio_ref: `pf-auth-${n}` });
      ctx.digests.set(input.payload_handle_ref, input.payload_digest);
      ctx.digests.set(input.portfolio_ref, input.input_digest);
      await ctx.service.create(input);
      const before = await rowState(input.investigation_id);
      ctx.digests.set(`ph-auth-mut-${n}`, DIGEST_C);
      const hooked = interceptBatch(d, async (statements) => { if (statements.length === 1) await item.mutate(); });
      const hookedStore = createD1InvestigationLedgerStore(hooked);
      const hookedService = createInvestigationLedgerService(hookedStore, ctx.fences, ctx.handles, () => new Date().toISOString());
      try {
      expect(await codeOf(hookedService.checkpoint(input.investigation_id, 1, 3, "principal-1", `evt-auth-${n}`, `ph-auth-mut-${n}`, DIGEST_C)), item.name).toBe(item.code);
      expect(await rowState(input.investigation_id), `${item.name} rows`).toBe(before);
      await invariant(input.investigation_id);
      } finally {
      await d.batch([d.prepare("UPDATE scope_snapshot SET invalidated_at = NULL, invalidation_reason = NULL WHERE snapshot_id = 'scope-1'").bind()]);
      await d.batch([d.prepare("UPDATE scope_access_grant SET state = 'ACTIVE' WHERE snapshot_id = 'scope-1'").bind()]);
      await d.batch([d.prepare("UPDATE investigation_current_policy SET policy_generation = 'policy-gen-1', policy_authority_ref = 'policy-auth-1' WHERE state = 'ACTIVE'").bind()]);
      await d.batch([d.prepare("UPDATE investigation_current_deployment SET deployment_generation = 'deploy-gen-1' WHERE state = 'ACTIVE'").bind()]);
      await d.batch([d.prepare("DELETE FROM purge_ledger").bind()]);
      }
    }
  });
  it("direct unguarded head and event writes fail via triggers", async () => {
    const ctx = context();
    const input = baseInput("noguard");
    seedAll(ctx, input);
    await ctx.service.create(input);
    const d = db as unknown as LedgerD1Database;
    await expect(d.prepare("UPDATE investigation_ledger_head SET revision = 99 WHERE investigation_id = ?1").bind(input.investigation_id).run()).rejects.toThrow();
    await expect(d.prepare("INSERT INTO investigation_ledger_event (investigation_id, sequence, event_id, kind, payload_handle_ref, payload_digest, actor_ref, verifier_ref, created_at) VALUES (?1,99,'evt-noguard','CHECKPOINT','ph-x',?2,'principal-1',NULL,'2026-09-05T01:00:00.000Z')").bind(input.investigation_id, DIGEST_C).run()).rejects.toThrow();
    await expect(d.prepare("INSERT INTO investigation_ledger_head (investigation_id, revision, protocol_version, goal, scope_snapshot_id, scope_snapshot_revision, evidence_grade, lane, lane_registrations_json, obligations_json, hypotheses_json, portfolio_ref, debt_refs_json, checkpoint_head, principal_ref, input_digest, policy_generation, policy_authority_ref, deployment_generation, idempotency_key, model_profile_ref, observed_execution, observed_fidelity, observed_assurance, status, supersedes_id, supersession_reason, event_head, created_at, updated_at) VALUES ('inv-noguard-direct',1,'eliotr.investigation.v1','g','scope-1',1,'E2','confirmatory','[]','[]','[]','pf','[]',0,'principal-1',?1,'policy-gen-1','policy-auth-1','deploy-gen-1','idem-noguard','model-1',NULL,NULL,NULL,'OPEN',NULL,NULL,1,'2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z')").bind(DIGEST_A).run()).rejects.toThrow();
    expect(await rowState(input.investigation_id)).toBe("1/1/OPEN:1");
    await invariant(input.investigation_id);
  });
  it("same event id divergence on every event field conflicts with identical db state", async () => {
    const ctx = context();
    const input = baseInput("divall");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("ph-div-base", DIGEST_C);
    const snap = await ctx.store.read(input.investigation_id);
    if (snap === null) throw new Error("missing ledger");
    const stamp = new Date().toISOString();
    const base: LedgerEvent = { investigation_id: input.investigation_id, sequence: 2, event_id: "evt-div-all", kind: "CHECKPOINT", payload_handle_ref: "ph-div-base", payload_digest: DIGEST_C, actor_ref: "principal-1", verifier_ref: null, created_at: stamp };
    const next: LedgerHead = { ...snap.head, revision: 2, event_head: 2, checkpoint_head: 4, updated_at: stamp };
    await ctx.store.append(next, 1, base);
    expect(await rowState(input.investigation_id)).toBe("2/2/OPEN:2");
    const variants: { name: string; event: LedgerEvent }[] = [
      { name: "kind", event: { ...base, kind: "OBSERVED" } },
      { name: "payload_handle", event: { ...base, payload_handle_ref: "ph-div-other" } },
      { name: "payload_digest", event: { ...base, payload_digest: DIGEST_D } },
      { name: "actor", event: { ...base, actor_ref: "actor-evil" } },
      { name: "verifier", event: { ...base, verifier_ref: "verifier-a" } },
      { name: "created_at", event: { ...base, created_at: "2026-09-05T02:00:00.000Z" } },
      { name: "sequence", event: { ...base, sequence: 3 } },
      { name: "investigation", event: { ...base, investigation_id: "inv-d1-other" } },
    ];
    for (const v of variants) {
      expect(await codeOf(ctx.store.append(next, 1, v.event)), v.name).toBe("LEDGER_CONFLICT");
      expect(await rowState(input.investigation_id), `${v.name} rows`).toBe("2/2/OPEN:2");
    }
    expect(await codeOf(ctx.store.append({ ...next, checkpoint_head: 99 }, 1, base))).toBe("LEDGER_CONFLICT");
    expect(await rowState(input.investigation_id)).toBe("2/2/OPEN:2");
    await invariant(input.investigation_id);
  });
  it("concurrent divergent appends elect one winner and concurrent exact replay settles once", async () => {
    const ctx = context();
    const input = baseInput("conc");
    seedAll(ctx, input);
    await ctx.service.create(input);
    ctx.digests.set("ph-conc-a", DIGEST_C);
    ctx.digests.set("ph-conc-b", DIGEST_D);
    const a = ctx.service.checkpoint(input.investigation_id, 1, 7, "principal-1", "evt-conc-a", "ph-conc-a", DIGEST_C);
    const b = ctx.service.checkpoint(input.investigation_id, 1, 8, "principal-1", "evt-conc-b", "ph-conc-b", DIGEST_D);
    const outcomes = await Promise.allSettled([a, b]);
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(1);
    expect(outcomes.filter((o) => o.status === "rejected").length).toBe(1);
    expect(await rowState(input.investigation_id)).toMatch(/2\/2\/OPEN:2/);
    await invariant(input.investigation_id);
  });
  it("supersede middle-effect failure rolls back old head mark and replacement", async () => {
    const ctx = context();
    const input = baseInput("midrb");
    seedAll(ctx, input);
    await ctx.service.create(input);
    const replacement = baseInput("midrbr");
    seedAll(ctx, replacement);
    let blocked = false;
    const racedDb = interceptBatch(db as unknown as LedgerD1Database, async (statements) => {
      if (statements.length === 1 && !blocked) {
        blocked = true;
        const rival = baseInput("midrbr", { idempotency_key: "idem-midrbr-rival", event_id: "evt-midrbr-rival", payload_handle_ref: "ph-midrbr-rival", portfolio_ref: "pf-midrbr-rival" });
        ctx.digests.set(rival.payload_handle_ref, rival.payload_digest);
        ctx.digests.set(rival.portfolio_ref, rival.input_digest);
        await ctx.service.create(rival);
      }
    });
    const raced = createInvestigationLedgerService(createD1InvestigationLedgerStore(racedDb), ctx.fences, ctx.handles, () => new Date().toISOString());
    expect(await codeOf(raced.supersede(input.investigation_id, 1, replacement, "raced replace", "principal-1"))).toMatch(/LEDGER_(CONFLICT|STALE_HEAD)/);
    expect(blocked).toBe(true);
    expect(await rowState(input.investigation_id)).toBe("1/1/OPEN:1");
    expect(await eventKinds(input.investigation_id)).toEqual(["CREATED"]);
    await invariant(input.investigation_id);
  });
});
