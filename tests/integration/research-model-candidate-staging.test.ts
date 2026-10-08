/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateDynamicRouteQualification,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
  type DynamicRouteQualificationObservationWriteInput,
} from "../../packages/cloudflare-ai/src/index.js";
import type { ApplicationModelRoute, ModelRouteDeployment } from "../../packages/platform-cloudflare/src/index.js";
import { createD1DynamicRouteQualificationProofStore } from "../../packages/cloudflare-research/src/model-gateway-qualification-d1.js";
import { createD1ModelGatewayDeploymentRegistry } from "../../packages/cloudflare-research/src/model-gateway-deployment-registry-d1.js";
import {
  createResearchModelCandidateStagingService,
  type ResearchModelCandidateStageInput,
} from "../../packages/cloudflare-research/src/research-model-candidate-staging.js";
import { createD1ResearchModelPricingSnapshotStore } from "../../packages/cloudflare-research/src/research-model-pricing-store.js";
import { createD1ResearchModelQualificationObservationStore } from "../../packages/cloudflare-research/src/research-model-qualification-store.js";

const NOW = "2026-10-04T12:00:00.000Z";
const VERIFIED_AT = "2026-10-04T11:55:00.000Z";
const EXPIRES_AT = "2026-10-04T12:25:00.000Z";
const DIGEST = "a".repeat(64);
const INPUT_DIGEST = "b".repeat(64);
const ROUTE_REF = "dynamic/eliotr-balanced" as ApplicationModelRoute;
const MODEL = "@cf/zai-org/glm-5.3-flash";
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "infra", "d1", "core", "migrations");
type StageFixture = Omit<ResearchModelCandidateStageInput, "qualification"> & {
  readonly qualification: DynamicRouteQualificationEvidence;
};

function testDatabase(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const name of [
    "0035_model_route_registry.sql",
    "0038_research_model_pricing.sql",
    "0054_model_route_qualification.sql",
    "0056_model_route_qualification_renewal.sql",
  ]) db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  db.exec("CREATE TABLE dynamic_route_qualification_revocation (qualification_ref TEXT NOT NULL, qualification_sha256 TEXT NOT NULL, reason TEXT NOT NULL, revoked_by TEXT NOT NULL, revoked_at TEXT NOT NULL, PRIMARY KEY(qualification_ref,qualification_sha256)) STRICT, WITHOUT ROWID");
  const database = {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const params = args as SQLInputValue[];
          return {
            async first<T>(): Promise<T | null> {
              const row = statement.get(...params) as T | undefined;
              return row === undefined ? null : row;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: statement.all(...params) as T[] };
            },
            async run(): Promise<{ success: boolean; meta: { changes: number } }> {
              const info = statement.run(...params);
              return { success: true, meta: { changes: Number(info.changes) } };
            },
          };
        },
      };
    },
  };
  return database as unknown as D1Database;
}

function executionProbeRef(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("invalid production observation receipt");
  const value = raw as { readonly protocol?: unknown; readonly execution_probe_ref?: unknown; readonly observation_sha256?: unknown };
  if (value.protocol !== "eliotr.dynamic-route-qualification-observation.v1" ||
      typeof value.execution_probe_ref !== "string" || typeof value.observation_sha256 !== "string") {
    throw new Error("invalid production observation receipt");
  }
  return value.execution_probe_ref;
}

async function fixture(database: D1Database, observedModel = MODEL, persistObservation = true): Promise<StageFixture> {
  const deployment: ModelRouteDeployment = Object.freeze({
    route_ref: ROUTE_REF,
    route_version: "stage-v1",
    prompt_generation: "prompt-v1",
    schema_generation: "schema-v1",
    parameters_digest: DIGEST,
    pricing_snapshot_ref: "pricing-stage-v1",
  });
  const provisioning: DynamicRouteProvisioningReceipt = Object.freeze({
    disposition: "EXISTING_MATCH",
    deployment,
    provider_route_id: "provider-route-stage-v1",
    provider_route_name: "eliot-stage-test-v1",
    route_definition_sha256: DIGEST,
    provider_snapshot_sha256: DIGEST,
    control_plane_receipt_ref: "control-plane-stage-v1",
  });
  const pricing = await createD1ResearchModelPricingSnapshotStore(database, { now: () => NOW }).putImmutable({
    identity: {
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      provider: "workers-ai",
      exact_model_id: MODEL,
    },
    snapshot: {
      protocol: "eliotr.research-model-pricing.v1",
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      provider: "workers-ai",
      exact_model_id: MODEL,
      pricing_basis: "EXACT_TOKEN_RATES_V1",
      input_rate_usd_per_1k_tokens: "0.15",
      output_rate_usd_per_1k_tokens: "0.5",
      effective_at: "2026-10-04T11:00:00.000Z",
      expires_at: "2026-10-04T13:00:00.000Z",
      provenance_ref: "pricing-source-stage-test",
      approval_receipt_ref: "operator-approval-stage-test",
    },
  });
  const observationStore = createD1ResearchModelQualificationObservationStore(database, () => NOW);
  const probeKey = "stage-probe-key-v1";
  const claimRef = "stage-probe-claim-v1";
  await observationStore.claim({ probe_idempotency_key: probeKey, probe_input_sha256: INPUT_DIGEST, claim_ref: claimRef });
  const observation: DynamicRouteQualificationObservationWriteInput = Object.freeze({
    protocol: "eliotr.dynamic-route-qualification-observation.v1",
    probe_idempotency_key: probeKey,
    probe_input_sha256: INPUT_DIGEST,
    route_fingerprint_ref: "fingerprint-stage-v1",
    route_fingerprint: {
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      parameters_digest: deployment.parameters_digest,
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      provider: "workers-ai",
      exact_model_id: observedModel,
    },
    gateway_log_id: "gateway-log-stage-v1",
    request_body_sha256: DIGEST,
    request_parameters_sha256: DIGEST,
    response_body_sha256: DIGEST,
    response_model: observedModel,
    verified_at: VERIFIED_AT,
    expires_at: EXPIRES_AT,
  });
  const observationReceipt = persistObservation
    ? await observationStore.putImmutable(observation, claimRef)
    : null;
  const probeRef = observationReceipt === null
    ? "dynamic-route-probe-missing-v1"
    : executionProbeRef(observationReceipt);
  const rawQualification = {
    tier: "LIVE",
    gateway_id: "eliotr-reasoning",
    route_ref: deployment.route_ref,
    route_version: deployment.route_version,
    prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation,
    parameters_digest: deployment.parameters_digest,
    pricing_snapshot_ref: deployment.pricing_snapshot_ref,
    provider_route_id: provisioning.provider_route_id,
    provider_route_name: provisioning.provider_route_name,
    route_definition_sha256: provisioning.route_definition_sha256,
    provider_snapshot_sha256: provisioning.provider_snapshot_sha256,
    control_plane_readback_ref: "control-plane-readback-stage-v1",
    execution_probe_ref: probeRef,
    verified_at: VERIFIED_AT,
    expires_at: EXPIRES_AT,
  };
  const qualification: DynamicRouteQualificationEvidence = validateDynamicRouteQualification(rawQualification, provisioning, {
    environment: "PRODUCTION",
    expected_active_route_version: null,
    now: NOW,
  });
  return Object.freeze({
    protocol: "eliotr.research-model-candidate-stage-request.v1",
    preparation: Object.freeze({
      protocol: "eliotr.research-model-preparation.v1",
      deployment,
      pricing_snapshot: pricing,
      provisioning,
    }),
    qualification,
  });
}

async function qualificationRenewal(
  database: D1Database,
  base: StageFixture,
  options: Readonly<{
    now: string;
    verifiedAt: string;
    expiresAt: string;
    suffix: string;
    provisioning?: DynamicRouteProvisioningReceipt;
    controlPlaneReadbackRef?: string;
  }>,
): Promise<StageFixture> {
  const provisioning = options.provisioning ?? base.preparation.provisioning as DynamicRouteProvisioningReceipt;
  const deployment = base.preparation.deployment;
  const probeKey = `stage-probe-${options.suffix}`;
  const claimRef = `stage-probe-claim-${options.suffix}`;
  const observationStore = createD1ResearchModelQualificationObservationStore(database, () => options.now);
  await observationStore.claim({ probe_idempotency_key: probeKey, probe_input_sha256: "c".repeat(64), claim_ref: claimRef });
  const observationReceipt = await observationStore.putImmutable(Object.freeze({
    protocol: "eliotr.dynamic-route-qualification-observation.v1",
    probe_idempotency_key: probeKey,
    probe_input_sha256: "c".repeat(64),
    route_fingerprint_ref: `fingerprint-${options.suffix}`,
    route_fingerprint: {
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      parameters_digest: deployment.parameters_digest,
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      provider: base.preparation.pricing_snapshot.provider,
      exact_model_id: base.preparation.pricing_snapshot.exact_model_id,
    },
    gateway_log_id: `gateway-log-${options.suffix}`,
    request_body_sha256: "d".repeat(64),
    request_parameters_sha256: "e".repeat(64),
    response_body_sha256: "f".repeat(64),
    response_model: base.preparation.pricing_snapshot.exact_model_id,
    verified_at: options.verifiedAt,
    expires_at: options.expiresAt,
  }), claimRef);
  const qualification = validateDynamicRouteQualification({
    tier: "LIVE",
    gateway_id: "eliotr-reasoning",
    route_ref: deployment.route_ref,
    route_version: deployment.route_version,
    prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation,
    parameters_digest: deployment.parameters_digest,
    pricing_snapshot_ref: deployment.pricing_snapshot_ref,
    provider_route_id: provisioning.provider_route_id,
    provider_route_name: provisioning.provider_route_name,
    route_definition_sha256: provisioning.route_definition_sha256,
    provider_snapshot_sha256: provisioning.provider_snapshot_sha256,
    control_plane_readback_ref: options.controlPlaneReadbackRef ?? `control-plane-readback-${options.suffix}`,
    execution_probe_ref: executionProbeRef(observationReceipt),
    verified_at: options.verifiedAt,
    expires_at: options.expiresAt,
  }, provisioning, { environment: "PRODUCTION", expected_active_route_version: null, now: options.now });
  return Object.freeze({
    protocol: "eliotr.research-model-candidate-stage-request.v1",
    preparation: Object.freeze({ ...base.preparation, provisioning }),
    qualification,
  });
}

describe("research model candidate staging", () => {
  it("stages and resolves an exact LIVE pin without touching active pointers", async () => {
    const database = testDatabase();
    const input = await fixture(database);
    const receipt = await createResearchModelCandidateStagingService({ database, now: () => NOW }).stage(input);
    expect(receipt).toMatchObject({
      protocol: "eliotr.research-model-candidate-stage-receipt.v1",
      deployment: input.preparation.deployment,
      pricing_snapshot_ref: input.preparation.pricing_snapshot.pricing_snapshot_ref,
      execution_probe_ref: input.qualification.execution_probe_ref,
      qualification_expires_at: EXPIRES_AT,
    });
    const proof = await createD1DynamicRouteQualificationProofStore(database, { now: () => NOW }).readPinned({
      route_ref: input.preparation.deployment.route_ref,
      route_version: input.preparation.deployment.route_version,
      candidate_ref: receipt.candidate_ref,
      candidate_sha256: receipt.candidate_sha256,
      qualification_ref: receipt.qualification_ref,
      qualification_sha256: receipt.qualification_sha256,
    });
    expect(proof?.qualification.execution_probe_ref).toBe(input.qualification.execution_probe_ref);
    expect((await database.prepare("SELECT candidate_ref FROM dynamic_route_candidate").bind().all()).results).toEqual([
      { candidate_ref: receipt.candidate_ref },
    ]);
    expect((await database.prepare("SELECT route_ref FROM dynamic_route_active_generation").bind().all()).results).toHaveLength(0);
    expect((await database.prepare("SELECT route_ref FROM dynamic_route_active_qualification").bind().all()).results).toHaveLength(0);
  });

  it("renews a proof on the exact immutable candidate after its embedded qualification expiry", async () => {
    const database = testDatabase();
    const original = await fixture(database);
    const staging = createResearchModelCandidateStagingService({ database, now: () => NOW });
    const originalReceipt = await staging.stage(original);
    const originalProofStore = createD1DynamicRouteQualificationProofStore(database, { now: () => NOW });
    const originalProof = await originalProofStore.readPinned({
      route_ref: originalReceipt.deployment.route_ref,
      route_version: originalReceipt.deployment.route_version,
      candidate_ref: originalReceipt.candidate_ref,
      candidate_sha256: originalReceipt.candidate_sha256,
      qualification_ref: originalReceipt.qualification_ref,
      qualification_sha256: originalReceipt.qualification_sha256,
    });

    const renewedNow = "2026-10-04T12:30:00.000Z";
    const renewed = await qualificationRenewal(database, original, {
      now: renewedNow,
      verifiedAt: "2026-10-04T12:26:00.000Z",
      expiresAt: "2026-10-04T12:55:00.000Z",
      suffix: "renewed-v1",
      controlPlaneReadbackRef: original.qualification.control_plane_readback_ref,
    });
    const renewedReceipt = await createResearchModelCandidateStagingService({ database, now: () => renewedNow }).stage(renewed);

    expect(renewedReceipt.candidate_ref).toBe(originalReceipt.candidate_ref);
    expect(renewedReceipt.candidate_sha256).toBe(originalReceipt.candidate_sha256);
    expect(renewedReceipt.qualification_ref).not.toBe(originalReceipt.qualification_ref);
    expect(renewedReceipt.qualification_sha256).not.toBe(originalReceipt.qualification_sha256);
    expect(renewedReceipt.execution_probe_ref).toBe(renewed.qualification.execution_probe_ref);
    expect(renewedReceipt.qualification_expires_at).toBe(renewed.qualification.expires_at);

    const proofStore = createD1DynamicRouteQualificationProofStore(database, { now: () => renewedNow });
    const retainedProof = await proofStore.readPinned({
      route_ref: originalReceipt.deployment.route_ref,
      route_version: originalReceipt.deployment.route_version,
      candidate_ref: originalReceipt.candidate_ref,
      candidate_sha256: originalReceipt.candidate_sha256,
      qualification_ref: originalReceipt.qualification_ref,
      qualification_sha256: originalReceipt.qualification_sha256,
    });
    const renewedProof = await proofStore.readPinned({
      route_ref: renewedReceipt.deployment.route_ref,
      route_version: renewedReceipt.deployment.route_version,
      candidate_ref: renewedReceipt.candidate_ref,
      candidate_sha256: renewedReceipt.candidate_sha256,
      qualification_ref: renewedReceipt.qualification_ref,
      qualification_sha256: renewedReceipt.qualification_sha256,
    });
    expect(retainedProof?.qualification).toEqual(originalProof?.qualification);
    expect(renewedProof?.qualification).toEqual(renewed.qualification);
    await expect(createD1ModelGatewayDeploymentRegistry(database, { environment: "PRODUCTION", now: () => renewedNow })
      .resolvePinned(renewedReceipt.deployment, {
        route_ref: renewedReceipt.deployment.route_ref,
        route_version: renewedReceipt.deployment.route_version,
        candidate_ref: renewedReceipt.candidate_ref,
        candidate_sha256: renewedReceipt.candidate_sha256,
        qualification_ref: renewedReceipt.qualification_ref,
        qualification_sha256: renewedReceipt.qualification_sha256,
      })).resolves.toEqual(renewedReceipt.deployment);
    expect((await database.prepare("SELECT candidate_ref FROM dynamic_route_candidate").bind().all()).results).toHaveLength(1);
    expect((await database.prepare("SELECT qualification_ref FROM dynamic_route_qualification_proof").bind().all()).results).toHaveLength(2);
    expect((await database.prepare("SELECT route_ref FROM dynamic_route_active_generation").bind().all()).results).toHaveLength(0);
    expect((await database.prepare("SELECT route_ref FROM dynamic_route_active_qualification").bind().all()).results).toHaveLength(0);
  });

  it("rejects an existing candidate whose provider fingerprint differs before candidate or proof writes", async () => {
    const database = testDatabase();
    const original = await fixture(database);
    const originalReceipt = await createResearchModelCandidateStagingService({ database, now: () => NOW }).stage(original);
    const baseProvisioning = original.preparation.provisioning as DynamicRouteProvisioningReceipt;
    const mismatchedProvisioning: DynamicRouteProvisioningReceipt = Object.freeze({
      ...baseProvisioning,
      provider_snapshot_sha256: "9".repeat(64),
      control_plane_receipt_ref: "control-plane-stage-mismatch-v1",
    });
    const mismatched = await qualificationRenewal(database, original, {
      now: "2026-10-04T12:30:00.000Z",
      verifiedAt: "2026-10-04T12:26:00.000Z",
      expiresAt: "2026-10-04T12:55:00.000Z",
      suffix: "mismatch-v1",
      provisioning: mismatchedProvisioning,
      controlPlaneReadbackRef: "control-plane-readback-mismatch-v1",
    });

    await expect(createResearchModelCandidateStagingService({ database, now: () => "2026-10-04T12:30:00.000Z" }).stage(mismatched))
      .rejects.toMatchObject({ code: "RESEARCH_MODEL_STAGE_CANDIDATE_MISMATCH" });
    expect((await database.prepare("SELECT candidate_ref FROM dynamic_route_candidate").bind().all()).results).toEqual([
      { candidate_ref: originalReceipt.candidate_ref },
    ]);
    expect((await database.prepare("SELECT qualification_ref FROM dynamic_route_qualification_proof").bind().all()).results).toHaveLength(1);
    expect((await database.prepare("SELECT route_ref FROM dynamic_route_active_generation").bind().all()).results).toHaveLength(0);
    expect((await database.prepare("SELECT route_ref FROM dynamic_route_active_qualification").bind().all()).results).toHaveLength(0);
  });

  it("rejects a persisted LIVE observation for a different model before candidate or proof writes", async () => {
    const database = testDatabase();
    const input = await fixture(database, "@cf/example/different-model");
    await expect(createResearchModelCandidateStagingService({ database, now: () => NOW }).stage(input))
      .rejects.toMatchObject({ code: "RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH" });
    expect((await database.prepare("SELECT candidate_ref FROM dynamic_route_candidate").bind().all()).results).toHaveLength(0);
    expect((await database.prepare("SELECT qualification_ref FROM dynamic_route_qualification_proof").bind().all()).results).toHaveLength(0);
  });

  it("rejects a missing persisted observation before candidate or proof writes", async () => {
    const database = testDatabase();
    const input = await fixture(database, MODEL, false);
    await expect(createResearchModelCandidateStagingService({ database, now: () => NOW }).stage(input))
      .rejects.toMatchObject({ code: "RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH" });
    expect((await database.prepare("SELECT candidate_ref FROM dynamic_route_candidate").bind().all()).results).toHaveLength(0);
    expect((await database.prepare("SELECT qualification_ref FROM dynamic_route_qualification_proof").bind().all()).results).toHaveLength(0);
  });
});
