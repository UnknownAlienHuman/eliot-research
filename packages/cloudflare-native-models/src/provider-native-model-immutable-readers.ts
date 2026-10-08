import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import {
  decodeProviderNativeModelCandidate,
  providerNativeModelFailure,
  type ProviderNativeModelCandidateV1,
} from "./provider-native-model-candidate.js";
import { decodeProviderNativeModelQualificationProof, type ProviderNativeModelCandidateProofBundleV1 } from "./provider-native-model-proof.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function valid(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function unavailable(message: string, cause?: unknown): never {
  providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", message, cause);
}

export interface ProviderNativeModelStoredCandidateV1 {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly candidate_json: string;
  readonly candidate: ProviderNativeModelCandidateV1;
}

export interface ProviderNativeModelStoredProofV1 {
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly qualification_json: string;
  readonly qualification: ProviderNativeModelCandidateProofBundleV1["proof"]["qualification"];
}

export interface ProviderNativeModelStoredRevocationV1 {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly revoked_by: string;
  readonly reason: string;
  readonly revoked_at: string;
}

interface CandidateRow {
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly candidate_json: unknown;
}

interface ProofRow {
  readonly qualification_ref: unknown;
  readonly qualification_sha256: unknown;
  readonly qualification_json: unknown;
}

type RevocationRow = ProviderNativeModelStoredRevocationV1;

export async function readProviderNativeModelCandidate(
  database: D1Database,
  input: Readonly<{ candidate_ref: string; candidate_sha256: string }>,
): Promise<ProviderNativeModelStoredCandidateV1 | null> {
  if (!valid(input.candidate_ref, IDENTIFIER) || !valid(input.candidate_sha256, SHA256)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native candidate lookup is malformed");
  }
  let row: CandidateRow | null;
  try {
    row = await database.prepare("SELECT candidate_ref,candidate_sha256,candidate_json FROM provider_native_model_candidate WHERE candidate_ref=?1 AND candidate_sha256=?2 LIMIT 1")
      .bind(input.candidate_ref, input.candidate_sha256).first<CandidateRow>();
  } catch (cause) { unavailable("native candidate readback is unavailable", cause); }
  if (row === null) return null;
  if (typeof row.candidate_json !== "string" || row.candidate_ref !== input.candidate_ref ||
      row.candidate_sha256 !== input.candidate_sha256) unavailable("native candidate row is malformed");
  let parsed: unknown;
  try { parsed = JSON.parse(row.candidate_json) as unknown; }
  catch (cause) { unavailable("native candidate JSON is invalid", cause); }
  const candidate = decodeProviderNativeModelCandidate(parsed);
  if (canonicalModelGatewayJson(candidate) !== row.candidate_json ||
      await modelGatewaySha256(row.candidate_json) !== input.candidate_sha256 ||
      input.candidate_ref !== `provider-native-model-candidate-${input.candidate_sha256}`) {
    unavailable("native candidate readback is not canonical");
  }
  return Object.freeze({ candidate_ref: input.candidate_ref, candidate_sha256: input.candidate_sha256,
    candidate_json: row.candidate_json, candidate });
}

export async function readProviderNativeModelProof(
  database: D1Database,
  input: Readonly<{ qualification_ref: string; qualification_sha256: string }>,
): Promise<ProviderNativeModelStoredProofV1 | null> {
  if (!valid(input.qualification_ref, IDENTIFIER) || !valid(input.qualification_sha256, SHA256)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native qualification proof lookup is malformed");
  }
  let row: ProofRow | null;
  try {
    row = await database.prepare("SELECT qualification_ref,qualification_sha256,qualification_json FROM provider_native_model_qualification_proof WHERE qualification_ref=?1 AND qualification_sha256=?2 LIMIT 1")
      .bind(input.qualification_ref, input.qualification_sha256).first<ProofRow>();
  } catch (cause) { unavailable("native qualification proof readback is unavailable", cause); }
  if (row === null) return null;
  if (typeof row.qualification_json !== "string" || row.qualification_ref !== input.qualification_ref ||
      row.qualification_sha256 !== input.qualification_sha256) unavailable("native qualification proof row is malformed");
  let parsed: unknown;
  try { parsed = JSON.parse(row.qualification_json) as unknown; }
  catch (cause) { unavailable("native qualification proof JSON is invalid", cause); }
  const sha = await modelGatewaySha256(row.qualification_json);
  if (canonicalModelGatewayJson(parsed) !== row.qualification_json || sha !== row.qualification_sha256 ||
      input.qualification_ref !== `provider-native-model-qualification-${sha}`) {
    unavailable("native qualification proof is not canonical");
  }
  return Object.freeze({ qualification_ref: input.qualification_ref, qualification_sha256: sha,
    qualification_json: row.qualification_json, qualification: decodeProviderNativeModelQualificationProof(parsed) });
}

export async function readProviderNativeModelRevocation(
  database: D1Database,
  input: Readonly<{ qualification_ref: string; qualification_sha256: string }>,
): Promise<ProviderNativeModelStoredRevocationV1 | null> {
  if (!valid(input.qualification_ref, IDENTIFIER) || !valid(input.qualification_sha256, SHA256)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native revocation lookup is malformed");
  }
  let row: RevocationRow | null;
  try {
    row = await database.prepare("SELECT owner_ref,project_id,revoked_by,reason,revoked_at FROM provider_native_model_qualification_revocation WHERE qualification_ref=?1 AND qualification_sha256=?2 LIMIT 1")
      .bind(input.qualification_ref, input.qualification_sha256).first<RevocationRow>();
  } catch (cause) { unavailable("native qualification revocation readback is unavailable", cause); }
  if (row === null) return null;
  if (!valid(row.owner_ref, IDENTIFIER) || !valid(row.project_id, IDENTIFIER) || !valid(row.revoked_by, IDENTIFIER) ||
      typeof row.reason !== "string" || row.reason.trim().length === 0 || typeof row.revoked_at !== "string" ||
      !Number.isFinite(Date.parse(row.revoked_at)) || new Date(Date.parse(row.revoked_at)).toISOString() !== row.revoked_at) {
    unavailable("native qualification revocation is malformed");
  }
  return Object.freeze({ owner_ref: row.owner_ref, project_id: row.project_id, revoked_by: row.revoked_by,
    reason: row.reason, revoked_at: row.revoked_at });
}
