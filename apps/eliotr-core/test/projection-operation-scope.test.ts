/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { DeliveryMessage } from "@eliotr/platform-cloudflare";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority, createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import {
  AI_SEARCH_PRIMARY_NAMESPACE, AI_SEARCH_PRIMARY_PROJECTION_PROFILE, createD1ProjectionAuthority,
  createProjectionDeliveryHandler, resolveManagedTargetSelectionV2, type ManagedTargetSelectionV2,
} from "@eliotr/cloudflare-projection";
import { createNativeTargetRegistryFixture } from "./managed-target-registry-fixture.js";
import { bindProjectionOperationOwnerScope, createProjectionOperationScopeResolver } from "../src/projection-operation-scope.js";
import { createManagedSearchProductOptInService } from "../src/managed-target-assignment.js";
import type { Env } from "../src/env.js";

// Core's error barrel imports unrelated Worker/DO startup; retain its actual class.
vi.mock("../src/http-errors.js", async () => import("@eliotr/cloudflare-http-protocol/http-request-error.js"));

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function nativeD1(database: DatabaseSync): D1Database {
  function statement(sql: string, values: readonly SQLInputValue[] = []): D1PreparedStatement {
    const prepared = () => database.prepare(sql);
    const bindings = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
    return {
      bind: (...bound: SQLInputValue[]) => statement(sql, bound),
      async first(column?: string) {
        const row = (/\?\d+/u.test(sql) ? prepared().get(bindings) : prepared().get(...values)) ?? null;
        return column === undefined ? row : row?.[column] ?? null;
      },
      async all() {
        const results = /\?\d+/u.test(sql) ? prepared().all(bindings) : prepared().all(...values);
        return { success: true, results, meta: { changes: Number(database.prepare("SELECT changes() AS n").get()?.n) } };
      },
      async run() {
        const result = /\?\d+/u.test(sql) ? prepared().run(bindings) : prepared().run(...values);
        return { success: true, results: [], meta: { changes: Number(result.changes) } };
      },
    } as unknown as D1PreparedStatement;
  }
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.all());
        database.exec("COMMIT");
        return results;
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
}

function migrated(kind: "core" | "search") {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  const migrations = new URL(`../../../infra/d1/${kind}/migrations/`, import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    sql.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  return { sql, db: nativeD1(sql) };
}

async function world() {
  const { sql, db } = migrated("core");
  const search = migrated("search");
  const checkedAt = sql.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()?.now;
  if (typeof checkedAt !== "string") throw new Error("fixture D1 time unavailable");
  const expiry = new Date(Date.parse(checkedAt) + 600_000).toISOString();
  const owner: AuthenticatedRequestContext = {
    request: new Request("https://research.example/owner"), principal_ref: "owner-1", client_class: "owner_pwa",
    credential_generation: "credential-1", trace_id: "projection-scope-fixture",
    access: { principal_ref: "owner-1", credential_generation: "credential-1", authentication_method: "cloudflare_access", expires_at: expiry },
  };
  const insert = (table: string, fields: Record<string, string | number | null>) => {
    sql.prepare(`INSERT INTO ${table} (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map(() => "?").join(",")})`)
      .run(...Object.values(fields));
  };
  for (const id of ["one", "two"]) {
    insert("source_namespace_ownership", { source_namespace_id: `ns-${id}`, ownership_record_revision: 1,
      owner_system_id: "eliotr", owner_incarnation_ref: "incarnation-1", source_owner_generation: "owner-generation-1",
      source_admission_policy_revision: 1, status: "ACTIVE", created_at: checkedAt });
    insert("source", { source_id: id, source_namespace_id: `ns-${id}`, source_owner_system_id: "eliotr",
      source_owner_generation: "owner-generation-1", ownership_mode: "immutable_import", kind: "document", title: id,
      default_storage_policy: "NORMALIZED_CLOUD_ONLY", default_residency_profile_id: "residency-1", source_class: "document",
      license_policy_ref: "license-1", default_retention_policy_id: "retention-1", head_rev: null, created_at: checkedAt });
    insert("source_revision", { source_revision_ref: `revision-${id}`, source_id: id, source_owner_generation: "owner-generation-1",
      content_sha256: "a".repeat(64), object_residency_key_digest: "b".repeat(64), normalized_artifact_ref: `normalized/${id}`,
      captured_at: checkedAt, quality_state: "standard", purge_state: "LIVE", source_view_ref: `view-${id}`, admitted_at: checkedAt });
    sql.prepare("UPDATE source SET head_rev=? WHERE source_id=?").run(`revision-${id}`, id);
    insert("bundle_ingest_operation", { operation_id: `ingest-${id}`, principal_ref: "owner-1", origin_authentication_receipt_ref: "credential-1",
      idempotency_key: `ingest-${id}`, input_fingerprint: "a".repeat(64), manifest_sha256: "a".repeat(64), manifest_json: "{}",
      file_hashes_json: "{}", total_bytes: 1, source_namespace_id: `ns-${id}`, owner_system_id: "eliotr", source_owner_generation: "owner-generation-1",
      source_revision_ref: `revision-${id}`, source_id: id, residency_key_json: "{}", residency_key_digest: "b".repeat(64), policy_revision: 1,
      policy_snapshot_json: "{}", policy_snapshot_sha256: "a".repeat(64), candidate_id: `candidate-${id}`, state: "COMMITTED",
      created_at: checkedAt, updated_at: checkedAt, expires_at: expiry });
    const decision = { source_namespace_id: `ns-${id}`, owner_system_id: "eliotr", source_owner_generation: "owner-generation-1",
      source_revision_ref: `revision-${id}`, origin_authentication_receipt_ref: "credential-1", source_class: "document", assurance_ceiling: "QUALIFIED",
      instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", object_residency_key_digest: "b".repeat(64), allowed_use: ["research"],
      disclosure_ceiling: "private", license_policy_ref: "license-1", decision: "ADMITTED", reason_codes: [], decision_receipt_ref: `decision-${id}` };
    const { allowed_use: _uses, reason_codes: _reasons, ...columns } = decision;
    insert("source_admission_decision", { ...columns, operation_id: `ingest-${id}`, allowed_use_json: '["research"]', reason_codes_json: "[]",
      decision_json: canonicalEvidenceJson(decision), decision_sha256: await evidenceSha256(decision), created_at: checkedAt });
    insert("scope_read_policy", { source_namespace_id: `ns-${id}`, principal_ref: "owner-1", client_class: "owner_pwa", policy_ref: `policy-${id}`,
      generation: 1, allowed_use_json: '["research"]', disclosure_ceiling: "private", state: "ACTIVE", expires_at: expiry, created_at: checkedAt });
    insert("source_admission_policy", { source_namespace_id: `ns-${id}`, revision: 1,
      authorized_principal_refs_json: '["owner-1"]', allowed_ownership_modes_json: '["immutable_import"]',
      source_class: "document", assurance_ceiling: "QUALIFIED", instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
      allowed_use_json: '["research"]', disclosure_ceiling: "private", license_policy_ref: "license-1", default_storage_policy: "NORMALIZED_CLOUD_ONLY",
      default_residency_profile_id: "residency-1", default_retention_policy_id: "retention-1", minimum_quality_state: "standard", created_at: checkedAt });
  }
  const project = await createProjectOwnerService({ database: db, deployment_generation: "deployment-1" }).create(owner, {
    idempotency_key: "projection-scope-project", title: "Projection scope fixture", source_ids: ["one", "two"],
  });
  const forbiddenEffect = vi.fn((): never => { throw new Error("fixture cannot call provider or unrelated runtime effects"); });
  const env: Env = {
    CORE_DB: db, DEPLOYMENT_GENERATION: "deployment-1", ENVIRONMENT: "development",
    AI_GATEWAY_REASONING_URL: "https://unused.invalid", AI_GATEWAY_RETRIEVAL_URL: "https://unused.invalid",
    get SEARCH_DB(): never { return forbiddenEffect(); }, get AI_SEARCH(): never { return forbiddenEffect(); },
    get EVIDENCE_BUCKET(): never { return forbiddenEffect(); }, get WORK_BUCKET(): never { return forbiddenEffect(); },
    get JOB_QUEUE(): never { return forbiddenEffect(); }, get RESEARCH_SESSION(): never { return forbiddenEffect(); },
    get RESEARCH_WORKFLOW(): never { return forbiddenEffect(); }, get METRICS(): never { return forbiddenEffect(); }, get ASSETS(): never { return forbiddenEffect(); },
  };
  await createManagedSearchProductOptInService(env, owner, project.project_ref.id).decide({ decision: "ENABLED", expected_head_revision: 0 });
  const d1Now = () => {
    const value = sql.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get()?.now;
    if (typeof value !== "string") throw new Error("fresh fixture D1 time unavailable");
    return Date.parse(value);
  };
  const authority = createOwnerScopeAuthority(db, { principal_ref: "owner-1", client_class: "owner_pwa", credential_generation: "credential-1" }, d1Now);
  const scopes = createD1ScopeService(db, authority, { now: d1Now });
  const snapshot = await scopes.freeze({ kind: "PROJECT", project_id: project.project_ref.id }, "credential-1");
  await authority.grant(snapshot);
  insert("operation_intent", { intent_id: "projection-intent", revision: 1, operation_kind: "PROJECTION", principal_ref: "owner-1",
    idempotency_key: "projection-key", payload_ref: "revision-one", policy_decision_ref: "decision-one", created_at: checkedAt });
  insert("outbox", { outbox_id: "projection-outbox", intent_id: "projection-intent", intent_revision: 1, topic: "source.revision.admitted",
    payload_ref: "revision-one", payload_sha256: "a".repeat(64), state: "SENT", attempts: 1, next_attempt_at: Date.parse(checkedAt),
    created_at: checkedAt, updated_at: checkedAt });
  const message: DeliveryMessage = { protocol: "eliotr.delivery.message.v1", message_id: "projection-outbox:1", created_at_ms: Date.parse(checkedAt),
    outbox_id: "projection-outbox", topic: "source.revision.admitted", payload_ref: "revision-one",
    payload_sha256: "a".repeat(64), idempotency_key: "projection-key", outbox_attempt: 1 };
  await createProjectionDeliveryHandler(db)(message, { message_id: message.message_id, idempotency_key: message.idempotency_key,
    topic: message.topic, attempt: 1 });
  const context = await createD1ProjectionAuthority({ database: db }).load(message);
  const objects = new Map<string, string>();
  const bucket = {
    async put(key: string, bytes: string) { objects.set(key, bytes); },
    async get(key: string) { const bytes = objects.get(key); return bytes === undefined ? null : { json: async () => JSON.parse(bytes) as unknown }; },
  } as unknown as R2Bucket;
  // Existing controlled registry donor: local qualification receipts only;
  // no provider proof or uploaded item is claimed by this scope fixture.
  const targets = createNativeTargetRegistryFixture(search.db, bucket);
  await targets.declare(AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
  await targets.registry.qualify(AI_SEARCH_PRIMARY_NAMESPACE, { generation: AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation });
  await targets.registry.promote(AI_SEARCH_PRIMARY_NAMESPACE, {
    expected_active_head_generation: null, target_generation: AI_SEARCH_PRIMARY_PROJECTION_PROFILE.generation, promoted_at: new Date().toISOString(),
  });
  const selections: readonly ManagedTargetSelectionV2[] = [await resolveManagedTargetSelectionV2(search.db, "ACTIVE")];
  const resolve = createProjectionOperationScopeResolver({ database: db, search_database: search.db, resolve_selections: async () => selections });
  const composed = createD1ProjectionAuthority({ database: db, resolve_project_copy_scopes_v2: resolve });
  const bind = () => bindProjectionOperationOwnerScope({ database: db, context, owner,
    scope_snapshot_ref: { id: snapshot.snapshot_id, revision: snapshot.revision } });
  return { sql, db, search, owner, context, message, snapshot, scopes, selections, resolve, composed, bind, targets, project, forbiddenEffect };
}

describe("projection operation owner scope composition", () => {
  it("loads a real persisted operation-bound owner snapshot into source-specific ACTIVE and SHADOW copy scopes", async () => {
    const w = await world();
    expect(w.context).not.toHaveProperty("project_copy_scopes_v2");
    await expect(w.composed.load(w.message)).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    await w.bind();
    await w.bind();
    const active = await w.composed.load(w.message);
    expect(active.project_copy_scopes_v2).toMatchObject([{
      scope_snapshot_id: w.snapshot.snapshot_id, scope_snapshot_revision: w.snapshot.revision, scope_snapshot_digest: w.snapshot.digest,
      target_selection: { purpose: "ACTIVE" }, copies: [{ source_revision_ref: "revision-one", membership_identity_version: 2 }],
    }]);
    expect(w.snapshot.member_source_revision_refs).toEqual(["revision-one", "revision-two"]);
    expect(active.project_copy_scopes_v2?.[0]?.copies).toHaveLength(1);
    const b = "projection-scope-shadow-b";
    await w.targets.declare({ ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE, generation: b });
    const shadow = await resolveManagedTargetSelectionV2(w.search.db, "SHADOW", b);
    const resolver = createProjectionOperationScopeResolver({ database: w.db, search_database: w.search.db,
      resolve_selections: async () => [shadow] });
    expect(await resolver(w.context)).toMatchObject([{ target_selection: shadow, copies: [{ source_revision_ref: "revision-one" }] }]);
    expect(w.forbiddenEffect).not.toHaveBeenCalled();
  });

  it.each(["grant", "policy", "membership", "snapshot", "selection"] as const)("rejects changed %s authority before returning an upload scope", async kind => {
    const w = await world();
    await w.bind();
    if (kind === "grant") w.sql.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
    if (kind === "policy") w.sql.prepare("UPDATE scope_read_policy SET state='REVOKED'").run();
    if (kind === "membership") w.sql.prepare("UPDATE project SET membership_generation=membership_generation+1 WHERE project_id=?").run(w.project.project_ref.id);
    if (kind === "snapshot") w.sql.prepare("UPDATE scope_snapshot SET invalidated_at=?,invalidation_reason='TEST' WHERE snapshot_id=?").run(new Date().toISOString(), w.snapshot.snapshot_id);
    if (kind === "selection") await w.targets.declare({ ...AI_SEARCH_PRIMARY_PROJECTION_PROFILE, generation: "registry-advanced" });
    const code = kind === "grant" ? "RETRIEVAL_AUTHORITY_STALE" :
      kind === "membership" ? "SCOPE_SNAPSHOT_STALE" : "PROJECTION_AUTHORITY_CONFLICT";
    await expect(w.composed.load(w.message)).rejects.toMatchObject({ code });
    expect(w.forbiddenEffect).not.toHaveBeenCalled();
  });

  it("rejects foreign intent/owner bindings and never overwrites another job checkpoint", async () => {
    const w = await world();
    await expect(bindProjectionOperationOwnerScope({ database: w.db, context: { ...w.context, intent_ref: { id: "foreign", revision: 1 } },
      owner: w.owner, scope_snapshot_ref: { id: w.snapshot.snapshot_id, revision: w.snapshot.revision } }))
      .rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    await expect(bindProjectionOperationOwnerScope({ database: w.db, context: w.context,
      owner: { ...w.owner, principal_ref: "foreign-owner" }, scope_snapshot_ref: { id: w.snapshot.snapshot_id, revision: w.snapshot.revision } }))
      .rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    w.sql.prepare("UPDATE job SET progress_cursor='existing-checkpoint' WHERE job_id=?").run(w.context.job_id);
    await expect(w.bind()).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(w.sql.prepare("SELECT progress_cursor FROM job WHERE job_id=?").get(w.context.job_id)?.progress_cursor).toBe("existing-checkpoint");
  });
});
