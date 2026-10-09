import { applyD1Migrations, env as generatedEnv, reset, type D1Migration } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import {
  RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
  RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import {
  createResearchProviderKeyConfigurationService,
  type ResearchProviderKeyManagementPort,
} from "../src/research-provider-key-configuration-service.js";
import { createOwnerResearchProjectConfigurationService } from "../src/research-project-configuration-composition.js";
import { createResearchProviderKeyModelUseService } from "../src/research-provider-key-model-use-service.js";
import {
  createNativeUseEnvironment,
  freeOnlyCatalogResponse,
  GATEWAY_ACCOUNT_ID,
  MODEL_ID,
} from "./research-provider-key-model-use-fixture.js";

const env = generatedEnv as unknown as Env & {
  readonly CORE_MIGRATIONS: D1Migration[];
};

const TEST_ENV = {
  CORE_DB: env.CORE_DB,
  ENVIRONMENT: "development",
  DEPLOYMENT_GENERATION: "provider-key-model-use-failure-test-generation",
  AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
} as unknown as Env;

const migrationRuntime = env;

function ownerContext(owner: string, project: string): AuthenticatedRequestContext {
  const credentialGeneration = `credential-${crypto.randomUUID()}`;
  return {
    request: new Request(`https://core.example/api/v1/projects/${project}/model-provider-key/model-use`),
    principal_ref: owner,
    client_class: "owner_pwa",
    credential_generation: credentialGeneration,
    trace_id: crypto.randomUUID(),
    access: {
      principal_ref: owner,
      credential_generation: credentialGeneration,
      expires_at: "2099-01-01T00:00:00.000Z",
      authentication_method: "cloudflare_access",
    },
  };
}

async function insertOwnerProject(database: D1Database, owner: string): Promise<string> {
  const project = `model-use-migration-${crypto.randomUUID()}`;
  const timestamp = new Date().toISOString();
  await database.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?1,'Model-use migration test','private','retention-test','source-policy-test','model-profile-test','depth-test',1,?2)",
  ).bind(project, timestamp).run();
  await database.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES (?1,?2,?3,?4,?4)",
  ).bind(project, owner, TEST_ENV.DEPLOYMENT_GENERATION, timestamp).run();
  return project;
}

async function readRows(database: D1Database, sql: string, ...values: readonly unknown[]): Promise<readonly unknown[]> {
  const result = await database.prepare(sql).bind(...values).all<Readonly<Record<string, unknown>>>();
  return result.results;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("preserves populated Native children and retains an unpriced BLOCKED stage without weakening guards", async () => {
  const migrations = migrationRuntime.CORE_MIGRATIONS;
  const blockedMigrationIndex = migrations.findIndex((migration) =>
    migration.name.startsWith("0113_research_provider_key_model_use_failure_alignment"));
  const proofMigrationIndex = migrations.findIndex((migration) =>
    migration.name.startsWith("0114_provider_native_model_proof_attempt_alignment"));
  if (blockedMigrationIndex < 1) throw new Error("Migration 0113 is not present in the Core migration stream");
  if (proofMigrationIndex !== blockedMigrationIndex + 1) throw new Error("Migration 0114 must immediately follow migration 0113");
  const blockedMigration = migrations[blockedMigrationIndex];
  const proofMigration = migrations[proofMigrationIndex];
  if (blockedMigration === undefined || proofMigration === undefined) throw new Error("Native repair migration entries are missing");

  await reset();
  const database = env.CORE_DB;
  await applyD1Migrations(database, migrations.slice(0, blockedMigrationIndex));

  const owner = `model-use-migration-owner-${crypto.randomUUID()}`;
  const project = await insertOwnerProject(database, owner);
  const context = ownerContext(owner, project);
  const runtimeEnv = await createNativeUseEnvironment(owner, database, TEST_ENV);
  const keyOperationId = crypto.randomUUID();
  const managementPort: ResearchProviderKeyManagementPort = {
    account_id: GATEWAY_ACCOUNT_ID,
    gateway_id: "eliotr-reasoning",
    create: async (input) => ({
      protocol: "eliotr.openrouter-provider-key-configured.v1",
      disposition: "configured_not_qualified",
      account_id: GATEWAY_ACCOUNT_ID,
      gateway_id: "eliotr-reasoning",
      provider_config_id: `local-provider-config-${crypto.randomUUID()}`,
      provider_slug: "openrouter",
      alias: input.alias,
      default_config: false,
      secret_id: `local-secret-${crypto.randomUUID()}`,
      observed_modified_at: new Date().toISOString(),
    }),
  };
  const keyConfiguration = createResearchProviderKeyConfigurationService({ database, managementPort });
  await keyConfiguration.create(context, project, {
    protocol: RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL,
    operation_id: keyOperationId,
    provider_id: "openrouter",
    provider_key: "local-migration-fixture-placeholder",
  });
  const projectConfiguration = createOwnerResearchProjectConfigurationService(runtimeEnv, context, project);

  let rejectPricing = false;
  vi.stubGlobal("fetch", async () => rejectPricing
    ? new Response(JSON.stringify({ data: { id: "unrelated/model", endpoints: [] } }), {
      status: 200, headers: { "content-type": "application/json" },
    })
    : freeOnlyCatalogResponse());
  let nativeCalls = 0;
  const modelFetcher: typeof fetch = async () => {
    nativeCalls += 1;
    const callNumber = nativeCalls;
    return new Response(JSON.stringify({
      id: `local-chat-${callNumber}`,
      object: "chat.completion",
      created: 1_759_000_000,
      model: MODEL_ID,
      choices: [{ index: 0, finish_reason: "stop", message: {
        role: "assistant",
        content: JSON.stringify({ connected: true, qualification_purpose: "structured-output-connectivity" }),
      } }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }), { status: 200, headers: { "content-type": "application/json", "cf-aig-log-id": `local-log-${callNumber}` } });
  };
  const service = createResearchProviderKeyModelUseService({
    env: runtimeEnv,
    context,
    project_id: project,
    key_configuration: keyConfiguration,
    project_configuration: projectConfiguration,
    fetcher: modelFetcher,
  });

  const successfulOperationId = crypto.randomUUID();
  const firstAttempt = await service.start(keyOperationId, {
    protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
    operation_id: successfulOperationId,
    expected_selection_revision: null,
  });
  expect(firstAttempt.state).toBe("qualifying");
  expect(nativeCalls).toBe(1);

  const rowQueries = {
    operations: "SELECT * FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3",
    stages: "SELECT * FROM research_provider_key_model_use_stage_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 ORDER BY sequence_number",
    prices: "SELECT * FROM research_provider_key_model_price_observation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 ORDER BY stage",
    preparations: "SELECT * FROM provider_native_model_preparation WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 ORDER BY stage",
    attempts: "SELECT * FROM provider_native_model_qualification_attempt WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 ORDER BY stage",
    observations: "SELECT * FROM provider_native_model_qualification_observation WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 ORDER BY stage",
    candidates: "SELECT * FROM provider_native_model_candidate WHERE owner_ref=?1 AND project_id=?2 ORDER BY stage",
    proofs: "SELECT * FROM provider_native_model_qualification_proof WHERE owner_ref=?1 AND project_id=?2 ORDER BY qualification_ref",
  } as const;
  const readOperationRows = async (operationId: string) => Object.freeze({
    operations: await readRows(database, rowQueries.operations, owner, project, operationId),
    stages: await readRows(database, rowQueries.stages, owner, project, operationId),
    prices: await readRows(database, rowQueries.prices, owner, project, operationId),
    preparations: await readRows(database, rowQueries.preparations, owner, project, operationId),
    attempts: await readRows(database, rowQueries.attempts, owner, project, operationId),
    observations: await readRows(database, rowQueries.observations, owner, project, operationId),
    candidates: await readRows(database, rowQueries.candidates, owner, project),
    proofs: await readRows(database, rowQueries.proofs, owner, project),
  });
  const beforeRows = await readOperationRows(successfulOperationId);
  expect(beforeRows.operations).toHaveLength(1);
  expect(beforeRows.stages).toHaveLength(2);
  expect(beforeRows.prices).not.toHaveLength(0);
  expect(beforeRows.preparations).toHaveLength(2);
  expect(beforeRows.attempts).toHaveLength(1);
  expect(beforeRows.observations).toHaveLength(1);
  expect(beforeRows.candidates).toHaveLength(0);
  expect(beforeRows.proofs).toHaveLength(0);
  const observedAttempt = await database.prepare(
    "SELECT state,observation_ref,observation_sha256,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256 " +
    "FROM provider_native_model_qualification_attempt WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3",
  ).bind(owner, project, successfulOperationId).first<Readonly<Record<string, unknown>>>();
  expect(observedAttempt).toMatchObject({
    state: "OBSERVED",
    candidate_ref: null,
    candidate_sha256: null,
    qualification_ref: null,
    qualification_sha256: null,
  });

  const guardedTriggers = [
    "research_provider_key_model_use_stage_transition",
    "research_provider_key_model_use_stage_no_delete",
    "research_provider_key_model_price_observation_owner_insert",
    "provider_native_model_preparation_guard",
    "provider_native_model_qualification_attempt_guard",
    "provider_native_model_observation_guard",
    "provider_native_model_candidate_guard",
    "provider_native_model_qualification_proof_guard",
    "provider_native_model_qualification_complete_guard",
  ];
  const triggerSql = `SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN (${guardedTriggers.map((_, index) => `?${index + 1}`).join(",")}) ORDER BY name`;
  const readTriggers = async () => (await database.prepare(triggerSql).bind(...guardedTriggers)
    .all<Readonly<{ name: string; sql: string }>>()).results;
  const beforeTriggers = await readTriggers();
  expect(beforeTriggers).toHaveLength(guardedTriggers.length);

  await applyD1Migrations(database, [blockedMigration]);

  const afterBlockedMigrationRows = await readOperationRows(successfulOperationId);
  expect(afterBlockedMigrationRows).toEqual(beforeRows);
  const afterBlockedMigrationTriggers = await readTriggers();
  expect(afterBlockedMigrationTriggers).toEqual(beforeTriggers);

  const foreignKeyGuardStart = blockedMigration.queries.findIndex((query) =>
    query.includes("research_provider_key_model_use_stage_fk_guard_0113"));
  const foreignKeyGuardReset = blockedMigration.queries.findIndex((query, index) =>
    index > foreignKeyGuardStart && /^PRAGMA\s+defer_foreign_keys\s*=\s*OFF\s*;?$/i.test(query.trim()));
  if (foreignKeyGuardStart < 0 || foreignKeyGuardReset < foreignKeyGuardStart) {
    throw new Error("Migration 0113 does not contain its final foreign-key guard and reset");
  }
  const foreignKeyGuardStatements = blockedMigration.queries.slice(foreignKeyGuardStart, foreignKeyGuardReset + 1);
  if (foreignKeyGuardStatements.length !== 4) throw new Error("Migration 0113 foreign-key guard statement shape changed");

  const probeSuffix = crypto.randomUUID().replaceAll("-", "");
  const probeParent = `model_use_fk_probe_parent_${probeSuffix}`;
  const probeChild = `model_use_fk_probe_child_${probeSuffix}`;
  await database.prepare(`CREATE TABLE ${probeParent} (id INTEGER PRIMARY KEY) STRICT`).run();
  await database.prepare(
    `CREATE TABLE ${probeChild} (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES ${probeParent}(id)) STRICT`,
  ).run();
  await database.batch([
    database.prepare(`INSERT INTO ${probeParent} (id) VALUES (1)`),
    database.prepare(`INSERT INTO ${probeChild} (id,parent_id) VALUES (1,1)`),
  ]);
  try {
    await expect(database.batch([
      database.prepare("PRAGMA defer_foreign_keys = ON"),
      database.prepare(`INSERT INTO ${probeChild} (id,parent_id) VALUES (2,999)`),
      ...foreignKeyGuardStatements.map((query) => database.prepare(query)),
    ])).rejects.toThrow(/CHECK constraint failed/i);
    expect((await database.prepare(`SELECT id FROM ${probeParent} ORDER BY id`).all()).results).toEqual([{ id: 1 }]);
    expect((await database.prepare(`SELECT id,parent_id FROM ${probeChild} ORDER BY id`).all()).results)
      .toEqual([{ id: 1, parent_id: 1 }]);
    expect(await database.prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='research_provider_key_model_use_stage_fk_guard_0113'",
    ).first()).toBeNull();
  } finally {
    await database.batch([
      database.prepare(`DROP TABLE ${probeChild}`),
      database.prepare(`DROP TABLE ${probeParent}`),
    ]);
  }

  await applyD1Migrations(database, [proofMigration]);

  expect(await readOperationRows(successfulOperationId)).toEqual(beforeRows);
  const afterProofMigrationTriggers = await readTriggers();
  const proofGuard = (triggers: readonly Readonly<{ name: string; sql: string }>[]) =>
    triggers.find((trigger) => trigger.name === "provider_native_model_qualification_proof_guard");
  const beforeProofGuard = proofGuard(beforeTriggers);
  const afterProofGuard = proofGuard(afterProofMigrationTriggers);
  if (beforeProofGuard === undefined || afterProofGuard === undefined) throw new Error("Native proof guard is missing");
  expect(afterProofMigrationTriggers.map((trigger) => trigger.name)).toEqual(beforeTriggers.map((trigger) => trigger.name));
  expect(afterProofMigrationTriggers.filter((trigger) => trigger.name !== beforeProofGuard.name))
    .toEqual(beforeTriggers.filter((trigger) => trigger.name !== beforeProofGuard.name));
  expect(afterProofGuard.sql).not.toBe(beforeProofGuard.sql);
  expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

  const resumed = await service.start(keyOperationId, {
    protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
    operation_id: successfulOperationId,
    expected_selection_revision: null,
  });
  expect(resumed.state).toBe("selected");
  expect(nativeCalls).toBe(2);
  const completedRows = await readOperationRows(successfulOperationId);
  expect(completedRows.attempts).toHaveLength(2);
  expect(completedRows.observations).toHaveLength(2);
  expect(completedRows.candidates).toHaveLength(2);
  expect(completedRows.proofs).toHaveLength(2);
  const completedAttempts = await database.prepare(
    "SELECT state,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256 " +
    "FROM provider_native_model_qualification_attempt WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 ORDER BY stage",
  ).bind(owner, project, successfulOperationId).all<Readonly<Record<string, unknown>>>();
  expect(completedAttempts.results).toHaveLength(2);
  expect(completedAttempts.results.every((attempt) => attempt.state === "COMPLETED" && attempt.candidate_ref !== null &&
    attempt.candidate_sha256 !== null && attempt.qualification_ref !== null && attempt.qualification_sha256 !== null)).toBe(true);
  const completedProof = await database.prepare(
    "SELECT qualification_ref FROM provider_native_model_qualification_proof " +
    "WHERE owner_ref=?1 AND project_id=?2 ORDER BY qualification_ref LIMIT 1",
  ).bind(owner, project).first<Readonly<{ qualification_ref: string }>>();
  if (completedProof === null) throw new Error("Completed Native proof is unavailable");
  await expect(database.prepare(
    "INSERT INTO provider_native_model_qualification_proof SELECT * FROM provider_native_model_qualification_proof " +
    "WHERE qualification_ref=?1",
  ).bind(completedProof.qualification_ref).run()).rejects.toBeDefined();

  rejectPricing = true;
  const failedOperationId = crypto.randomUUID();
  const failed = await service.start(keyOperationId, {
    protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
    operation_id: failedOperationId,
    expected_selection_revision: resumed.selection_revision,
  });
  expect(failed.state).toBe("blocked");
  expect(failed.failure_code).toBe("FREE_PRICE_NOT_PROVEN");
  const blockedRows = await database.prepare(
    "SELECT owner_id,project_id,operation_id,sequence_number,stage,state,pricing_snapshot_ref,pricing_snapshot_sha256," +
    "preparation_ref,preparation_sha256,failure_code FROM research_provider_key_model_use_stage_operation " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 AND state='BLOCKED'",
  ).bind(owner, project, failedOperationId).all<Readonly<Record<string, unknown>>>();
  expect(blockedRows.results).toHaveLength(1);
  const blocked = blockedRows.results[0];
  expect(blocked).toMatchObject({
    state: "BLOCKED",
    pricing_snapshot_ref: null,
    pricing_snapshot_sha256: null,
    preparation_ref: null,
    preparation_sha256: null,
    failure_code: "FREE_PRICE_NOT_PROVEN",
  });

  const route = await database.prepare(
    "SELECT route_ref,route_version,prompt_sha256,schema_sha256,parameters_sha256,probe_prompt_sha256,probe_schema_sha256,probe_parameters_sha256 " +
    "FROM research_provider_key_model_use_stage_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 LIMIT 1",
  ).bind(owner, project, failedOperationId).first<Readonly<{
    route_ref: string; route_version: string; prompt_sha256: string; schema_sha256: string; parameters_sha256: string;
    probe_prompt_sha256: string; probe_schema_sha256: string; probe_parameters_sha256: string;
  }>>();
  if (route === null) throw new Error("Failed operation stage identity is unavailable");
  const badPreparedInsert = database.prepare(
    "INSERT INTO research_provider_key_model_use_stage_operation (owner_id,project_id,operation_id,sequence_number,stage," +
    "route_ref,route_version,prompt_sha256,schema_sha256,parameters_sha256,probe_prompt_sha256,probe_schema_sha256," +
    "probe_parameters_sha256,pricing_snapshot_ref,pricing_snapshot_sha256,preparation_ref,preparation_sha256," +
    "candidate_ref,candidate_sha256,qualification_ref,qualification_sha256,state,failure_code,created_at,updated_at) " +
    "VALUES (?1,?2,?3,2,'COUNTER_SEARCH',?4,?5,?6,?7,?8,?9,?10,?11,NULL,NULL,'preparation-without-price',?12," +
    "NULL,NULL,NULL,NULL,'PREPARED',NULL,?13,?13)",
  ).bind(owner, project, failedOperationId, route.route_ref, route.route_version, route.prompt_sha256, route.schema_sha256,
    route.parameters_sha256, route.probe_prompt_sha256, route.probe_schema_sha256, route.probe_parameters_sha256,
    "a".repeat(64), new Date().toISOString());
  await expect(badPreparedInsert.run()).rejects.toBeDefined();

  await expect(database.prepare(
    "UPDATE research_provider_key_model_use_stage_operation SET project_id=?1 WHERE owner_id=?2 AND project_id=?3 " +
    "AND operation_id=?4 AND state='BLOCKED'",
  ).bind(`forged-${project}`, owner, project, failedOperationId).run()).rejects.toBeDefined();
  await expect(database.prepare(
    "UPDATE research_provider_key_model_use_stage_operation SET state='PENDING',failure_code=NULL " +
    "WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 AND state='BLOCKED'",
  ).bind(owner, project, failedOperationId).run()).rejects.toBeDefined();
  expect(nativeCalls).toBe(2);
});
