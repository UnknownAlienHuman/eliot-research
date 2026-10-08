import {
  buildDynamicRouteCandidate,
  canonicalModelGatewayJson,
  decodeDynamicRouteCandidateWriteReceipt,
  decodeDynamicRouteProvisioningReceipt,
  validateDynamicRouteQualification,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
} from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  createD1DynamicRouteRegistry,
  createD1ModelGatewayDeploymentRegistry,
} from "./model-gateway-deployment-registry-d1.js";
import {
  decodeStoredDynamicRouteCandidate,
  createD1DynamicRouteQualificationProofStore,
  dynamicRouteCandidateArtifact,
  type StoredDynamicRouteCandidate,
} from "./model-gateway-qualification-d1.js";
import {
  createD1ResearchModelPricingSnapshotStore,
  type ResearchModelPricingSnapshot,
} from "./research-model-pricing-store.js";
import { createD1ResearchModelQualificationObservationStore } from "./research-model-qualification-store.js";

const REQUEST_PROTOCOL = "eliotr.research-model-candidate-stage-request.v1" as const;
const PREPARATION_PROTOCOL = "eliotr.research-model-preparation.v1" as const;
const RECEIPT_PROTOCOL = "eliotr.research-model-candidate-stage-receipt.v1" as const;
const PRICING_KEYS = new Set([
  "protocol", "pricing_snapshot_ref", "route_ref", "route_version", "provider", "exact_model_id",
  "pricing_basis", "input_rate_usd_per_1k_tokens", "output_rate_usd_per_1k_tokens", "effective_at",
  "expires_at", "provenance_ref", "approval_receipt_ref", "snapshot_sha256", "created_at",
]);
const OBSERVATION_RECEIPT_KEYS = new Set(["protocol", "execution_probe_ref", "observation_sha256", "observation"]);
const OBSERVATION_KEYS = new Set([
  "protocol", "probe_idempotency_key", "probe_input_sha256", "route_fingerprint_ref", "route_fingerprint",
  "gateway_log_id", "request_body_sha256", "request_parameters_sha256", "response_body_sha256", "response_model",
  "verified_at", "expires_at",
]);
const FINGERPRINT_KEYS = new Set([
  "route_ref", "route_version", "prompt_generation", "schema_generation", "parameters_digest",
  "pricing_snapshot_ref", "provider", "exact_model_id",
]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ResearchModelCandidateStagingErrorCode =
  | "RESEARCH_MODEL_STAGE_INPUT_INVALID"
  | "RESEARCH_MODEL_STAGE_PRICING_MISMATCH"
  | "RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH"
  | "RESEARCH_MODEL_STAGE_CANDIDATE_MISMATCH"
  | "RESEARCH_MODEL_STAGE_READBACK_MISMATCH";

export class ResearchModelCandidateStagingError extends Error {
  public readonly code: ResearchModelCandidateStagingErrorCode;

  public constructor(code: ResearchModelCandidateStagingErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchModelCandidateStagingError";
    this.code = code;
  }
}

export interface ResearchModelCandidateStageInput {
  readonly protocol: typeof REQUEST_PROTOCOL;
  readonly preparation: {
    readonly protocol: typeof PREPARATION_PROTOCOL;
    readonly deployment: ModelRouteDeployment;
    readonly pricing_snapshot: ResearchModelPricingSnapshot;
    readonly provisioning: unknown;
  };
  readonly qualification: unknown;
}

export interface ResearchModelCandidateStageReceipt {
  readonly protocol: typeof RECEIPT_PROTOCOL;
  readonly deployment: ModelRouteDeployment;
  readonly pricing_snapshot_ref: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly execution_probe_ref: string;
  readonly qualification_expires_at: string;
}

export interface ResearchModelCandidateStagingDependencies {
  readonly database: D1Database;
  readonly now?: () => string;
}

function fail(code: ResearchModelCandidateStagingErrorCode, message: string, cause?: unknown): never {
  throw new ResearchModelCandidateStagingError(code, message, cause);
}

function exactObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || !keys.has(key)) {
      fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", `${label} has unsupported fields`);
    }
  }
  if (Object.keys(record).length !== keys.size) fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", `${label} is incomplete`);
  return record;
}

function canonicalTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", `${label} must be canonical UTC time`);
  }
  return value;
}

function canonicalClock(now: () => string): string {
  let value: string;
  try { value = now(); }
  catch (cause) { fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "candidate stage clock is unavailable", cause); }
  return canonicalTime(value, "candidate stage clock");
}

function sameDeployment(left: unknown, right: ModelRouteDeployment): boolean {
  try { return canonicalModelGatewayJson(left) === canonicalModelGatewayJson(right); }
  catch { return false; }
}

function candidateProvisioningIdentity(candidate: StoredDynamicRouteCandidate["candidate"]): unknown {
  return Object.freeze({
    schema: candidate.schema,
    deployment: candidate.deployment,
    provider_route_id: candidate.provider_route_id,
    provider_route_name: candidate.provider_route_name,
    route_definition_sha256: candidate.route_definition_sha256,
    provider_snapshot_sha256: candidate.provider_snapshot_sha256,
    control_plane_receipt_ref: candidate.control_plane_receipt_ref,
    qualification_tier: candidate.qualification_tier,
    control_plane_readback_ref: candidate.control_plane_readback_ref,
  });
}

function candidateProvisioningMatches(
  existing: StoredDynamicRouteCandidate,
  requested: ReturnType<typeof buildDynamicRouteCandidate>,
): boolean {
  return existing.candidate.qualification_tier === "LIVE" &&
    canonicalModelGatewayJson(candidateProvisioningIdentity(existing.candidate)) ===
      canonicalModelGatewayJson(candidateProvisioningIdentity(requested));
}

function parsePricing(value: unknown): ResearchModelPricingSnapshot {
  const pricing = exactObject(value, PRICING_KEYS, "prepared pricing snapshot");
  for (const key of PRICING_KEYS) {
    if (typeof pricing[key] !== "string") fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", `prepared pricing ${key} is invalid`);
  }
  if (!SHA256.test(pricing.snapshot_sha256 as string)) fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "prepared pricing digest is invalid");
  canonicalTime(pricing.effective_at, "prepared pricing effective_at");
  canonicalTime(pricing.expires_at, "prepared pricing expires_at");
  canonicalTime(pricing.created_at, "prepared pricing created_at");
  return pricing as unknown as ResearchModelPricingSnapshot;
}

/** Pure strict validation used before the CLI binds Wrangler D1. */
export function decodeResearchModelCandidateStageInput(
  raw: unknown,
  now = new Date().toISOString(),
): Readonly<{ preparation: ResearchModelCandidateStageInput["preparation"] & { readonly provisioning: DynamicRouteProvisioningReceipt }; qualification: DynamicRouteQualificationEvidence }> {
  const current = canonicalTime(now, "candidate stage clock");
  const request = exactObject(raw, new Set(["protocol", "preparation", "qualification"]), "candidate stage request");
  if (request.protocol !== REQUEST_PROTOCOL) fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "candidate stage protocol is unsupported");
  const preparation = exactObject(request.preparation, new Set(["protocol", "deployment", "pricing_snapshot", "provisioning"]), "preparation receipt");
  if (preparation.protocol !== PREPARATION_PROTOCOL) fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "preparation receipt protocol is unsupported");
  const pricing = parsePricing(preparation.pricing_snapshot);
  let provisioning: DynamicRouteProvisioningReceipt;
  let qualification: DynamicRouteQualificationEvidence;
  try {
    provisioning = decodeDynamicRouteProvisioningReceipt(preparation.provisioning);
    if (!sameDeployment(preparation.deployment, provisioning.deployment) ||
        pricing.route_ref !== provisioning.deployment.route_ref ||
        pricing.route_version !== provisioning.deployment.route_version ||
        pricing.pricing_snapshot_ref !== provisioning.deployment.pricing_snapshot_ref) {
      fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "preparation identities do not match the exact deployed route");
    }
    qualification = validateDynamicRouteQualification(request.qualification, provisioning, {
      environment: "PRODUCTION", expected_active_route_version: null, now: current,
    });
  } catch (cause) {
    if (cause instanceof ResearchModelCandidateStagingError) throw cause;
    fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "candidate stage requires current LIVE qualification for the exact prepared route", cause);
  }
  if (qualification.tier !== "LIVE" || Date.parse(pricing.effective_at) > Date.parse(current) ||
      Date.parse(pricing.expires_at) <= Date.parse(current) ||
      Date.parse(qualification.expires_at) <= Date.parse(current) ||
      Date.parse(qualification.verified_at) < Date.parse(pricing.effective_at) ||
      Date.parse(qualification.expires_at) > Date.parse(pricing.expires_at)) {
    fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "LIVE qualification and exact pricing snapshot are not current for the same window");
  }
  return Object.freeze({
    preparation: Object.freeze({
      protocol: PREPARATION_PROTOCOL,
      deployment: provisioning.deployment,
      pricing_snapshot: pricing,
      provisioning,
    }),
    qualification,
  });
}

function assertObservationMatches(
  raw: unknown,
  qualification: DynamicRouteQualificationEvidence,
  pricing: ResearchModelPricingSnapshot,
): void {
  const receipt = exactObject(raw, OBSERVATION_RECEIPT_KEYS, "stored qualification observation receipt");
  if (receipt.protocol !== "eliotr.dynamic-route-qualification-observation.v1" ||
      receipt.execution_probe_ref !== qualification.execution_probe_ref ||
      typeof receipt.observation_sha256 !== "string" || !SHA256.test(receipt.observation_sha256)) {
    fail("RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH", "qualification observation receipt does not bind the selected probe");
  }
  const observation = exactObject(receipt.observation, OBSERVATION_KEYS, "stored qualification observation");
  if (observation.protocol !== "eliotr.dynamic-route-qualification-observation.v1" ||
      typeof observation.probe_idempotency_key !== "string" || !IDENTIFIER.test(observation.probe_idempotency_key) ||
      typeof observation.probe_input_sha256 !== "string" || !SHA256.test(observation.probe_input_sha256) ||
      typeof observation.route_fingerprint_ref !== "string" || !IDENTIFIER.test(observation.route_fingerprint_ref) ||
      typeof observation.gateway_log_id !== "string" || !IDENTIFIER.test(observation.gateway_log_id) ||
      typeof observation.response_model !== "string" || !IDENTIFIER.test(observation.response_model) ||
      typeof observation.request_body_sha256 !== "string" || !SHA256.test(observation.request_body_sha256) ||
      typeof observation.request_parameters_sha256 !== "string" || !SHA256.test(observation.request_parameters_sha256) ||
      typeof observation.response_body_sha256 !== "string" || !SHA256.test(observation.response_body_sha256) ||
      canonicalTime(observation.verified_at, "observation verified_at") !== qualification.verified_at ||
      canonicalTime(observation.expires_at, "observation expires_at") !== qualification.expires_at) {
    fail("RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH", "stored qualification observation is malformed or stale");
  }
  const fingerprint = exactObject(observation.route_fingerprint, FINGERPRINT_KEYS, "stored route fingerprint");
  const deployment = qualification;
  if (fingerprint.route_ref !== deployment.route_ref || fingerprint.route_version !== deployment.route_version ||
      fingerprint.prompt_generation !== deployment.prompt_generation || fingerprint.schema_generation !== deployment.schema_generation ||
      fingerprint.parameters_digest !== deployment.parameters_digest || fingerprint.pricing_snapshot_ref !== pricing.pricing_snapshot_ref ||
      fingerprint.provider !== pricing.provider || fingerprint.exact_model_id !== pricing.exact_model_id ||
      observation.response_model !== pricing.exact_model_id) {
    fail("RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH", "LIVE observation provider/model or route tuple differs from immutable pricing");
  }
}

export function createResearchModelCandidateStagingService(dependencies: ResearchModelCandidateStagingDependencies) {
  if (dependencies === null || typeof dependencies !== "object" || dependencies.database === null ||
      typeof dependencies.database !== "object" || typeof dependencies.database.prepare !== "function") {
    fail("RESEARCH_MODEL_STAGE_INPUT_INVALID", "candidate staging D1 binding is invalid");
  }
  const nowSource = dependencies.now ?? (() => new Date().toISOString());

  return Object.freeze({
    async stage(raw: unknown): Promise<ResearchModelCandidateStageReceipt> {
      const current = canonicalClock(nowSource);
      const stage = decodeResearchModelCandidateStageInput(raw, current);
      const { database } = dependencies;
      const { provisioning, pricing_snapshot: pricing } = stage.preparation;
      const pricingStore = createD1ResearchModelPricingSnapshotStore(database, { now: () => current });
      const actualPricing = await pricingStore.read({
        pricing_snapshot_ref: pricing.pricing_snapshot_ref,
        route_ref: provisioning.deployment.route_ref,
        route_version: provisioning.deployment.route_version,
        provider: pricing.provider,
        exact_model_id: pricing.exact_model_id,
      });
      if (actualPricing === null || canonicalModelGatewayJson(actualPricing) !== canonicalModelGatewayJson(pricing)) {
        fail("RESEARCH_MODEL_STAGE_PRICING_MISMATCH", "prepared pricing snapshot differs from exact D1 readback");
      }
      const observation = await createD1ResearchModelQualificationObservationStore(database, () => current)
        .read(stage.qualification.execution_probe_ref);
      if (observation === null) fail("RESEARCH_MODEL_STAGE_OBSERVATION_MISMATCH", "LIVE qualification observation is not persisted in D1");
      assertObservationMatches(observation, stage.qualification, actualPricing);

      const candidate = buildDynamicRouteCandidate(provisioning, stage.qualification);
      const candidateArtifact = await dynamicRouteCandidateArtifact(candidate);
      let candidateSelection: Readonly<{ candidate_ref: string; candidate_sha256: string }>;
      let existingRow: StoredDynamicRouteCandidate["row"] | null;
      try {
        existingRow = await database.prepare(
          "SELECT candidate_ref, candidate_sha256, candidate_json, route_ref, route_version, staged_at " +
          "FROM dynamic_route_candidate WHERE route_ref = ?1 AND route_version = ?2 LIMIT 1",
        ).bind(provisioning.deployment.route_ref, provisioning.deployment.route_version)
          .first<StoredDynamicRouteCandidate["row"]>();
      } catch (cause) {
        fail("RESEARCH_MODEL_STAGE_READBACK_MISMATCH", "existing immutable candidate could not be read before staging", cause);
      }
      if (existingRow === null) {
        const writeReceipt = decodeDynamicRouteCandidateWriteReceipt(
          await createD1DynamicRouteRegistry(database, { environment: "PRODUCTION", now: () => current })
            .stageCandidate(candidate, candidateArtifact.sha256),
          candidateArtifact.sha256,
        );
        candidateSelection = Object.freeze({ candidate_ref: writeReceipt.candidate_ref, candidate_sha256: candidateArtifact.sha256 });
      } else {
        let existing: StoredDynamicRouteCandidate;
        try {
          existing = await decodeStoredDynamicRouteCandidate(existingRow, "existing immutable route candidate", "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED");
        } catch (cause) {
          fail("RESEARCH_MODEL_STAGE_CANDIDATE_MISMATCH", "existing immutable candidate is malformed", cause);
        }
        if (existing.sha256 !== existing.row.candidate_sha256 ||
            !candidateProvisioningMatches(existing, candidate)) {
          fail("RESEARCH_MODEL_STAGE_CANDIDATE_MISMATCH", "existing immutable candidate differs from the exact prepared route/provider fingerprint");
        }
        candidateSelection = Object.freeze({ candidate_ref: existing.row.candidate_ref, candidate_sha256: existing.sha256 });
      }
      const proofWrite = await createD1DynamicRouteQualificationProofStore(database, { now: () => current }).putImmutable({
        candidate_ref: candidateSelection.candidate_ref,
        candidate_sha256: candidateSelection.candidate_sha256,
        qualification: stage.qualification,
      });
      const selection = Object.freeze({
        route_ref: provisioning.deployment.route_ref,
        route_version: provisioning.deployment.route_version,
        candidate_ref: candidateSelection.candidate_ref,
        candidate_sha256: candidateSelection.candidate_sha256,
        qualification_ref: proofWrite.qualification_ref,
        qualification_sha256: proofWrite.proof_sha256,
      });
      const [proof, resolved] = await Promise.all([
        createD1DynamicRouteQualificationProofStore(database, { now: () => current }).readPinned(selection),
        createD1ModelGatewayDeploymentRegistry(database, { environment: "PRODUCTION", now: () => current })
          .resolvePinned(provisioning.deployment, selection),
      ]);
      if (proof === null || proof.qualification.tier !== "LIVE" ||
          canonicalModelGatewayJson(proof.qualification) !== canonicalModelGatewayJson(stage.qualification) ||
          resolved === null || canonicalModelGatewayJson(resolved) !== canonicalModelGatewayJson(provisioning.deployment)) {
        fail("RESEARCH_MODEL_STAGE_READBACK_MISMATCH", "candidate or proof failed exact pinned D1 readback");
      }
      return Object.freeze({
        protocol: RECEIPT_PROTOCOL,
        deployment: provisioning.deployment,
        pricing_snapshot_ref: pricing.pricing_snapshot_ref,
        candidate_ref: selection.candidate_ref,
        candidate_sha256: selection.candidate_sha256,
        qualification_ref: selection.qualification_ref,
        qualification_sha256: selection.qualification_sha256,
        execution_probe_ref: proof.qualification.execution_probe_ref,
        qualification_expires_at: proof.qualification.expires_at,
      });
    },
  });
}
