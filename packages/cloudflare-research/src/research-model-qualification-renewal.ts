import {
  boundedDynamicRouteIdentifier,
  canonicalModelGatewayJson,
  exactDynamicRouteObject,
  exactDynamicRouteSha256,
  dynamicRouteProvisioningFailure,
  parseDynamicRouteQualificationProbeInput,
  type DynamicRouteControlPlanePort,
  type DynamicRouteProvisioningErrorCode,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
  type DynamicRouteQualificationProbeInput,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import {
  createD1DynamicRouteQualificationProofStore,
  decodeStoredDynamicRouteCandidate,
  type DynamicRouteQualificationLatestExpectation,
  type DynamicRouteQualificationLatestPointer,
  type StoredDynamicRouteCandidate,
} from "./model-gateway-qualification-d1.js";
import {
  createResearchModelQualification,
  type ResearchModelQualificationNativeDependencies,
} from "./research-model-qualification.js";
import { createD1ResearchModelQualificationObservationStore } from "./research-model-qualification-store.js";

const CANDIDATE_COLUMNS = "candidate_ref, candidate_sha256, candidate_json, route_ref, route_version, staged_at";
const ACTIVE_COLUMNS = "candidate_ref, candidate_sha256, route_ref, route_version";
const OBSERVATION_PROTOCOL = "eliotr.dynamic-route-qualification-observation.v1";
const ACTIVE_KEYS = new Set(["candidate_ref", "candidate_sha256", "route_ref", "route_version"]);
const RECORD_KEYS = new Set(["candidate_ref", "candidate_sha256", "expected_latest", "fresh"]);
const EXPECTED_LATEST_KEYS = new Set(["qualification_ref", "qualification_sha256"]);
const PROBE_RECEIPT_KEYS = new Set(["protocol", "execution_probe_ref", "observation_sha256", "observation"]);
const PROBE_OBSERVATION_KEYS = new Set([
  "expires_at", "gateway_log_id", "probe_idempotency_key", "probe_input_sha256", "protocol",
  "request_body_sha256", "request_parameters_sha256", "response_body_sha256", "response_model",
  "route_fingerprint", "route_fingerprint_ref", "verified_at",
]);

interface ActiveRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
}

interface ActiveIdentity {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly route_ref: string;
  readonly route_version: string;
}

function fail(
  code: DynamicRouteProvisioningErrorCode,
  message: string,
  cause?: unknown,
): never {
  dynamicRouteProvisioningFailure(code, message, cause === undefined ? {} : { cause });
}

function record(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): Record<string, unknown> {
  return exactDynamicRouteObject(value, keys, code, label);
}

function identity(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  return boundedDynamicRouteIdentifier(value, label, code);
}

function sha256(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  return exactDynamicRouteSha256(value, label, code);
}

function activeIdentity(raw: unknown): ActiveIdentity {
  const value = record(raw, ACTIVE_KEYS, "stored active qualification route", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
  return Object.freeze({
    candidate_ref: identity(value.candidate_ref, "active candidate reference", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    candidate_sha256: sha256(value.candidate_sha256, "active candidate digest", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    route_ref: identity(value.route_ref, "active route reference", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    route_version: identity(value.route_version, "active route version", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
  });
}

function candidateReceipt(candidate: StoredDynamicRouteCandidate): DynamicRouteProvisioningReceipt {
  return Object.freeze({
    disposition: "EXISTING_MATCH",
    deployment: candidate.candidate.deployment,
    provider_route_id: candidate.candidate.provider_route_id,
    provider_route_name: candidate.candidate.provider_route_name,
    route_definition_sha256: candidate.candidate.route_definition_sha256,
    provider_snapshot_sha256: candidate.candidate.provider_snapshot_sha256,
    control_plane_receipt_ref: candidate.candidate.control_plane_receipt_ref,
  });
}

function detachedRenewalInput(raw: unknown): ResearchModelQualificationRenewalInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalModelGatewayJson(raw)) as unknown;
  } catch (cause) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "qualification renewal input is not canonical JSON", cause);
  }
  const value = record(parsed, RECORD_KEYS, "qualification renewal input", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
  const expected = value.expected_latest === null ? null : record(
    value.expected_latest,
    EXPECTED_LATEST_KEYS,
    "expected latest qualification",
    "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
  );
  const fresh = parseDynamicRouteQualificationProbeInput(value.fresh);
  return Object.freeze({
    candidate_ref: identity(value.candidate_ref, "renewal candidate reference", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    candidate_sha256: sha256(value.candidate_sha256, "renewal candidate digest", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    fresh,
    expected_latest: expected === null ? null : Object.freeze({
      qualification_ref: identity(expected.qualification_ref, "expected latest qualification reference", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
      qualification_sha256: sha256(expected.qualification_sha256, "expected latest qualification digest", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
    }),
  });
}

function assertProbeCandidateBinding(
  probe: DynamicRouteQualificationProbeInput,
  candidate: StoredDynamicRouteCandidate,
): void {
  const expected = candidateReceipt(candidate);
  const actual = probe.provisioning;
  if (canonicalModelGatewayJson(actual.deployment) !== canonicalModelGatewayJson(expected.deployment) ||
      actual.provider_route_id !== expected.provider_route_id ||
      actual.provider_route_name !== expected.provider_route_name ||
      actual.route_definition_sha256 !== expected.route_definition_sha256 ||
      actual.provider_snapshot_sha256 !== expected.provider_snapshot_sha256 ||
      actual.control_plane_receipt_ref !== expected.control_plane_receipt_ref ||
      probe.route_definition_sha256 !== expected.route_definition_sha256) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "fresh qualification is not bound to the active immutable candidate");
  }
}

async function readActiveCandidate(
  database: D1Database,
  candidateRef: string,
  candidateSha256: string,
): Promise<StoredDynamicRouteCandidate> {
  const rawCandidate = await database.prepare(
    `SELECT ${CANDIDATE_COLUMNS} FROM dynamic_route_candidate WHERE candidate_ref=?1 LIMIT 1`,
  ).bind(candidateRef).first<StoredDynamicRouteCandidate["row"]>();
  if (rawCandidate === null) fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "renewal candidate is missing");
  const candidate = await decodeStoredDynamicRouteCandidate(
    rawCandidate,
    "renewal candidate",
    "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
  );
  if (candidate.sha256 !== candidateSha256 || candidate.row.candidate_ref !== candidateRef) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "renewal candidate digest differs from immutable D1 bytes");
  }
  if (candidate.candidate.qualification_tier !== "LIVE") {
    fail("DYNAMIC_ROUTE_LIVE_GATE_REQUIRED", "qualification renewal requires a live route candidate");
  }
  const rawActive = await database.prepare(
    `SELECT ${ACTIVE_COLUMNS} FROM dynamic_route_active_generation WHERE route_ref=?1 LIMIT 1`,
  ).bind(candidate.row.route_ref).first<ActiveRow>();
  if (rawActive === null) fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "renewal candidate is not active");
  const active = activeIdentity(rawActive);
  if (active.route_ref !== candidate.row.route_ref || active.route_version !== candidate.row.route_version ||
      active.candidate_ref !== candidate.row.candidate_ref || active.candidate_sha256 !== candidate.sha256) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "active route candidate changed before renewal");
  }
  return candidate;
}

async function previousProbeKey(
  database: D1Database,
  candidate: StoredDynamicRouteCandidate,
  now: () => string,
): Promise<string> {
  const observations = createD1ResearchModelQualificationObservationStore(database, now);
  let raw: unknown;
  try {
    raw = await observations.read(candidate.candidate.execution_probe_ref);
  } catch (cause) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "active candidate qualification observation could not be read", cause);
  }
  if (raw === null) fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "active candidate qualification observation is missing");
  const receipt = record(raw, PROBE_RECEIPT_KEYS, "active candidate qualification observation", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
  if (receipt.protocol !== OBSERVATION_PROTOCOL || receipt.execution_probe_ref !== candidate.candidate.execution_probe_ref) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "active candidate qualification observation identity is inconsistent");
  }
  const observation = record(receipt.observation, PROBE_OBSERVATION_KEYS, "active candidate qualification observation body", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
  if (observation.protocol !== OBSERVATION_PROTOCOL) {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "active candidate qualification observation protocol is invalid");
  }
  return identity(observation.probe_idempotency_key, "active candidate probe idempotency key", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
}

export interface ResearchModelQualificationRenewalDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly gateway: ResearchModelQualificationNativeDependencies["gateway"];
  readonly control_plane: Pick<DynamicRouteControlPlanePort, "get">;
  readonly prompt_compiler: ModelGatewayPromptCompilerPort;
  readonly now: () => string;
}

export interface ResearchModelQualificationRenewalInput {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly fresh: DynamicRouteQualificationProbeInput;
  readonly expected_latest: DynamicRouteQualificationLatestExpectation | null;
}

export interface ResearchModelQualificationRenewalResult {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly qualification: DynamicRouteQualificationEvidence;
  readonly latest: DynamicRouteQualificationLatestPointer;
}

export interface ResearchModelQualificationRenewalPort {
  renew(input: ResearchModelQualificationRenewalInput): Promise<ResearchModelQualificationRenewalResult>;
}

export function createResearchModelQualificationRenewal(
  dependencies: ResearchModelQualificationRenewalDependencies,
): ResearchModelQualificationRenewalPort {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" ||
      typeof dependencies.work_bucket?.put !== "function" ||
      typeof dependencies.control_plane?.get !== "function" ||
      typeof dependencies.prompt_compiler?.compile !== "function" ||
      typeof dependencies.now !== "function") {
    fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "qualification renewal dependencies are invalid");
  }
  const proofStore = createD1DynamicRouteQualificationProofStore(dependencies.database, { now: dependencies.now });
  return Object.freeze({
    async renew(rawInput: ResearchModelQualificationRenewalInput): Promise<ResearchModelQualificationRenewalResult> {
      const input = detachedRenewalInput(rawInput);
      const candidate = await readActiveCandidate(dependencies.database, input.candidate_ref, input.candidate_sha256);
      assertProbeCandidateBinding(input.fresh, candidate);
      const oldProbeKey = await previousProbeKey(dependencies.database, candidate, dependencies.now);
      if (oldProbeKey === input.fresh.probe_idempotency_key) {
        fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "qualification renewal requires a new probe identity");
      }
      const qualificationService = createResearchModelQualification({
        database: dependencies.database,
        work_bucket: dependencies.work_bucket,
        gateway: dependencies.gateway,
        control_plane: dependencies.control_plane,
        prompt_compiler: dependencies.prompt_compiler,
        now: dependencies.now,
      });
      // qualify() owns the existing one-shot claim, native provider call, and
      // before/after control-plane readbacks. Errors are deliberately allowed
      // to escape; this method never redispatches an ambiguous probe.
      const qualification = await qualificationService.qualify(input.fresh);
      const afterQualification = await readActiveCandidate(
        dependencies.database,
        input.candidate_ref,
        input.candidate_sha256,
      );
      assertProbeCandidateBinding(input.fresh, afterQualification);
      const proof = await proofStore.putImmutable({
        candidate_ref: input.candidate_ref,
        candidate_sha256: input.candidate_sha256,
        qualification,
      });
      const latest = await proofStore.promoteLatest({
        route_ref: afterQualification.row.route_ref,
        route_version: afterQualification.row.route_version,
        candidate_ref: input.candidate_ref,
        candidate_sha256: input.candidate_sha256,
        qualification_ref: proof.qualification_ref,
        qualification_sha256: proof.proof_sha256,
        expected_latest: input.expected_latest,
      });
      const finalCandidate = await readActiveCandidate(
        dependencies.database,
        input.candidate_ref,
        input.candidate_sha256,
      );
      if (finalCandidate.row.route_ref !== afterQualification.row.route_ref ||
          finalCandidate.row.route_version !== afterQualification.row.route_version) {
        fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "active route candidate changed after qualification renewal");
      }
      return Object.freeze({
        candidate_ref: input.candidate_ref,
        candidate_sha256: input.candidate_sha256,
        qualification_ref: proof.qualification_ref,
        qualification_sha256: proof.proof_sha256,
        qualification,
        latest,
      });
    },
  });
}
