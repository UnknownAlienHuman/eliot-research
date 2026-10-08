// @ts-expect-error - node:sqlite runtime types ship with Node 22.13+, not @types/node
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import {
  createD1InvestigationLedgerStore, createInvestigationLedgerService,
  type CreateLedgerInput, type LedgerD1Database,
} from "./index.js";
import { LedgerError } from "./index.js";

declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true; query: string; import: string }): Record<string, string>;
  }
}

// Committed Core migration stream is the only schema authority; no in-test DDL.
export const CORE_MIGRATIONS = import.meta.glob("../../../infra/d1/core/migrations/*.sql", { eager: true, query: "?raw", import: "default" });

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
export function setup(beforeQuestionMigration = false) {
  const raw = new DatabaseSync(":memory:");
  for (const key of Object.keys(CORE_MIGRATIONS).sort()) {
    if (beforeQuestionMigration && key.endsWith("/0069_research_question_envelopes.sql")) continue;
    raw.exec(CORE_MIGRATIONS[key] as string);
  }
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
export function baseInput(overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput {
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
export function nextInput(tag: string, overrides: Partial<CreateLedgerInput> = {}): CreateLedgerInput { return baseInput({ investigation_id: `inv-${tag}`, idempotency_key: `idem-${tag}`, event_id: `evt-${tag}`, ...overrides }); }
export function seedHandles(ctx: ReturnType<typeof setup>, input: CreateLedgerInput): void { ctx.digests.set(input.payload_handle_ref, input.payload_digest); ctx.digests.set(input.portfolio_ref, input.input_digest); }
export async function invariant(ctx: ReturnType<typeof setup>, id: string): Promise<void> {
  const head = ctx.raw.prepare("SELECT revision, event_head FROM investigation_ledger_head WHERE investigation_id=?").get(id) as unknown as { revision: number; event_head: number } | undefined;
  if (head === undefined) return;
  const rows = ctx.raw.prepare("SELECT sequence FROM investigation_ledger_event WHERE investigation_id=? ORDER BY sequence ASC").all(id) as unknown as { sequence: number }[];
  expect(rows.length).toBe(head.event_head);
  expect(rows.map((row) => row.sequence)).toEqual(rows.map((_, index) => index + 1));
}
export async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  throw new Error("expected LedgerError");
}
export function eventCount(ctx: ReturnType<typeof setup>, id: string): number { return (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE investigation_id=?").get(id) as unknown as { n: number }).n; }
export function headCount(ctx: ReturnType<typeof setup>): number { return (ctx.raw.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_head").get() as unknown as { n: number }).n; }
