import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1InvestigationLedgerStore,
  createInvestigationLedgerService,
  type CreateLedgerInput,
  type LedgerD1Database,
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
    policy_generation: "policy-gen-1", deployment_generation: "deploy-gen-1",
    purge_revision: 0, scope_purge_revision: 0,
  };
  const fences = { current: async () => ({ ...fence }) };
  const store = createD1InvestigationLedgerStore(db as unknown as LedgerD1Database);
  const service = createInvestigationLedgerService(store, fences, handles, () => "2026-09-05T00:00:00.000Z");
  return { digests, handles, fence, fences, store, service };
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
    created_at: "2026-09-05T00:00:00.000Z", ...overrides,
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

beforeEach(async () => {
  await applyD1Migrations(db as never, runtime.CORE_MIGRATIONS);
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
    const restarted = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), ctx.fences, ctx.handles, () => "2026-09-05T01:00:00.000Z");
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
    const other = createInvestigationLedgerService(createD1InvestigationLedgerStore(db as unknown as LedgerD1Database), ctx.fences, ctx.handles, () => "2026-09-05T02:00:00.000Z");
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
});
