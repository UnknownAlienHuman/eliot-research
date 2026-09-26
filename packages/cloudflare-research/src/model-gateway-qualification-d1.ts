import {
  boundedDynamicRouteIdentifier,
  canonicalModelGatewayJson,
  decodeDynamicRouteDeploymentForProvisioning,
  dynamicRouteJsonArtifact,
  dynamicRouteProvisioningFailure,
  exactDynamicRouteObject,
  exactDynamicRouteSha256,
  modelGatewaySha256,
  providerDynamicRouteName,
  validateDynamicRouteQualification,
  type DynamicRouteCandidate,
  type DynamicRouteProvisioningErrorCode,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
} from "@eliotr/cloudflare-ai";
import {
  createD1ResearchModelQualificationObservationStore,
} from "./research-model-qualification-store.js";

const PROTOCOL = "eliotr.dynamic-route-qualification-proof.v1" as const;
const OBSERVATION_PROTOCOL = "eliotr.dynamic-route-qualification-observation.v1" as const;
const CANDIDATE_KEYS = new Set([
  "control_plane_receipt_ref", "control_plane_readback_ref", "execution_probe_ref",
  "provider_route_id", "provider_route_name", "provider_snapshot_sha256",
  "qualification_expires_at", "qualification_tier", "route_definition_sha256",
  "schema", "deployment",
]);
const CANDIDATE_ROW_KEYS = new Set([
  "candidate_json", "candidate_ref", "candidate_sha256", "route_ref", "route_version", "staged_at",
]);
const PROOF_KEYS = new Set([
  "candidate_ref", "candidate_sha256", "qualification", "route_ref", "route_version", "schema",
]);
const PROOF_ROW_KEYS = new Set([
  "candidate_ref", "candidate_sha256", "created_at", "qualification_json", "qualification_ref",
  "proof_sha256", "route_ref", "route_version",
]);
const LATEST_ROW_KEYS = new Set([
  "activated_at", "candidate_ref", "candidate_sha256", "qualification_ref", "qualification_sha256",
  "route_ref", "route_version",
]);
const EXPECTED_LATEST_KEYS = new Set(["qualification_ref", "qualification_sha256"]);
const OBSERVATION_RECEIPT_KEYS = new Set(["observation", "observation_sha256", "execution_probe_ref", "protocol"]);
const OBSERVATION_KEYS = new Set([
  "expires_at", "gateway_log_id", "probe_idempotency_key", "probe_input_sha256", "protocol",
  "request_body_sha256", "request_parameters_sha256", "response_body_sha256", "response_model",
  "route_fingerprint", "route_fingerprint_ref", "verified_at",
]);
const FINGERPRINT_KEYS = new Set([
  "exact_model_id", "parameters_digest", "pricing_snapshot_ref", "prompt_generation", "provider",
  "route_ref", "route_version", "schema_generation",
]);

export interface StoredDynamicRouteCandidate {
  readonly row: {
    readonly candidate_ref: string;
    readonly candidate_sha256: string;
    readonly candidate_json: string;
    readonly route_ref: string;
    readonly route_version: string;
    readonly staged_at: string;
  };
  readonly candidate: DynamicRouteCandidate;
  readonly json: string;
  readonly sha256: string;
}

export interface DynamicRouteQualificationCandidateIdentity {
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
}

export interface DynamicRouteQualificationProof {
  readonly schema: typeof PROTOCOL;
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification: DynamicRouteQualificationEvidence;
}

export interface DynamicRouteQualificationProofWriteInput {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification: DynamicRouteQualificationEvidence;
}

export interface DynamicRouteQualificationProofWriteReceipt {
  readonly qualification_ref: string;
  readonly proof_sha256: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
}

export interface DynamicRouteQualificationLatestExpectation {
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
}

export interface DynamicRouteQualificationLatestPromotionInput
  extends DynamicRouteQualificationCandidateIdentity {
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly expected_latest: DynamicRouteQualificationLatestExpectation | null;
}

export interface DynamicRouteQualificationLatestPointer
  extends DynamicRouteQualificationCandidateIdentity {
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly activated_at: string;
}

export interface DynamicRouteQualificationProofStorePort {
  readLatest(
    candidate: DynamicRouteQualificationCandidateIdentity,
  ): Promise<DynamicRouteQualificationProof | null>;
  putImmutable(
    input: DynamicRouteQualificationProofWriteInput,
  ): Promise<DynamicRouteQualificationProofWriteReceipt>;
  promoteLatest(
    input: DynamicRouteQualificationLatestPromotionInput,
  ): Promise<DynamicRouteQualificationLatestPointer>;
}

interface CandidateRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly candidate_json: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly staged_at: unknown;
}

interface ProofRowRaw {
  readonly qualification_ref: unknown;
  readonly proof_sha256: unknown;
  readonly qualification_json: unknown;
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly created_at: unknown;
}

interface ProofRow {
  readonly qualification_ref: string;
  readonly proof_sha256: string;
  readonly qualification_json: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly created_at: string;
}

interface LatestRow {
  readonly route_ref: unknown;
  readonly route_version: unknown;
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly qualification_ref: unknown;
  readonly qualification_sha256: unknown;
  readonly activated_at: unknown;
}

const candidateSelect = "candidate_ref, candidate_sha256, candidate_json, route_ref, route_version, staged_at";
const proofSelect = "qualification_ref, proof_sha256, qualification_json, route_ref, route_version, candidate_ref, candidate_sha256, created_at";
const latestSelect = "route_ref, route_version, candidate_ref, candidate_sha256, qualification_ref, qualification_sha256, activated_at";

function fail(
  code: DynamicRouteProvisioningErrorCode,
  message: string,
  cause?: unknown,
): never {
  dynamicRouteProvisioningFailure(code, message, cause === undefined ? {} : { cause });
}

function identifier(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  return boundedDynamicRouteIdentifier(value, label, code);
}

function digest(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  return exactDynamicRouteSha256(value, label, code);
}

function timestamp(value: unknown, label: string, code: DynamicRouteProvisioningErrorCode): string {
  if (typeof value !== "string") fail(code, `${label} is not canonical UTC time`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(code, `${label} is not canonical UTC time`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): Record<string, unknown> {
  return exactDynamicRouteObject(value, keys, code, label);
}

export function decodeDynamicRouteCandidate(raw: unknown, code: DynamicRouteProvisioningErrorCode): DynamicRouteCandidate {
  const value = exactRecord(raw, CANDIDATE_KEYS, "dynamic route candidate", code);
  if (value.schema !== "eliotr.dynamic-route-candidate.v1") fail(code, "dynamic route candidate schema is unsupported");
  const deployment = decodeDynamicRouteDeploymentForProvisioning(value.deployment, code);
  const qualificationTier = value.qualification_tier;
  if (qualificationTier !== "FIXTURE" && qualificationTier !== "LIVE") {
    fail(code, "dynamic route candidate qualification tier is invalid");
  }
  return Object.freeze({
    schema: "eliotr.dynamic-route-candidate.v1",
    deployment,
    provider_route_id: identifier(value.provider_route_id, "candidate provider route ID", code),
    provider_route_name: providerDynamicRouteName(value.provider_route_name, "candidate provider route name", code),
    route_definition_sha256: digest(value.route_definition_sha256, "candidate route definition digest", code),
    provider_snapshot_sha256: digest(value.provider_snapshot_sha256, "candidate provider snapshot digest", code),
    control_plane_receipt_ref: identifier(value.control_plane_receipt_ref, "candidate control-plane receipt", code),
    qualification_tier: qualificationTier,
    control_plane_readback_ref: identifier(value.control_plane_readback_ref, "candidate control-plane readback", code),
    execution_probe_ref: identifier(value.execution_probe_ref, "candidate execution probe", code),
    qualification_expires_at: timestamp(value.qualification_expires_at, "candidate qualification expiry", code),
  });
}

export async function dynamicRouteCandidateArtifact(
  candidate: DynamicRouteCandidate,
): Promise<Readonly<{ json: string; sha256: string }>> {
  const artifact = await dynamicRouteJsonArtifact(candidate);
  return Object.freeze({ json: artifact.json, sha256: artifact.sha256 });
}

export function dynamicRouteCandidateRefForSha(sha256: string): string {
  return `dynamic-route-candidate-${sha256}`;
}

export async function decodeStoredDynamicRouteCandidate(
  raw: unknown,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): Promise<StoredDynamicRouteCandidate> {
  const value = exactRecord(raw, CANDIDATE_ROW_KEYS, label, code);
  const candidateRef = identifier(value.candidate_ref, `${label}.candidate_ref`, code);
  const rowSha = digest(value.candidate_sha256, `${label}.candidate_sha256`, code);
  const routeRef = identifier(value.route_ref, `${label}.route_ref`, code);
  const routeVersion = identifier(value.route_version, `${label}.route_version`, code);
  const stagedAt = timestamp(value.staged_at, `${label}.staged_at`, code);
  if (typeof value.candidate_json !== "string") fail(code, `${label}.candidate_json must be a string`);
  let parsed: unknown;
  try { parsed = JSON.parse(value.candidate_json) as unknown; }
  catch (cause) { fail(code, `${label}.candidate_json is invalid JSON`, cause); }
  const candidate = decodeDynamicRouteCandidate(parsed, code);
  const artifact = await dynamicRouteCandidateArtifact(candidate);
  if (artifact.json !== value.candidate_json || artifact.sha256 !== rowSha ||
      candidateRef !== dynamicRouteCandidateRefForSha(artifact.sha256) ||
      candidate.deployment.route_ref !== routeRef || candidate.deployment.route_version !== routeVersion) {
    fail(code, `${label} bytes or route identity differ from its stored candidate`);
  }
  return Object.freeze({
    row: Object.freeze({
      candidate_ref: candidateRef, candidate_sha256: rowSha, candidate_json: value.candidate_json,
      route_ref: routeRef, route_version: routeVersion, staged_at: stagedAt,
    }),
    candidate,
    json: artifact.json,
    sha256: artifact.sha256,
  });
}

function sameDeployment(
  left: { readonly route_ref: string; readonly route_version: string; readonly prompt_generation: string; readonly schema_generation: string; readonly parameters_digest: string; readonly pricing_snapshot_ref: string },
  right: { readonly route_ref: string; readonly route_version: string; readonly prompt_generation: string; readonly schema_generation: string; readonly parameters_digest: string; readonly pricing_snapshot_ref: string },
): boolean {
  return left.route_ref === right.route_ref && left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation && left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest && left.pricing_snapshot_ref === right.pricing_snapshot_ref;
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

function candidateIdentity(candidate: StoredDynamicRouteCandidate): DynamicRouteQualificationCandidateIdentity {
  return Object.freeze({
    route_ref: candidate.row.route_ref,
    route_version: candidate.row.route_version,
    candidate_ref: candidate.row.candidate_ref,
    candidate_sha256: candidate.sha256,
  });
}

async function assertObservationBinding(
  observationStore: ReturnType<typeof createD1ResearchModelQualificationObservationStore>,
  qualification: DynamicRouteQualificationEvidence,
  candidate: StoredDynamicRouteCandidate,
  code: DynamicRouteProvisioningErrorCode,
): Promise<void> {
  let raw: unknown;
  try { raw = await observationStore.read(qualification.execution_probe_ref); }
  catch (cause) { fail(code, "qualification proof observation could not be read", cause); }
  if (raw === null) fail(code, "qualification proof references a missing observation");
  const receipt = exactRecord(raw, OBSERVATION_RECEIPT_KEYS, "qualification proof observation receipt", code);
  if (receipt.protocol !== OBSERVATION_PROTOCOL || receipt.execution_probe_ref !== qualification.execution_probe_ref) {
    fail(code, "qualification proof observation reference is inconsistent");
  }
  digest(receipt.observation_sha256, "qualification proof observation digest", code);
  const observation = exactRecord(receipt.observation, OBSERVATION_KEYS, "qualification proof observation", code);
  if (observation.protocol !== OBSERVATION_PROTOCOL) fail(code, "qualification proof observation protocol is invalid");
  const fingerprint = exactRecord(observation.route_fingerprint, FINGERPRINT_KEYS, "qualification proof observation fingerprint", code);
  const deployment = decodeDynamicRouteDeploymentForProvisioning({
    route_ref: fingerprint.route_ref,
    route_version: fingerprint.route_version,
    prompt_generation: fingerprint.prompt_generation,
    schema_generation: fingerprint.schema_generation,
    parameters_digest: fingerprint.parameters_digest,
    pricing_snapshot_ref: fingerprint.pricing_snapshot_ref,
  }, code);
  if (!sameDeployment(deployment, candidate.candidate.deployment) ||
      timestamp(observation.verified_at, "qualification proof observation verified_at", code) !== qualification.verified_at ||
      timestamp(observation.expires_at, "qualification proof observation expires_at", code) !== qualification.expires_at) {
    fail(code, "qualification proof is not bound to the stored route observation");
  }
  identifier(fingerprint.provider, "qualification proof observed provider", code);
  identifier(fingerprint.exact_model_id, "qualification proof observed model", code);
  identifier(observation.gateway_log_id, "qualification proof observed gateway log", code);
}

async function proofForCandidate(
  raw: unknown,
  candidate: StoredDynamicRouteCandidate,
  observationStore: ReturnType<typeof createD1ResearchModelQualificationObservationStore>,
  now: string,
  requireCurrent: boolean,
  code: DynamicRouteProvisioningErrorCode,
): Promise<DynamicRouteQualificationProof> {
  const value = exactRecord(raw, PROOF_KEYS, "dynamic route qualification proof", code);
  if (value.schema !== PROTOCOL) fail(code, "dynamic route qualification proof protocol is invalid");
  if (candidate.candidate.qualification_tier !== "LIVE") fail(code, "qualification proof candidate is not LIVE");
  const candidateRef = identifier(value.candidate_ref, "qualification proof candidate", code);
  const candidateSha = digest(value.candidate_sha256, "qualification proof candidate digest", code);
  const routeRef = identifier(value.route_ref, "qualification proof route", code);
  const routeVersion = identifier(value.route_version, "qualification proof route version", code);
  const identity = candidateIdentity(candidate);
  if (candidateRef !== identity.candidate_ref || candidateSha !== identity.candidate_sha256 ||
      routeRef !== identity.route_ref || routeVersion !== identity.route_version) {
    fail(code, "qualification proof candidate identity differs from the immutable candidate");
  }
  const qualificationValue = exactRecord(value.qualification, new Set([
    "control_plane_readback_ref", "execution_probe_ref", "expires_at", "gateway_id", "parameters_digest",
    "pricing_snapshot_ref", "prompt_generation", "provider_route_id", "provider_route_name",
    "provider_snapshot_sha256", "route_definition_sha256", "route_ref", "route_version", "schema_generation",
    "tier", "verified_at",
  ]), "qualification proof evidence", code);
  const verifiedAt = timestamp(qualificationValue.verified_at, "qualification proof verified_at", code);
  let qualification: DynamicRouteQualificationEvidence;
  try {
    qualification = validateDynamicRouteQualification(
      qualificationValue,
      candidateReceipt(candidate),
      { environment: "PRODUCTION", expected_active_route_version: null, now: requireCurrent ? now : verifiedAt },
    );
  } catch (cause) {
    fail(code, "qualification proof evidence does not bind to the immutable candidate", cause);
  }
  if (requireCurrent && Date.parse(qualification.expires_at) <= Date.parse(now)) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof is expired");
  }
  await assertObservationBinding(observationStore, qualification, candidate, code);
  return Object.freeze({
    schema: PROTOCOL,
    route_ref: routeRef,
    route_version: routeVersion,
    candidate_ref: candidateRef,
    candidate_sha256: candidateSha,
    qualification,
  });
}

function proofRefForSha(sha256: string): string {
  return `dynamic-route-qualification-proof-${sha256}`;
}

async function proofArtifact(proof: DynamicRouteQualificationProof): Promise<Readonly<{ json: string; sha256: string }>> {
  const json = canonicalModelGatewayJson(proof);
  return Object.freeze({ json, sha256: await modelGatewaySha256(json) });
}

function proofRow(raw: unknown, label: string, code: DynamicRouteProvisioningErrorCode): ProofRow {
  const value = exactRecord(raw, PROOF_ROW_KEYS, label, code);
  return Object.freeze({
    qualification_ref: identifier(value.qualification_ref, `${label}.qualification_ref`, code),
    proof_sha256: digest(value.proof_sha256, `${label}.proof_sha256`, code),
    qualification_json: typeof value.qualification_json === "string" ? value.qualification_json : fail(code, `${label}.qualification_json is invalid`),
    route_ref: identifier(value.route_ref, `${label}.route_ref`, code),
    route_version: identifier(value.route_version, `${label}.route_version`, code),
    candidate_ref: identifier(value.candidate_ref, `${label}.candidate_ref`, code),
    candidate_sha256: digest(value.candidate_sha256, `${label}.candidate_sha256`, code),
    created_at: timestamp(value.created_at, `${label}.created_at`, code),
  });
}

function latestRow(raw: unknown, label: string, code: DynamicRouteProvisioningErrorCode): DynamicRouteQualificationLatestPointer {
  const value = exactRecord(raw, LATEST_ROW_KEYS, label, code);
  return Object.freeze({
    route_ref: identifier(value.route_ref, `${label}.route_ref`, code),
    route_version: identifier(value.route_version, `${label}.route_version`, code),
    candidate_ref: identifier(value.candidate_ref, `${label}.candidate_ref`, code),
    candidate_sha256: digest(value.candidate_sha256, `${label}.candidate_sha256`, code),
    qualification_ref: identifier(value.qualification_ref, `${label}.qualification_ref`, code),
    qualification_sha256: digest(value.qualification_sha256, `${label}.qualification_sha256`, code),
    activated_at: timestamp(value.activated_at, `${label}.activated_at`, code),
  });
}

function identityInput(raw: DynamicRouteQualificationCandidateIdentity, code: DynamicRouteProvisioningErrorCode): DynamicRouteQualificationCandidateIdentity {
  return Object.freeze({
    route_ref: identifier(raw.route_ref, "qualification route", code),
    route_version: identifier(raw.route_version, "qualification route version", code),
    candidate_ref: identifier(raw.candidate_ref, "qualification candidate", code),
    candidate_sha256: digest(raw.candidate_sha256, "qualification candidate digest", code),
  });
}

export interface D1DynamicRouteQualificationProofOptions {
  readonly now?: () => string;
}

export function createD1DynamicRouteQualificationProofStore(
  database: D1Database,
  options: D1DynamicRouteQualificationProofOptions = {},
): DynamicRouteQualificationProofStorePort {
  if (database === null || typeof database !== "object" || typeof database.prepare !== "function") {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof database binding is invalid");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof clock is invalid");
  }
  const nowSource = options.now ?? (() => new Date().toISOString());
  const now = () => timestamp(nowSource(), "qualification proof clock", "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
  const observationStore = createD1ResearchModelQualificationObservationStore(database, now);

  async function readCandidate(candidateRef: string): Promise<StoredDynamicRouteCandidate | null> {
    const row = await database.prepare(`SELECT ${candidateSelect} FROM dynamic_route_candidate WHERE candidate_ref=?1 LIMIT 1`)
      .bind(identifier(candidateRef, "qualification candidate", "DYNAMIC_ROUTE_QUALIFICATION_INVALID"))
      .first<CandidateRow>();
    return row === null ? null : decodeStoredDynamicRouteCandidate(row, "stored qualification candidate", "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
  }

  async function readProofByRef(
    qualificationRef: string,
    candidate: StoredDynamicRouteCandidate,
  ): Promise<Readonly<{ proof: DynamicRouteQualificationProof; row: ProofRow; json: string; sha256: string }>> {
    const raw = await database.prepare(`SELECT ${proofSelect} FROM dynamic_route_qualification_proof WHERE qualification_ref=?1 LIMIT 1`)
      .bind(identifier(qualificationRef, "qualification proof reference", "DYNAMIC_ROUTE_QUALIFICATION_INVALID"))
      .first<ProofRowRaw>();
    if (raw === null) fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof is missing");
    const row = proofRow(raw, "stored qualification proof", "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
    let parsed: unknown;
    try { parsed = JSON.parse(row.qualification_json); }
    catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "stored qualification proof is invalid JSON", cause); }
    const proof = await proofForCandidate(parsed, candidate, observationStore, now(), false, "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
    const artifact = await proofArtifact(proof);
    if (row.qualification_ref !== proofRefForSha(artifact.sha256) || row.proof_sha256 !== artifact.sha256 ||
        row.qualification_json !== artifact.json || row.route_ref !== proof.route_ref || row.route_version !== proof.route_version ||
        row.candidate_ref !== proof.candidate_ref || row.candidate_sha256 !== proof.candidate_sha256) {
      fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "stored qualification proof bytes or identity differ from its row");
    }
    return Object.freeze({ proof, row, json: artifact.json, sha256: artifact.sha256 });
  }

  async function readLatestPointer(identity: DynamicRouteQualificationCandidateIdentity): Promise<DynamicRouteQualificationLatestPointer | null> {
    const raw = await database.prepare(`SELECT ${latestSelect} FROM dynamic_route_active_qualification WHERE route_ref=?1 AND route_version=?2 LIMIT 1`)
      .bind(identity.route_ref, identity.route_version).first<LatestRow>();
    return raw === null ? null : latestRow(raw, "stored latest qualification", "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
  }

  return Object.freeze({
    async readLatest(rawIdentity: DynamicRouteQualificationCandidateIdentity): Promise<DynamicRouteQualificationProof | null> {
      const identity = identityInput(rawIdentity, "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
      const pointer = await readLatestPointer(identity);
      if (pointer === null) return null;
      if (pointer.route_ref !== identity.route_ref || pointer.route_version !== identity.route_version ||
          pointer.candidate_ref !== identity.candidate_ref || pointer.candidate_sha256 !== identity.candidate_sha256) {
        fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "latest qualification points at another immutable candidate");
      }
      const candidate = await readCandidate(identity.candidate_ref);
      if (candidate === null || candidate.sha256 !== identity.candidate_sha256) {
        fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "latest qualification candidate is missing or changed");
      }
      const stored = await readProofByRef(pointer.qualification_ref, candidate);
      if (stored.sha256 !== pointer.qualification_sha256) fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "latest qualification digest differs from its proof");
      return stored.proof;
    },

    async putImmutable(input: DynamicRouteQualificationProofWriteInput): Promise<DynamicRouteQualificationProofWriteReceipt> {
      const candidateRef = identifier(input.candidate_ref, "qualification candidate", "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
      const candidateSha = digest(input.candidate_sha256, "qualification candidate digest", "DYNAMIC_ROUTE_QUALIFICATION_INVALID");
      let qualificationSnapshot: unknown;
      try {
        qualificationSnapshot = JSON.parse(canonicalModelGatewayJson(input.qualification)) as unknown;
      } catch (cause) {
        fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification evidence cannot be canonicalized", cause);
      }
      const candidate = await readCandidate(candidateRef);
      if (candidate === null || candidate.sha256 !== candidateSha) fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification candidate does not match immutable D1 bytes");
      const qualification = await proofForCandidate(
        { schema: PROTOCOL, route_ref: candidate.row.route_ref, route_version: candidate.row.route_version,
          candidate_ref: candidateRef, candidate_sha256: candidateSha, qualification: qualificationSnapshot },
        candidate, observationStore, now(), true, "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      );
      const artifact = await proofArtifact(qualification);
      const existing = await database.prepare(`SELECT ${proofSelect} FROM dynamic_route_qualification_proof WHERE qualification_ref=?1 LIMIT 1`)
        .bind(proofRefForSha(artifact.sha256)).first<ProofRowRaw>();
      if (existing !== null) {
        const stored = await readProofByRef(proofRefForSha(artifact.sha256), candidate);
        if (stored.json !== artifact.json || stored.sha256 !== artifact.sha256) fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof reference is bound to different bytes");
        return Object.freeze({ qualification_ref: proofRefForSha(stored.sha256), proof_sha256: stored.sha256, candidate_ref: candidateRef, candidate_sha256: candidateSha });
      }
      const createdAt = now();
      try {
        await database.prepare(
          "INSERT INTO dynamic_route_qualification_proof(qualification_ref,proof_sha256,qualification_json,route_ref,route_version,candidate_ref,candidate_sha256,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(qualification_ref) DO NOTHING RETURNING " + proofSelect,
        ).bind(proofRefForSha(artifact.sha256), artifact.sha256, artifact.json, candidate.row.route_ref, candidate.row.route_version, candidateRef, candidateSha, createdAt).first<ProofRowRaw>();
      } catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof write failed", cause); }
      const stored = await readProofByRef(proofRefForSha(artifact.sha256), candidate);
      if (stored.json !== artifact.json || stored.sha256 !== artifact.sha256) fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "qualification proof write readback differs");
      return Object.freeze({ qualification_ref: proofRefForSha(stored.sha256), proof_sha256: stored.sha256, candidate_ref: candidateRef, candidate_sha256: candidateSha });
    },

    async promoteLatest(rawInput: DynamicRouteQualificationLatestPromotionInput): Promise<DynamicRouteQualificationLatestPointer> {
      const expectedLatest = rawInput.expected_latest === null ? null : exactRecord(
        rawInput.expected_latest,
        EXPECTED_LATEST_KEYS,
        "expected latest qualification",
        "DYNAMIC_ROUTE_PROMOTION_CONFLICT",
      );
      const input = Object.freeze({
        ...identityInput(rawInput, "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
        qualification_ref: identifier(rawInput.qualification_ref, "latest qualification reference", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
        qualification_sha256: digest(rawInput.qualification_sha256, "latest qualification digest", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
        expected_latest: expectedLatest === null ? null : Object.freeze({
          qualification_ref: identifier(expectedLatest.qualification_ref, "expected latest qualification reference", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
          qualification_sha256: digest(expectedLatest.qualification_sha256, "expected latest qualification digest", "DYNAMIC_ROUTE_PROMOTION_CONFLICT"),
        }),
      });
      const candidate = await readCandidate(input.candidate_ref);
      if (candidate === null || candidate.sha256 !== input.candidate_sha256) fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "latest qualification candidate is missing or changed");
      const stored = await readProofByRef(input.qualification_ref, candidate);
      if (stored.sha256 !== input.qualification_sha256 || stored.proof.route_ref !== input.route_ref || stored.proof.route_version !== input.route_version ||
          stored.proof.candidate_ref !== input.candidate_ref || stored.proof.candidate_sha256 !== input.candidate_sha256) {
        fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "latest qualification proof does not match the candidate snapshot");
      }
      const activatedAt = now();
      if (Date.parse(stored.proof.qualification.expires_at) <= Date.parse(activatedAt)) fail("DYNAMIC_ROUTE_QUALIFICATION_INVALID", "latest qualification proof is expired");
      let applied: LatestRow | null;
      if (input.expected_latest === null) {
        applied = await database.prepare(
          "INSERT INTO dynamic_route_active_qualification(route_ref,route_version,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256,activated_at) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(route_ref,route_version) DO NOTHING RETURNING " + latestSelect,
        ).bind(input.route_ref, input.route_version, input.candidate_ref, input.candidate_sha256, input.qualification_ref, input.qualification_sha256, activatedAt).first<LatestRow>();
      } else {
        applied = await database.prepare(
          "UPDATE dynamic_route_active_qualification SET qualification_ref=?3,qualification_sha256=?4,activated_at=?5 WHERE route_ref=?1 AND route_version=?2 AND qualification_ref=?6 AND qualification_sha256=?7 RETURNING " + latestSelect,
        ).bind(input.route_ref, input.route_version, input.qualification_ref, input.qualification_sha256, activatedAt, input.expected_latest.qualification_ref, input.expected_latest.qualification_sha256).first<LatestRow>();
      }
      if (applied === null) {
        const observed = await readLatestPointer(input);
        if (observed !== null && observed.route_ref === input.route_ref && observed.route_version === input.route_version &&
            observed.candidate_ref === input.candidate_ref && observed.candidate_sha256 === input.candidate_sha256 &&
            observed.qualification_ref === input.qualification_ref && observed.qualification_sha256 === input.qualification_sha256) return observed;
        fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "latest qualification CAS did not reach the requested proof");
      }
      const pointer = latestRow(applied, "promoted latest qualification", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
      if (pointer.route_ref !== input.route_ref || pointer.route_version !== input.route_version || pointer.candidate_ref !== input.candidate_ref ||
          pointer.candidate_sha256 !== input.candidate_sha256 || pointer.qualification_ref !== input.qualification_ref || pointer.qualification_sha256 !== input.qualification_sha256) {
        fail("DYNAMIC_ROUTE_PROMOTION_CONFLICT", "latest qualification readback differs from the requested proof");
      }
      return pointer;
    },
  });
}
