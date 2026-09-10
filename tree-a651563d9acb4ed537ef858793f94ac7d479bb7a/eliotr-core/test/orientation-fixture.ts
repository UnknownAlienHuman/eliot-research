import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect } from "vitest";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { SourceAdmissionDecision } from "@eliotr/contracts";
import type { QueryResult } from "@eliotr/interfaces";
import type { RetrievalTrace } from "@eliotr/contracts";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import type { AccessVerifier } from "@eliotr/platform-cloudflare";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";

interface Migration { name: string; queries: string[]; }
export const runtime = env as unknown as Env & { CORE_MIGRATIONS: Migration[]; SEARCH_MIGRATIONS: Migration[] };
export const db = runtime.CORE_DB;
export const principal = "orientation-owner";
export const credential = "credential-v1";
const A = "a".repeat(64); const B = "b".repeat(64);
const now = new Date().toISOString();
const expiry = new Date(Date.now() + 86400000).toISOString();
export const verifier = (who = principal, method: "cloudflare_access" | "service_token" = "cloudflare_access"): AccessVerifier => ({
  async verify() { return { principal_ref: who, credential_generation: credential, authentication_method: method, expires_at: expiry }; },
});
export const insert = async (table: string, fields: Record<string, string | number | null>) => db.prepare(
  `INSERT INTO ${table} (${Object.keys(fields).join(",")}) VALUES (${Object.values(fields).map((_, i) => `?${i + 1}`).join(",")})`
).bind(...Object.values(fields)).run();
export const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>("n");

export async function seedSource(id: string, withPolicy = true) {
  const namespace = `ns-${id}`; const ref = `rev-${id}`;
  await insert("source_namespace_ownership", { source_namespace_id: namespace, ownership_record_revision: 1,
    owner_system_id: "eliotr", owner_incarnation_ref: "incarnation-1", source_owner_generation: "owner-gen-1",
    source_admission_policy_revision: 1, status: "ACTIVE", created_at: now });
  await insert("source", { source_id: id, source_namespace_id: namespace, source_owner_system_id: "eliotr",
    source_owner_generation: "owner-gen-1", ownership_mode: "immutable_import", kind: "document", title: `Source ${id}`,
    default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "residency-1", source_class: "document",
    license_policy_ref: "license-1", default_retention_policy_id: "retention-1", head_rev: null, created_at: now });
  await insert("source_revision", { source_revision_ref: ref, source_id: id, source_owner_generation: "owner-gen-1",
    content_sha256: A, object_residency_key_digest: B, normalized_artifact_ref: `normalized/${id}`, captured_at: now,
    quality_state: "standard", purge_state: "LIVE", source_view_ref: `view-${id}`, admitted_at: now });
  await db.prepare("UPDATE source SET head_rev=?2 WHERE source_id=?1").bind(id, ref).run();
  await insert("bundle_ingest_operation", { operation_id: `op-${id}`, principal_ref: principal, origin_authentication_receipt_ref: "auth-1",
    idempotency_key: `ingest-${id}`, input_fingerprint: A, manifest_sha256: A, manifest_json: "{}", file_hashes_json: "{}", total_bytes: 10,
    source_namespace_id: namespace, owner_system_id: "eliotr", source_owner_generation: "owner-gen-1", source_revision_ref: ref,
    source_id: id, residency_key_json: "{}", residency_key_digest: B, policy_revision: 1, policy_snapshot_json: "{}",
    policy_snapshot_sha256: A, candidate_id: `candidate-${id}`, state: "COMMITTED", created_at: now, updated_at: now, expires_at: expiry });
  const decision: SourceAdmissionDecision = { source_namespace_id: namespace, owner_system_id: "eliotr", source_owner_generation: "owner-gen-1",
    source_revision_ref: ref, origin_authentication_receipt_ref: "auth-1", source_class: "document", assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", object_residency_key_digest: B, allowed_use: ["research"],
    disclosure_ceiling: "private", license_policy_ref: "license-1", decision: "ADMITTED", reason_codes: [], decision_receipt_ref: `decision-${id}` };
  const { allowed_use: _allowed, reason_codes: _reasons, expires_at: _expiresAt, ...scalars } = decision;
  await insert("source_admission_decision", { ...scalars, operation_id: `op-${id}`, allowed_use_json: '["research"]', reason_codes_json: "[]",
    decision_json: canonicalEvidenceJson(decision), decision_sha256: await evidenceSha256(decision), created_at: now });
  if (withPolicy) await insert("scope_read_policy", { source_namespace_id: namespace, principal_ref: principal, client_class: "owner_pwa",
    policy_ref: `read-${id}`, generation: 1, allowed_use_json: '["research"]', disclosure_ceiling: "private", state: "ACTIVE",
    expires_at: expiry, created_at: now });
}
export function request(id: string, fields: Record<string, unknown> = {}, key = `request-${id}`) {
  return new Request("https://research.example/api/v1/research/orient", { method: "POST", headers: {
    "content-type": "application/json", "idempotency-key": key,
  }, body: JSON.stringify({ query: "Source", product: "ORIENT", scope_expression: { kind: "SELECTED_SOURCES", source_ids: [id] },
    literals: [], evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: 8, ...fields }) });
}
export const run = (req: Request, auth = verifier()) => handleHttp(req, runtime, {} as ExecutionContext, { accessVerifier: auth });
export async function body<T = QueryResult & RetrievalTrace>(response: Response) {
  const value = await response.json();
  return value as { data: T; code?: string; };
}

export async function setupOrientationDatabase() {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
}


export async function successful(req: Request) {
  const response = await run(req); const value = await body(response);
  expect(response.status, JSON.stringify(value)).toBe(200); return value.data;
}
export function observeDatabase(hook: (sql: string, phase: "before" | "after") => Promise<void>): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await hook(sql, "before"); const result: unknown = await Reflect.apply(value, target, args);
        await hook(sql, "after"); return result;
      };
    } });
    originals.set(proxy, statement); return proxy;
  };
  return new Proxy(db, { get(target, key) {
    if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await hook("BATCH", "before");
      const result = await target.batch(statements.map((item) => originals.get(item) ?? item));
      await hook("BATCH", "after"); return result;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
