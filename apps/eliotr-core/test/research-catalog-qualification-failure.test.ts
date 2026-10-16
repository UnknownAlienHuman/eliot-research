import { applyD1Migrations, env as generatedEnv } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { createD1ProviderNativeModelCatalogV2Authority } from "@eliotr/cloudflare-native-models";
import { createCatalogQualificationFailureReconciler, createD1ResearchCatalogModelUseStore } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-use-store.js";
import { createResearchCatalogModelUseComposition } from "../src/research-catalog-model-use-composition.js";
import { createResearchCatalogModelUseV2PricingReader } from "../src/research-catalog-model-use-v2-driver.js";
import { createNativeUseEnvironment } from "./research-provider-key-model-use-fixture.js";
import type { Env } from "../src/env.js";

const env = generatedEnv as unknown as Env & { CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = env.CORE_DB;
const MODEL = "muse-spark-1.3-contributor";
const ACCOUNT = "a".repeat(32);
const GATEWAY = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/eliotr-reasoning`;
const migration = env.CORE_MIGRATIONS.find(item => item.name.startsWith("0161_"));
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("required native fixture value missing");
  return value;
}
beforeAll(async () => { await applyD1Migrations(db, env.CORE_MIGRATIONS.filter(item => item.name < "0161_")); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture(status = 400) {
  const owner = `failed-go-owner-${crypto.randomUUID()}`, project = `failed-go-project-${crypto.randomUUID()}`;
  const operation = crypto.randomUUID(), providerOperation = crypto.randomUUID(), now = new Date().toISOString();
  const context: AuthenticatedRequestContext = { request: new Request("https://eliot.test/owner"), principal_ref: owner,
    credential_generation: `credential-${crypto.randomUUID()}`, client_class: "owner_pwa", trace_id: crypto.randomUUID() };
  await db.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES(?1,'failure fixture','private'," +
    "'retention','source','profile','depth',1,?2)").bind(project, now).run();
  await db.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES(?1,?2,'failure-test',?3,?3)").bind(project, owner, now).run();
  const providers = createServiceModelProviderService({ database: db, managementPort: { available: true,
    create: async input => ({ provider_config_id: `config-${input.operation_id}`, provider_slug: "custom-opencode-go", alias: input.alias }),
    read: async () => null } });
  await providers.create(context, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operation_id: providerOperation,
    provider_id: "opencode-go", display_name: "Go", base_url: "https://opencode.ai/inference/go/v1", model_ids: [MODEL],
    api_key: "synthetic-test-key" });
  const installed = await createNativeUseEnvironment(owner, db, { ...env, ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "failure-test", AI_GATEWAY_REASONING_URL: GATEWAY });
  const installedEnv = { ...installed, ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: "synthetic-control-only" } as Env;
  let models = 0;
  const logs: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://models.dev/api.json") return Response.json({ "opencode-go": { id: "opencode-go", models: {
      [MODEL]: { id: MODEL, cost: { input: 0.1, output: 0.2 }, reasoning: true, temperature: false,
        provider: { npm: "@ai-sdk/openai", api: "https://opencode.ai/inference/go/openai/v1" } },
    } } });
    expect(request.url).toBe(`${GATEWAY}/custom-opencode-go/responses`);
    models += 1;
    const id = crypto.randomUUID();
    const sentMetadata = JSON.parse(String(request.headers.get("cf-aig-metadata"))) as Record<string, string>;
    const retainedMetadata = Object.fromEntries(["operation_id", "parameters_digest", "pricing_snapshot_ref", "prompt_generation", "route_ref"]
      .map(key => [key, sentMetadata[key]]));
    logs.push({ id, provider: "custom-opencode-go", model: MODEL, created_at: new Date().toISOString(),
      success: models === 1, cached: false, status_code: models === 1 ? 200 : status,
      metadata: JSON.stringify(retainedMetadata), tokens_in: 11, tokens_out: 7 });
    if (models !== 1) return new Response("private provider payload must never be logged", { status, headers: { "cf-aig-log-id": id } });
    return Response.json({ object: "response", id: "probe-response", created_at: 1_760_000_000, model: MODEL,
      status: "completed", output: [{ id: "probe-message", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ connected: true, qualification_purpose: "structured-output-connectivity" }),
          annotations: [] }] }], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } },
    { headers: { "cf-aig-log-id": id } });
  });
  const api = createResearchCatalogModelUseComposition(installedEnv, context, project);
  const receipt = await api.start({ protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: operation,
    expected_selection_revision: null, provider_id: "opencode-go", provider_operation_id: providerOperation, model_id: MODEL });
  expect(receipt).toMatchObject({ state: "uncertain", phase: "qualification", failure_code: "QUALIFICATION_OUTCOME_UNCERTAIN" });
  expect(models).toBe(2);
  const readRows = async () => (await db.prepare("SELECT * FROM provider_native_model_catalog_v2_evidence " +
    "WHERE owner_ref=?1 AND project_id=?2 AND consent_operation_id=?3 ORDER BY stage").bind(owner, project, operation)
    .all<Record<string, unknown>>()).results;
  return { owner, project, operation, context, installedEnv, api, logs, readRows, modelCalls: () => models };
}

describe("authenticated failed catalog qualification reconciliation", () => {
  it("upgrades populated history additively and blocks only exact terminal failure, retaining unknown effects and revoking earlier proofs", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = await fixture();
    const original = await f.readRows();
    const originalAuthorization = await createD1ResearchCatalogModelUseStore(db).read(f.owner, f.project, f.operation);
    expect(original.some(row => row.state === "COMPLETED")).toBe(true);
    await expect(db.prepare("UPDATE research_catalog_model_use_authorization SET state='BLOCKED',failure_code='NATIVE_RECEIPT_INVALID' " +
      "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3").bind(f.owner, f.project, f.operation).run()).rejects.toThrow();
    if (migration === undefined) throw new Error("0161 migration missing");
    await applyD1Migrations(db, [migration]);
    expect(await f.readRows()).toEqual(original);
    expect(await createD1ResearchCatalogModelUseStore(db).read(f.owner, f.project, f.operation)).toEqual(originalAuthorization);
    await expect(db.prepare("UPDATE research_catalog_model_use_authorization SET state='BLOCKED',failure_code='NATIVE_RECEIPT_INVALID' " +
      "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3").bind(f.owner, f.project, f.operation).run()).rejects.toThrow();
    const failureLog = required(f.logs[1]);
    const successLog = required(f.logs[0]);
    let responseStatus = 200, responseSuccess = true, total: number | undefined;
    let returnedLogs = f.logs;
    let reads = 0, revokeDuringRead = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.cloudflare.com");
      expect(url.pathname).toBe(`/client/v4/accounts/${ACCOUNT}/ai-gateway/gateways/eliotr-reasoning/logs`);
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-control-only");
      expect(request.redirect).toBe("manual");
      expect(request.body).toBeNull();
      reads += 1;
      if (revokeDuringRead) await db.prepare("UPDATE project SET generation=2 WHERE project_id=?1")
        .bind(f.project).run();
      return Response.json({ success: responseSuccess, result: returnedLogs,
        result_info: { page: 1, total_count: total ?? returnedLogs.length } }, { status: responseStatus });
    });
    const metadata = JSON.parse(String(failureLog.metadata)) as Record<string, string>;
    const variants: Record<string, unknown>[] = [
      { status_code: 500 }, { status_code: 503 }, { status_code: 408 }, { status_code: 429 }, { success: true }, { cached: true },
      { provider: "other-provider" }, { model: "other-model" }, { created_at: "2000-01-01T00:00:00.000Z" },
      ...["operation_id", "stage_id", "parameters_digest", "prompt_generation", "schema_generation", "pricing_snapshot_ref", "route_ref", "route_version"]
        .map(key => ({ metadata: JSON.stringify({ ...metadata, [key]: "mismatch" }) })),
    ];
    for (const variant of variants) {
      returnedLogs = [successLog, { ...failureLog, ...variant }];
      await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    }
    for (const ambiguous of [[], [failureLog, failureLog]]) {
      returnedLogs = ambiguous;
      await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    }
    returnedLogs = f.logs;
    total = 51;
    await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    total = undefined;
    responseStatus = 403;
    await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    responseStatus = 200; responseSuccess = false;
    await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    responseSuccess = true;
    revokeDuringRead = true;
    await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    await db.prepare("UPDATE project SET generation=1 WHERE project_id=?1").bind(f.project).run();
    revokeDuringRead = false;
    expect(await db.prepare("SELECT count(*) AS n FROM provider_native_model_catalog_v2_failure WHERE consent_operation_id=?1")
      .bind(f.operation).first("n")).toBe(0);
    let beforeDenied = reads;
    const foreign = createResearchCatalogModelUseComposition(f.installedEnv, { ...f.context, principal_ref: "another-owner" }, f.project);
    await expect(foreign.read(f.operation)).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE project SET generation=2 WHERE project_id=?1").bind(f.project).run();
    await expect(f.api.read(f.operation)).rejects.toMatchObject({ status: 409 });
    await db.prepare("UPDATE project SET generation=1 WHERE project_id=?1").bind(f.project).run();
    expect(reads).toBe(beforeDenied);
    const freshContext = { ...f.context, credential_generation: "fresh-current-owner-credential" };
    const releasedEnv = { ...f.installedEnv, DEPLOYMENT_GENERATION: "later-release" };
    const released = createResearchCatalogModelUseComposition(releasedEnv, freshContext, f.project);
    returnedLogs = [{ ...failureLog, metadata: JSON.stringify({ ...metadata, parameters_digest: "mismatch" }) }];
    await expect(released.read(f.operation)).resolves.toMatchObject({ state: "uncertain" });
    await expect(released.readCurrent()).resolves.toMatchObject({ state: "uncertain" });
    returnedLogs = f.logs;
    beforeDenied = reads;
    // Simulate loss of canonical ownership at the D1 read port. Production owner
    // identities are immutable, so the fixture must not rewrite their SQL fence.
    const deniedDb = new Proxy(db, { get(target, property) {
      if (property === "prepare") return (sql: string) => sql.includes("JOIN project_owner o ON o.project_id=p.project_id")
        ? { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement : target.prepare(sql);
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const changedOwner = createResearchCatalogModelUseComposition({ ...releasedEnv, CORE_DB: deniedDb }, freshContext, f.project);
    await expect(changedOwner.read(f.operation)).rejects.toMatchObject({ status: 409 });
    await expect(changedOwner.readCurrent()).rejects.toMatchObject({ status: 409 });
    expect(reads).toBe(beforeDenied);
    const row = await createD1ResearchCatalogModelUseStore(db).read(f.owner, f.project, f.operation);
    await expect(released.start({ protocol: "eliotr.research.catalog-model-use-request.v1", operation_id: f.operation,
      expected_selection_revision: null, provider_id: "opencode-go", model_id: MODEL,
      provider_operation_id: required(row).provider_operation_id })).rejects.toMatchObject({ status: 409,
      code: "RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED" });
    expect(reads).toBe(beforeDenied);
    const wrongAccount = createCatalogQualificationFailureReconciler({ database: db, context: f.context,
      read_logs: async () => ({ account_id: "b".repeat(32), gateway_id: "eliotr-reasoning", logs: f.logs }) });
    expect((await wrongAccount(required(row))).state).toBe("UNCERTAIN");
    // A new release and refreshed owner credential can reconcile old exact
    // failure history without renewing any native preparation or dispatch.
    await expect(released.readCurrent()).resolves.toMatchObject({ state: "blocked", phase: "qualification", failure_code: "NATIVE_RECEIPT_INVALID" });
    expect(await f.readRows()).toEqual(original);
    const durable = await db.prepare("SELECT * FROM provider_native_model_catalog_v2_failure WHERE consent_operation_id=?1")
      .bind(f.operation).first<{ receipt_json: string; gateway_log_id: string; http_status: number }>();
    expect(durable).toMatchObject({ gateway_log_id: failureLog.id, http_status: 400 });
    expect(JSON.parse(required(durable).receipt_json)).toMatchObject({ provider_effects: "UNKNOWN", original_state: "UNCERTAIN",
      gateway_authenticated: true, success: false, classification: "GATEWAY_HTTP_REJECTED" });
    expect(JSON.parse(required(durable).receipt_json)).toMatchObject({
      owner_credential_generation: f.context.credential_generation,
      reader_credential_generation: freshContext.credential_generation,
      deployment_generation: f.installedEnv.DEPLOYMENT_GENERATION,
      reader_deployment_generation: releasedEnv.DEPLOYMENT_GENERATION,
    });
    expect(Object.keys((JSON.parse(required(durable).receipt_json) as { gateway_metadata: object }).gateway_metadata)).toHaveLength(5);
    expect((await createD1ResearchCatalogModelUseStore(db).read(f.owner, f.project, f.operation))?.owner_credential_generation)
      .toBe(f.context.credential_generation);
    const revocations = await db.prepare("SELECT * FROM provider_native_model_catalog_v2_revocation WHERE consent_operation_id=?1")
      .bind(f.operation).all();
    expect(revocations.results.length).toBe(original.filter(row => row.state === "COMPLETED").length);
    const authority = createD1ProviderNativeModelCatalogV2Authority({ database: db,
      pricing_snapshots: createResearchCatalogModelUseV2PricingReader({ database: db }) });
    const completed = required(original.find(row => row.state === "COMPLETED"));
    const completedPreparation = JSON.parse(String(completed.preparation_json)) as {
      deployment: { route_ref: string; route_version: string }; transport_policy: unknown;
    };
    await expect(authority.resolvePinned({ owner_ref: f.owner, project_id: f.project, allow_expired_snapshot_v2: false,
      selection: { candidate_kind: "provider-native-v2", stage: completed.stage,
        route_ref: completedPreparation.deployment.route_ref, route_version: completedPreparation.deployment.route_version,
        candidate_ref: completed.candidate_ref, candidate_sha256: completed.candidate_sha256,
        qualification_ref: completed.qualification_ref, qualification_sha256: completed.qualification_sha256,
        transport_policy: completedPreparation.transport_policy } })).rejects.toThrow(/revoked/u);
    const failed = required(original.find(row => row.state === "UNCERTAIN"));
    const retry = vi.fn();
    await expect(authority.qualify({ owner_ref: f.owner, project_id: f.project, owner_operation_id: f.operation,
      stage: failed.stage as "SYNTHESIZE", preparation_ref: String(failed.preparation_ref),
      preparation_sha256: String(failed.preparation_sha256), executor: { executeOnce: retry } })).rejects.toThrow();
    expect(retry).not.toHaveBeenCalled();
    const readCount = reads;
    await expect(f.api.read(f.operation)).resolves.toMatchObject({ state: "blocked" });
    expect(reads).toBe(readCount);
    expect(f.modelCalls()).toBe(2);
    await expect(db.prepare("DELETE FROM provider_native_model_catalog_v2_failure WHERE consent_operation_id=?1")
      .bind(f.operation).run()).rejects.toThrow(/immutable/u);
    await expect(db.prepare("UPDATE provider_native_model_catalog_v2_failure SET http_status=422 WHERE consent_operation_id=?1")
      .bind(f.operation).run()).rejects.toThrow(/immutable/u);
    await expect(db.prepare("UPDATE research_catalog_model_use_authorization SET state='QUALIFYING',failure_code=NULL WHERE operation_id=?1")
      .bind(f.operation).run()).rejects.toThrow();
    const safeLog = warnings.mock.calls.map(call => String(call[0])).find(value => value.includes("http_rejected"));
    expect(JSON.parse(required(safeLog))).toMatchObject({ http_status: 400, classification: "HTTP_CLIENT_REJECTED", operation_id: f.operation });
    expect(warnings.mock.calls.flat().join(" ")).not.toContain("private provider payload");
    expect(warnings.mock.calls.flat().join(" ")).not.toContain("synthetic-control-only");
    const ambiguous = await fixture(502);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Request(input, init).method).toBe("GET");
      return Response.json({ success: true, result: ambiguous.logs, result_info: { page: 1, total_count: ambiguous.logs.length } });
    });
    await expect(ambiguous.api.read(ambiguous.operation)).resolves.toMatchObject({ state: "uncertain" });
    expect(ambiguous.modelCalls()).toBe(2);
    expect(warnings.mock.calls.some(call => String(call[0]).includes("HTTP_SERVER_AMBIGUOUS"))).toBe(true);
  }, 30_000);
});
