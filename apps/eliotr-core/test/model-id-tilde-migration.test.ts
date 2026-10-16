import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

const runtime = env as unknown as { CORE_DB: D1Database; CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = runtime.CORE_DB;
const migration = runtime.CORE_MIGRATIONS.find(item => item.name.startsWith("0160"));
const owner = "migration-0160-owner";
const providerOperation = "22222222-2222-4222-8222-222222222222";
const operation = "11111111-1111-4111-8111-111111111111";
const alias = `eliotr-${"a".repeat(48)}`;
const now = "2026-10-16T12:00:00.000Z";
const targets = ["research_catalog_model_use_authorization", "research_provider_key_model_price_observation"];

beforeAll(async () => {
  if (migration === undefined) throw new Error("0160 migration is missing");
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS.filter(item => item.name < "0160_"));
});

async function insert(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${columns.map((_key, index) => `?${index + 1}`).join(",")})`)
    .bind(...columns.map(key => row[key])).run();
}
async function project(id: string) {
  await insert("project", { project_id: id, title: "0160 fixture", default_disclosure: "private", retention_policy_ref: "retention",
    default_source_policy_ref: "source-policy", default_model_profile_ref: "profile", default_depth_profile_ref: "depth", generation: 1, created_at: now });
  await insert("project_owner", { project_id: id, principal_ref: owner, deployment_generation: "migration-test", created_at: now, updated_at: now });
}
function authorization(projectId: string, operationId: string, model: string): Record<string, unknown> {
  return { owner_id: owner, project_id: projectId, operation_id: operationId, provider_id: "openrouter", provider_operation_id: providerOperation,
    route_provider_id: "openrouter", model_id: model, account_id: "a".repeat(32), gateway_id: "reasoning", alias,
    provider_config_id: "config-0160", configuration_metadata_sha256: "b".repeat(64), request_sha256: "d".repeat(64),
    owner_credential_generation: "credential-0160", project_generation: 1, deployment_generation: "migration-test",
    expected_selection_revision: null, source_configuration_ref: null, source_configuration_sha256: null,
    state: "ACCEPTED", phase: "INTENT", selected_configuration_ref: null, selected_configuration_sha256: null,
    selection_revision: null, failure_code: null, created_at: now, updated_at: now };
}
async function objects() {
  return (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .all<{ type: string; name: string; tbl_name: string; sql: string }>()).results;
}
const canonicalTable = (sql: string) => sql.replace(/^CREATE TABLE\s+"?([A-Za-z0-9_]+)"?/u, "CREATE TABLE $1").replace(/\s+/gu, " ").trim();

describe("0160 native D1 model-only CHECK upgrade", () => {
  it("preserves populated FK history and exact fences, then persists a tilde model operation", async () => {
    await project("before-0160");
    await project("after-0160");
    await insert("service_model_provider_operation", { owner_id: owner, operation_id: providerOperation, provider_id: "openrouter",
      display_name: "OpenRouter fixture", base_url: null, model_ids_json: "[]", request_sha256: "c".repeat(64), alias,
      state: "CONFIGURED", provider_config_id: "config-0160", provider_slug: "openrouter", metadata_sha256: "b".repeat(64),
      failure_code: null, provider_http_status: null, created_at: now, updated_at: now, model_registration_mode: "catalog_managed" });
    const old = authorization("before-0160", operation, "vendor/model-1");
    await insert(targets[0] as string, old);
    const next = authorization("after-0160", "33333333-3333-4333-8333-333333333333", "~openai/gpt-astra-latest");
    await expect(insert(targets[0] as string, next)).rejects.toThrow();
    const preparation = { protocol: "eliotr.provider-native-model-preparation.v2", owner_ref: owner, project_id: "before-0160",
      owner_operation_id: operation, consent_operation_id: operation, stage: "SYNTHESIZE", provider_id: "openrouter", provider_slug: "openrouter",
      provider_operation_id: providerOperation, model_id: old.model_id, pricing_snapshot_ref: "fixture-price", pricing_snapshot_sha256: "e".repeat(64),
      request_sha256: old.request_sha256, catalog_sdk: "@openrouter/ai-sdk-provider", sdk_base_url: "https://openrouter.ai/api/v1",
      catalog_metadata_sha256: "f".repeat(64), prepared_at: now, preparation_expires_at: "2026-10-17T12:00:00.000Z",
      pricing_snapshot_expires_at: "2026-10-17T12:00:00.000Z",
      key_binding: { operation_id: providerOperation, owner_ref: owner, project_id: "before-0160", provider_id: "openrouter", provider_slug: "openrouter",
        alias, provider_config_id: "config-0160", configuration_metadata_sha256: "b".repeat(64) },
      transport_policy: { provider: "openrouter", model: old.model_id, api: "openrouter-chat-completions", billing: { mode: "byok", alias } } };
    await insert("provider_native_model_catalog_v2_evidence", { owner_ref: owner, project_id: "before-0160", consent_operation_id: operation,
      stage: "SYNTHESIZE", provider_id: "openrouter", provider_slug: "openrouter", provider_operation_id: providerOperation, model_id: old.model_id,
      alias, provider_config_id: "config-0160", configuration_metadata_sha256: "b".repeat(64), request_sha256: old.request_sha256,
      pricing_snapshot_ref: "fixture-price", pricing_snapshot_sha256: "e".repeat(64), preparation_ref: "fixture-preparation",
      preparation_sha256: "a".repeat(64), preparation_json: JSON.stringify(preparation), state: "PREPARED", created_at: now, updated_at: now });
    const before = await objects();
    const rowsBefore = await db.prepare("SELECT * FROM research_catalog_model_use_authorization").all();
    const childBefore = await db.prepare("SELECT * FROM provider_native_model_catalog_v2_evidence").all();
    if (migration === undefined) throw new Error("0160 migration is missing");
    await applyD1Migrations(db, [migration]);
    const after = await objects();
    expect(after.map(row => [row.type, row.name])).toEqual(before.map(row => [row.type, row.name]));
    for (const previous of before) {
      const current = after.find(row => row.type === previous.type && row.name === previous.name);
      expect(current).toBeDefined();
      const column = previous.name === targets[0] ? "model_id" : "exact_model_id";
      const expected = targets.includes(previous.name)
        ? previous.sql.replace(`${column} NOT GLOB '*[^A-Za-z0-9._:@/-]*'`, `${column} NOT GLOB '*[^A-Za-z0-9._:~@/-]*'`) : previous.sql;
      expect(targets.includes(previous.name) ? canonicalTable(current?.sql ?? "") : current?.sql)
        .toBe(targets.includes(previous.name) ? canonicalTable(expected) : expected);
    }
    expect((await db.prepare("SELECT * FROM research_catalog_model_use_authorization").all()).results).toEqual(rowsBefore.results);
    expect((await db.prepare("SELECT * FROM provider_native_model_catalog_v2_evidence").all()).results).toEqual(childBefore.results);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await insert(targets[0] as string, next);
    expect(await db.prepare("SELECT model_id,state FROM research_catalog_model_use_authorization WHERE operation_id=?1")
      .bind(next.operation_id).first()).toEqual({ model_id: next.model_id, state: "ACCEPTED" });
    await expect(db.prepare("UPDATE research_catalog_model_use_authorization SET model_id='different-model' WHERE operation_id=?1")
      .bind(next.operation_id).run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM research_catalog_model_use_authorization WHERE operation_id=?1")
      .bind(next.operation_id).run()).rejects.toThrow();
    for (const [field, value] of Object.entries({ provider_id: "~openrouter", route_provider_id: "~openrouter", operation_id: "~operation",
      account_id: "~".repeat(32), gateway_id: "~gateway", alias: `eliotr-${"~".repeat(48)}`, provider_config_id: "~config" })) {
      await expect(insert(targets[0] as string, { ...next, operation_id: crypto.randomUUID(), [field]: value })).rejects.toThrow();
    }
    for (const model of ["model?redirect=x", "model#fragment", "model%2Fother", "model with spaces"]) {
      await expect(insert(targets[0] as string, { ...next, operation_id: crypto.randomUUID(), model_id: model })).rejects.toThrow();
    }
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
