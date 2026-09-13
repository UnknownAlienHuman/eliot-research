import {
  canonicalModelGatewayJson,
  decodeAndVerifyDynamicRouteSnapshot,
  DYNAMIC_ROUTE_GATEWAY_ID,
  DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  parseDynamicRouteQualificationProbeInput,
  type DynamicRouteControlPlanePort,
  type DynamicRouteActiveGeneration,
  type DynamicRouteCompiledDesired,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationProbeInput,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import {
  ResolvedEvidenceSchema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  decodeModelRouteDeployment,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  createD1DynamicRouteQualificationProofStore,
  decodeStoredDynamicRouteCandidate,
  type DynamicRouteQualificationCandidateIdentity,
  type DynamicRouteQualificationLatestExpectation,
  type DynamicRouteQualificationProof,
  type StoredDynamicRouteCandidate,
} from "./model-gateway-qualification-d1.js";
import { createD1DynamicRouteRegistry } from "./model-gateway-deployment-registry-d1.js";
import { createD1ResearchModelPricingSnapshotStore } from "./research-model-pricing-store.js";
import { createD1ResearchModelQualificationObservationStore } from "./research-model-qualification-store.js";
import {
  createResearchQualificationPromptCompiler,
  parseResearchQualificationPromptConfig,
  type ResearchQualificationPromptConfig,
} from "./research-qualification-prompt.js";
import type { ResearchEvidencePack } from "./research-reference-manifest.js";
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_MODEL_BYTES = 256 * 1024;
const INPUT_KEYS = new Set(["candidate_ref", "candidate_sha256", "evidence_pack", "renewal_ref"]);
const PACK_KEYS = new Set(["pack_ref", "scope_snapshot_ref", "resolved_evidence", "omitted_candidates", "trace_ref", "total_utf8_bytes"]);
const OMITTED_KEYS = new Set(["candidate_id", "reason_code"]);
const LATEST_KEYS = new Set(["candidate_ref", "candidate_sha256", "qualification_ref", "qualification_sha256", "route_ref", "route_version"]);
const ACTIVE_KEYS = new Set(["candidate_ref", "candidate_sha256", "route_ref", "route_version"]);
const OBSERVATION_RECEIPT_KEYS = new Set(["execution_probe_ref", "observation", "observation_sha256", "protocol"]);
const OBSERVATION_KEYS = new Set([
  "expires_at", "gateway_log_id", "probe_idempotency_key", "probe_input_sha256", "protocol",
  "request_body_sha256", "request_parameters_sha256", "response_body_sha256", "response_model",
  "route_fingerprint", "route_fingerprint_ref", "verified_at",
]);
const FINGERPRINT_KEYS = new Set([
  "exact_model_id", "parameters_digest", "pricing_snapshot_ref", "prompt_generation", "provider",
  "route_ref", "route_version", "schema_generation",
]);
export type ResearchOwnerQualificationRenewalErrorCode =
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_MISSING"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CANDIDATE_UNAVAILABLE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE"
  | "RESEARCH_OWNER_QUALIFICATION_RENEWAL_PRICING_UNAVAILABLE";
export class ResearchOwnerQualificationRenewalError extends Error {
  public readonly code: ResearchOwnerQualificationRenewalErrorCode;
  public readonly retryable: boolean;
  public constructor(
    code: ResearchOwnerQualificationRenewalErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchOwnerQualificationRenewalError";
    this.code = code;
    this.retryable = retryable;
  }
}
export interface ResearchOwnerQualificationRenewalAssemblerDependencies {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly control_plane: Pick<DynamicRouteControlPlanePort, "get">;
  readonly prompt: ResearchQualificationPromptConfig;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly now: () => string;
}
export interface ResearchOwnerQualificationRenewalInput {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly renewal_ref: string;
  readonly evidence_pack: ResearchEvidencePack;
}
export interface ResearchOwnerQualificationRenewalAssembly {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly fresh: DynamicRouteQualificationProbeInput;
  readonly expected_latest: DynamicRouteQualificationLatestExpectation | null;
  readonly prompt_compiler: ModelGatewayPromptCompilerPort;
}
export interface ResearchOwnerQualificationRenewalAssembler {
  assemble(input: ResearchOwnerQualificationRenewalInput): Promise<ResearchOwnerQualificationRenewalAssembly>;
}
function fail(
  code: ResearchOwnerQualificationRenewalErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchOwnerQualificationRenewalError(code, message, retryable, cause);
}

function exactRecord(value: unknown, keys: ReadonlySet<string>, label: string, code: ResearchOwnerQualificationRenewalErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) fail(code, `${label} contains an unsupported field`);
  return record;
}

function identifier(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}
function activeGeneration(value: unknown): DynamicRouteActiveGeneration {
  const record = exactRecord(value, ACTIVE_KEYS, "active route generation", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE");
  return Object.freeze({
    route_ref: identifier(record.route_ref, "active route", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
    route_version: identifier(record.route_version, "active route version", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
    candidate_ref: identifier(record.candidate_ref, "active candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
    candidate_sha256: digest(record.candidate_sha256, "active candidate digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE"),
  });
}

function timestamp(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): string {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) fail(code, `${label} is invalid`);
  return value;
}
function nonnegativeBytes(value: unknown, label: string, code: ResearchOwnerQualificationRenewalErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_MODEL_BYTES) {
    fail(code, `${label} is outside the model byte bound`);
  }
  return value;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return canonicalModelGatewayJson(left) === canonicalModelGatewayJson(right);
}

function detached<T>(value: T, label: string, code: ResearchOwnerQualificationRenewalErrorCode): T {
  let json: string;
  try { json = canonicalModelGatewayJson(value); }
  catch (cause) { fail(code, `${label} is not canonical JSON`, false, cause); }
  if (new TextEncoder().encode(json).byteLength > MAX_CONFIG_BYTES && label.includes("configuration")) {
    fail(code, `${label} exceeds its byte bound`);
  }
  try { return JSON.parse(json) as T; }
  catch (cause) { fail(code, `${label} is not canonical JSON`, false, cause); }
}

function parseRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", `${label} is invalid`);
  return Object.freeze({ ...parsed.data });
}

function clock(now: () => string): { readonly text: string; readonly milliseconds: number } {
  let text: string;
  try { text = now(); }
  catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_MISSING", "renewal clock is unavailable", true, cause); }
  const milliseconds = Date.parse(text);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID", "renewal clock is not canonical UTC");
  }
  return Object.freeze({ text, milliseconds });
}

function parseInput(raw: unknown): ResearchOwnerQualificationRenewalInput {
  const value = exactRecord(raw, INPUT_KEYS, "qualification renewal input", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const candidateRef = identifier(value.candidate_ref, "candidate reference", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const candidateSha = digest(value.candidate_sha256, "candidate digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const renewalRef = identifier(value.renewal_ref, "renewal reference", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  return Object.freeze({
    candidate_ref: candidateRef,
    candidate_sha256: candidateSha,
    renewal_ref: renewalRef,
    evidence_pack: value.evidence_pack as ResearchEvidencePack,
  });
}

function parseEvidencePack(raw: unknown, access: ResearchQualificationPromptConfig["access"], maximumBytes: number): ResearchEvidencePack {
  const value = exactRecord(raw, PACK_KEYS, "renewal evidence pack", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
  const packRef = parseRef(value.pack_ref, "evidence pack reference");
  const scopeRef = parseRef(value.scope_snapshot_ref, "evidence pack scope");
  const traceRef = parseRef(value.trace_ref, "evidence pack trace");
  if (!Array.isArray(value.resolved_evidence) || value.resolved_evidence.length === 0 || value.resolved_evidence.length > 512) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack has no bounded resolved evidence");
  }
  if (!Array.isArray(value.omitted_candidates) || value.omitted_candidates.length > 512) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack omitted candidates are invalid");
  }
  if (typeof value.total_utf8_bytes !== "number" || !Number.isSafeInteger(value.total_utf8_bytes) || value.total_utf8_bytes < 0 || value.total_utf8_bytes > maximumBytes) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack exceeds the configured input bound");
  }
  const seen = new Set<string>();
  let excerptBytes = 0;
  const resolved = value.resolved_evidence.map((rawEvidence) => {
    const parsed = ResolvedEvidenceSchema.safeParse(rawEvidence);
    if (!parsed.success || parsed.data.handle.terminal_state !== "LIVE" ||
        !sameRef(parsed.data.handle.scope_snapshot_ref, scopeRef) ||
        parsed.data.credential_generation !== access.credential_generation) {
      fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack is not bound to current live owner evidence");
    }
    const key = `${parsed.data.handle.handle_ref.id}:${parsed.data.handle.handle_ref.revision}`;
    if (seen.has(key)) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack repeats a handle");
    seen.add(key);
    excerptBytes += new TextEncoder().encode(parsed.data.exact_excerpt).byteLength;
    return parsed.data;
  });
  if (excerptBytes > value.total_utf8_bytes) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "evidence pack byte accounting is invalid");
  const omitted = value.omitted_candidates.map((rawCandidate) => {
    const candidate = exactRecord(rawCandidate, OMITTED_KEYS, "omitted evidence candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
    return Object.freeze({
      candidate_id: identifier(candidate.candidate_id, "omitted candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"),
      reason_code: identifier(candidate.reason_code, "omitted candidate reason", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"),
    });
  });
  return detached({
    pack_ref: packRef,
    scope_snapshot_ref: scopeRef,
    resolved_evidence: resolved,
    omitted_candidates: omitted,
    trace_ref: traceRef,
    total_utf8_bytes: value.total_utf8_bytes,
  } as ResearchEvidencePack, "renewal evidence pack", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID");
}

async function readCandidate(
  database: D1Database,
  candidateRef: string,
  candidateSha: string,
): Promise<StoredDynamicRouteCandidate> {
  let raw: StoredDynamicRouteCandidate["row"] | null;
  try {
    raw = await database.prepare(
      "SELECT candidate_ref,candidate_sha256,candidate_json,route_ref,route_version,staged_at FROM dynamic_route_candidate WHERE candidate_ref=?1 LIMIT 1",
    ).bind(candidateRef).first<StoredDynamicRouteCandidate["row"]>();
  } catch (cause) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CANDIDATE_UNAVAILABLE", "candidate readback is unavailable", true, cause);
  }
  if (raw === null) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CANDIDATE_UNAVAILABLE", "candidate is unavailable");
  let candidate: StoredDynamicRouteCandidate;
  try {
    candidate = await decodeStoredDynamicRouteCandidate(raw, "renewal candidate", "DYNAMIC_ROUTE_PROMOTION_CONFLICT");
  } catch (cause) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CANDIDATE_UNAVAILABLE", "candidate bytes are invalid", false, cause);
  }
  if (candidate.row.candidate_ref !== candidateRef || candidate.sha256 !== candidateSha || candidate.candidate.qualification_tier !== "LIVE") {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "candidate identity or live qualification is stale");
  }
  return candidate;
}
async function readLatest(
  database: D1Database,
  proofStore: ReturnType<typeof createD1DynamicRouteQualificationProofStore>,
  candidate: StoredDynamicRouteCandidate,
): Promise<{ readonly proof: DynamicRouteQualificationProof | null; readonly expected: DynamicRouteQualificationLatestExpectation | null }> {
  interface LatestRow {
    readonly candidate_ref: unknown;
    readonly candidate_sha256: unknown;
    readonly qualification_ref: unknown;
    readonly qualification_sha256: unknown;
    readonly route_ref: unknown;
    readonly route_version: unknown;
  }
  let raw: LatestRow | null;
  try {
    raw = await database.prepare(
      "SELECT route_ref,route_version,candidate_ref,candidate_sha256,qualification_ref,qualification_sha256 FROM dynamic_route_active_qualification WHERE route_ref=?1 AND route_version=?2 LIMIT 1",
    ).bind(candidate.row.route_ref, candidate.row.route_version).first<LatestRow>();
  } catch (cause) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "latest qualification readback is unavailable", true, cause);
  }
  if (raw === null) return Object.freeze({ proof: null, expected: null });
  const value = exactRecord(raw, LATEST_KEYS, "latest qualification", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE");
  if (identifier(value.route_ref, "latest route", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE") !== candidate.row.route_ref ||
      identifier(value.route_version, "latest route version", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE") !== candidate.row.route_version ||
      identifier(value.candidate_ref, "latest candidate", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE") !== candidate.row.candidate_ref ||
      digest(value.candidate_sha256, "latest candidate digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE") !== candidate.sha256) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "latest qualification targets another candidate");
  }
  const qualificationRef = identifier(value.qualification_ref, "latest qualification reference", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE");
  const qualificationSha = digest(value.qualification_sha256, "latest qualification digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE");
  const identity: DynamicRouteQualificationCandidateIdentity = Object.freeze({
    route_ref: candidate.row.route_ref,
    route_version: candidate.row.route_version,
    candidate_ref: candidate.row.candidate_ref,
    candidate_sha256: candidate.sha256,
  });
  let proof: DynamicRouteQualificationProof | null;
  try { proof = await proofStore.readLatest(identity); }
  catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "latest qualification proof is unavailable", true, cause); }
  if (proof === null || proof.qualification.execution_probe_ref.length === 0) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "latest qualification proof is missing");
  }
  return Object.freeze({ proof, expected: Object.freeze({ qualification_ref: qualificationRef, qualification_sha256: qualificationSha }) });
}

async function readObservation(
  store: ReturnType<typeof createD1ResearchModelQualificationObservationStore>,
  ref: string,
  candidate: StoredDynamicRouteCandidate,
  expectedExpiry: string,
): Promise<{ readonly provider: string; readonly model: string; readonly verified_at: string; readonly expires_at: string }> {
  let raw: unknown;
  try { raw = await store.read(ref); }
  catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification observation is unavailable", true, cause); }
  if (raw === null) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification observation is missing");
  const receipt = exactRecord(raw, OBSERVATION_RECEIPT_KEYS, "qualification observation receipt", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  if (receipt.protocol !== "eliotr.dynamic-route-qualification-observation.v1" || receipt.execution_probe_ref !== ref) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification observation identity is invalid");
  }
  digest(receipt.observation_sha256, "qualification observation digest", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  const observation = exactRecord(receipt.observation, OBSERVATION_KEYS, "qualification observation", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  if (observation.protocol !== "eliotr.dynamic-route-qualification-observation.v1") {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification observation protocol is invalid");
  }
  const fingerprint = exactRecord(observation.route_fingerprint, FINGERPRINT_KEYS, "qualification route fingerprint", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  let deployment: ModelRouteDeployment;
  try {
    deployment = decodeModelRouteDeployment({
      route_ref: fingerprint.route_ref,
      route_version: fingerprint.route_version,
      prompt_generation: fingerprint.prompt_generation,
      schema_generation: fingerprint.schema_generation,
      parameters_digest: fingerprint.parameters_digest,
      pricing_snapshot_ref: fingerprint.pricing_snapshot_ref,
    });
  } catch (cause) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification route fingerprint is invalid", false, cause);
  }
  if (!sameDeployment(deployment, candidate.candidate.deployment)) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "qualification observation deployment differs from candidate");
  }
  const provider = identifier(fingerprint.provider, "observed provider", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  const model = identifier(fingerprint.exact_model_id, "observed model", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  if (observation.response_model !== model) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification response model differs from observation");
  const verifiedAt = timestamp(observation.verified_at, "qualification verified_at", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  const expiresAt = timestamp(observation.expires_at, "qualification expires_at", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  if (expiresAt !== expectedExpiry || Date.parse(expiresAt) <= Date.parse(verifiedAt)) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "qualification observation expiry differs from persisted proof");
  }
  identifier(observation.gateway_log_id, "qualification gateway log", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  for (const [value, label] of [
    [observation.probe_input_sha256, "probe input digest"],
    [observation.request_body_sha256, "request body digest"],
    [observation.request_parameters_sha256, "request parameters digest"],
    [observation.response_body_sha256, "response body digest"],
  ] as const) digest(value, label, "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  const fingerprintRef = identifier(observation.route_fingerprint_ref, "route fingerprint reference", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE");
  const expectedFingerprintRef = `route-fingerprint-${await modelGatewaySha256(canonicalModelGatewayJson(fingerprint))}`;
  if (fingerprintRef !== expectedFingerprintRef) fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_OBSERVATION_UNAVAILABLE", "qualification fingerprint reference differs from its bytes");
  return Object.freeze({ provider, model, verified_at: verifiedAt, expires_at: expiresAt });
}

async function readRoute(
  controlPlane: Pick<DynamicRouteControlPlanePort, "get">,
  candidate: StoredDynamicRouteCandidate,
): Promise<Readonly<{ route_definition: unknown }>> {
  let raw: unknown;
  try { raw = await controlPlane.get(DYNAMIC_ROUTE_GATEWAY_ID, candidate.candidate.provider_route_id); }
  catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE", "dynamic route readback is unavailable", true, cause); }
  const desired: DynamicRouteCompiledDesired = {
    deployment: candidate.candidate.deployment,
    route_definition: (raw as { readonly route_definition?: unknown })?.route_definition,
    route_definition_sha256: candidate.candidate.route_definition_sha256,
    provider_route_name: candidate.candidate.provider_route_name,
    create_request: {
      gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
      name: candidate.candidate.provider_route_name,
      route_definition: (raw as { readonly route_definition?: unknown })?.route_definition,
      metadata: {
        route_ref: candidate.candidate.deployment.route_ref,
        route_version: candidate.candidate.deployment.route_version,
        prompt_generation: candidate.candidate.deployment.prompt_generation,
        schema_generation: candidate.candidate.deployment.schema_generation,
        parameters_digest: candidate.candidate.deployment.parameters_digest,
        pricing_snapshot_ref: candidate.candidate.deployment.pricing_snapshot_ref,
        route_definition_sha256: candidate.candidate.route_definition_sha256,
      },
    },
  };
  let verified: Awaited<ReturnType<typeof decodeAndVerifyDynamicRouteSnapshot>>;
  try { verified = await decodeAndVerifyDynamicRouteSnapshot(raw, desired); }
  catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE", "dynamic route readback differs from the candidate", false, cause); }
  if (verified.snapshot.provider_route_id !== candidate.candidate.provider_route_id ||
      verified.snapshot.name !== candidate.candidate.provider_route_name ||
      verified.snapshot_sha256 !== candidate.candidate.provider_snapshot_sha256 ||
      !Array.isArray(verified.snapshot.route_definition) || verified.snapshot.route_definition.length === 0) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route readback is not bound to the candidate");
  }
  return Object.freeze({ route_definition: verified.snapshot.route_definition });
}

function qualificationDuration(
  verifiedAt: string,
  expiresAt: string,
): number {
  const duration = Date.parse(expiresAt) - Date.parse(verifiedAt);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "persisted qualification duration is outside its bound");
  }
  return duration;
}

export function createResearchOwnerQualificationRenewalAssembler(
  dependencies: ResearchOwnerQualificationRenewalAssemblerDependencies,
): ResearchOwnerQualificationRenewalAssembler {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" || typeof dependencies.search_database?.prepare !== "function" ||
      typeof dependencies.evidence_bucket?.get !== "function" || typeof dependencies.work_bucket?.get !== "function" ||
      typeof dependencies.work_bucket?.put !== "function" || typeof dependencies.control_plane?.get !== "function" ||
      typeof dependencies.now !== "function") {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_MISSING", "renewal dependencies are unavailable");
  }
  const maxInputBytes = nonnegativeBytes(dependencies.max_input_bytes, "configured max_input_bytes", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID");
  const maxOutputBytes = nonnegativeBytes(dependencies.max_output_bytes, "configured max_output_bytes", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID");
  let prompt: ResearchQualificationPromptConfig;
  try {
    prompt = parseResearchQualificationPromptConfig(detached(dependencies.prompt, "qualification prompt configuration", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID"));
  } catch (cause) {
    fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID", "qualification prompt configuration is invalid", false, cause);
  }
  const proofStore = createD1DynamicRouteQualificationProofStore(dependencies.database, { now: dependencies.now });
  const observations = createD1ResearchModelQualificationObservationStore(dependencies.database, dependencies.now);
  const pricing = createD1ResearchModelPricingSnapshotStore(dependencies.database);
  const registry = createD1DynamicRouteRegistry(dependencies.database, { environment: "PRODUCTION", now: dependencies.now });

  return Object.freeze({
    async assemble(rawInput: ResearchOwnerQualificationRenewalInput): Promise<ResearchOwnerQualificationRenewalAssembly> {
      const input = parseInput(detached(rawInput, "qualification renewal input", "RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID"));
      const pack = parseEvidencePack(input.evidence_pack, prompt.access, maxInputBytes);
      if (prompt.manifest_residency_template.scope_domain_id !== pack.scope_snapshot_ref.id ||
          prompt.manifest_residency_template.access_domain_id !== prompt.access.principal_ref) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID", "qualification prompt residency is not bound to the current owner scope");
      }
      const current = clock(dependencies.now);
      const candidate = await readCandidate(dependencies.database, input.candidate_ref, input.candidate_sha256);
      let rawActive: unknown;
      try { rawActive = await registry.getActive(candidate.row.route_ref); }
      catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "active route readback is unavailable", true, cause); }
      const active = rawActive === null ? null : activeGeneration(rawActive);
      if (active === null || active.route_ref !== candidate.row.route_ref || active.route_version !== candidate.row.route_version ||
          active.candidate_ref !== candidate.row.candidate_ref || active.candidate_sha256 !== candidate.sha256) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "candidate is not the active route generation");
      }
      const latest = await readLatest(dependencies.database, proofStore, candidate);
      const observationRef = latest.proof?.qualification.execution_probe_ref ?? candidate.candidate.execution_probe_ref;
      const expectedOldExpiry = latest.proof?.qualification.expires_at ?? candidate.candidate.qualification_expires_at;
      const observation = await readObservation(observations, observationRef, candidate, expectedOldExpiry);
      const duration = qualificationDuration(
        latest.proof?.qualification.verified_at ?? observation.verified_at,
        latest.proof?.qualification.expires_at ?? observation.expires_at,
      );
      let pricingSnapshot: Awaited<ReturnType<typeof pricing.read>>;
      try {
        pricingSnapshot = await pricing.read({
          pricing_snapshot_ref: candidate.candidate.deployment.pricing_snapshot_ref,
          route_ref: candidate.candidate.deployment.route_ref,
          route_version: candidate.candidate.deployment.route_version,
          provider: observation.provider,
          exact_model_id: observation.model,
        });
      } catch (cause) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_PRICING_UNAVAILABLE", "pricing snapshot readback is unavailable", true, cause);
      }
      if (pricingSnapshot === null || pricingSnapshot.pricing_basis !== "EXACT_TOKEN_RATES_V1" ||
          pricingSnapshot.approval_receipt_ref.length === 0) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_PRICING_UNAVAILABLE", "pricing snapshot does not cover the fresh proof");
      }
      const policyExpires = Date.parse(prompt.policy.expires_at);
      const pricingEffective = Date.parse(pricingSnapshot.effective_at);
      const pricingExpires = Date.parse(pricingSnapshot.expires_at);
      const expiresAtMilliseconds = Math.min(current.milliseconds + duration, policyExpires, pricingExpires);
      if (!Number.isSafeInteger(policyExpires) || !Number.isSafeInteger(pricingEffective) ||
          !Number.isSafeInteger(pricingExpires) || policyExpires <= current.milliseconds ||
          pricingEffective > current.milliseconds || pricingExpires <= current.milliseconds ||
          !Number.isSafeInteger(expiresAtMilliseconds) ||
          expiresAtMilliseconds - current.milliseconds <= prompt.request_timeout_ms) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_PRICING_UNAVAILABLE", "policy and pricing do not leave a bounded renewal window");
      }
      const expiresAt = new Date(expiresAtMilliseconds).toISOString();
      const route = await readRoute(dependencies.control_plane, candidate);
      const params = prompt.trusted_parameters;
      const parameterDigest = await modelGatewayRequestParametersSha256({
        model: candidate.candidate.deployment.route_ref,
        messages: [],
        max_tokens: params.max_tokens,
        ...(params.reasoning_effort === undefined ? {} : { reasoning_effort: params.reasoning_effort }),
        ...(params.response_format === undefined ? {} : { response_format: params.response_format }),
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        ...(params.stop === undefined ? {} : { stop: params.stop }),
        ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
        ...(params.top_p === undefined ? {} : { top_p: params.top_p }),
        stream: false,
      });
      if (parameterDigest !== candidate.candidate.deployment.parameters_digest) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID", "prompt parameters differ from the active route");
      }
      const identityJson = canonicalModelGatewayJson({
        protocol: "eliotr.research-owner-qualification-renewal.v1",
        candidate_ref: input.candidate_ref,
        candidate_sha256: input.candidate_sha256,
        renewal_ref: input.renewal_ref,
      });
      const identitySha = await modelGatewaySha256(identityJson);
      const probeIdempotencyKey = `research-qualification-renewal-${identitySha}`;
      const budgetReservationRef = `research-qualification-budget-${identitySha}`;
      const outputObjectRef = `model-qualification-output-${identitySha}`;
      const probePrompt: ResearchQualificationPromptConfig = Object.freeze({
        ...prompt,
        manifest_ref: Object.freeze({ id: `eliotr.research.qualification-manifest-${identitySha}`, revision: 1 }),
      });
      const provisioning: DynamicRouteProvisioningReceipt = Object.freeze({
        disposition: "EXISTING_MATCH",
        deployment: candidate.candidate.deployment,
        provider_route_id: candidate.candidate.provider_route_id,
        provider_route_name: candidate.candidate.provider_route_name,
        route_definition_sha256: candidate.candidate.route_definition_sha256,
        provider_snapshot_sha256: candidate.candidate.provider_snapshot_sha256,
        control_plane_receipt_ref: candidate.candidate.control_plane_receipt_ref,
      });
      const rawProbe = {
        provisioning,
        route_definition: route.route_definition,
        route_definition_sha256: candidate.candidate.route_definition_sha256,
        model_call: {
          route_ref: candidate.candidate.deployment.route_ref,
          prompt_generation: candidate.candidate.deployment.prompt_generation,
          schema_generation: candidate.candidate.deployment.schema_generation,
          evidence_pack: pack,
          output_object_ref: outputObjectRef,
          max_input_bytes: maxInputBytes,
          max_output_bytes: maxOutputBytes,
          budget_reservation_ref: budgetReservationRef,
        },
        expected_provider: observation.provider,
        expected_model: observation.model,
        probe_idempotency_key: probeIdempotencyKey,
        verified_at: current.text,
        expires_at: expiresAt,
      };
      let fresh: DynamicRouteQualificationProbeInput;
      try { fresh = parseDynamicRouteQualificationProbeInput(rawProbe) as DynamicRouteQualificationProbeInput; }
      catch (cause) { fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_INPUT_INVALID", "fresh qualification probe is invalid", false, cause); }
      let promptCompiler: ModelGatewayPromptCompilerPort;
      try {
        promptCompiler = await createResearchQualificationPromptCompiler({
          core_database: dependencies.database,
          search_database: dependencies.search_database,
          evidence_bucket: dependencies.evidence_bucket,
          work_bucket: dependencies.work_bucket,
          probe: fresh,
          config: probePrompt,
          now: () => clock(dependencies.now).milliseconds,
        });
      } catch (cause) {
        fail("RESEARCH_OWNER_QUALIFICATION_RENEWAL_CONFIGURATION_INVALID", "qualification prompt compiler is unavailable", false, cause);
      }
      return Object.freeze({
        candidate_ref: input.candidate_ref,
        candidate_sha256: input.candidate_sha256,
        fresh,
        expected_latest: latest.expected,
        prompt_compiler: promptCompiler,
      });
    },
  });
}
