// IMPLEMENTED_NOT_LIVE: ER-36 authenticated Workspace candidate-bytes admission gate binds caller-supplied bytes to a durable OBSERVED_MATCH v2 observation plus a separate owner-issued exact-candidate authorization; the gate mints no source/evidence authority. Live connector readback (ELIOT-performed Google readback) remains unimplemented.
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import type { WorkspaceMcpObservationReadback } from "./workspace-mcp-ledger.js";

/**
 * Authenticated Workspace candidate-bytes admission gate (ER-36, S29/#221).
 *
 * A durable Workspace MCP observation is candidate-only by contract: it can never
 * establish source or evidence authority on its own. This gate binds caller-supplied
 * candidate bytes to one durable OBSERVED_MATCH observation and to a separate
 * owner-issued exact-candidate authorization, producing a typed admission intent that
 * the governed source pipeline can consume as provenance. The bytes still pass
 * through qualification; the intent mints no source, revision, or evidence handle.
 *
 * Live connector readback (ELIOT performing its own Google readback) is not part of
 * this gate and remains NOT_EXECUTED: `google_readback_performed_by_eliotr` stays
 * false until the managed OAuth client qualification completes.
 */

export const WORKSPACE_CANDIDATE_ADMISSION_PROTOCOL = "eliotr.workspace-mcp.candidate-admission.v1" as const;

/** Upper bound for a single admitted candidate payload; matches the evidence excerpt ceiling. */
export const MAX_WORKSPACE_CANDIDATE_BYTES = 8 * 1024 * 1024;

const MAX_AUTHORIZATION_REF_CHARS = 256;

export type WorkspaceCandidateAdmissionErrorCode =
  | "CANDIDATE_INPUT_INVALID"
  | "CANDIDATE_OBSERVATION_NOT_MATCHED"
  | "CANDIDATE_READBACK_MISSING"
  | "CANDIDATE_PAYLOAD_DIGEST_UNBOUND"
  | "CANDIDATE_PAYLOAD_DIGEST_MISMATCH"
  | "CANDIDATE_BYTES_OVERSIZED"
  | "CANDIDATE_PRINCIPAL_MISMATCH"
  | "CANDIDATE_AUTHORIZATION_MISSING";

export class WorkspaceCandidateAdmissionError extends Error {
  public readonly code: WorkspaceCandidateAdmissionErrorCode;
  public readonly retryable: boolean;

  public constructor(code: WorkspaceCandidateAdmissionErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WorkspaceCandidateAdmissionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface WorkspaceCandidateAdmissionInput {
  /** Durable observation readback from the candidate ledger; identity already verified by the store. */
  readonly readback: WorkspaceMcpObservationReadback;
  /** Candidate bytes whose SHA-256 must equal the observation's readback payload digest. Not retained. */
  readonly candidate_bytes: Uint8Array;
  /**
   * Owner-issued exact-candidate authorization reference. The caller validates it
   * against the owner grant store; the MCP principal must never be mistaken for
   * owner authorization.
   */
  readonly owner_authorization_ref: string;
}

export interface WorkspaceCandidateAdmission {
  readonly protocol: typeof WORKSPACE_CANDIDATE_ADMISSION_PROTOCOL;
  readonly observation_id: string;
  readonly plan_id: string;
  readonly receipt_sha256: string;
  readonly observation_sha256: string;
  readonly candidate_bytes_sha256: string;
  readonly candidate_byte_length: number;
  readonly principal_ref: string;
  readonly deployment_generation: string;
  readonly auth_profile: "service-token" | "managed-oauth";
  readonly google_transport: "gemini-mcp";
  readonly owner_authorization_ref: string;
  /** The admission binds bytes to the observation; it never establishes source/evidence authority. */
  readonly candidate_only: true;
  readonly source_evidence_authority_changed: false;
}

function fail(code: WorkspaceCandidateAdmissionErrorCode, message: string): never {
  throw new WorkspaceCandidateAdmissionError(code, message, false);
}

function invalid(message: string): never {
  fail("CANDIDATE_INPUT_INVALID", message);
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const view = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const digest = await crypto.subtle.digest("SHA-256", view as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Evaluates one candidate-bytes admission against a durable observation.
 * Every check fails closed with a typed code; no canonical ELIOT state changes.
 */
export async function evaluateWorkspaceCandidateAdmission(
  rawInput: WorkspaceCandidateAdmissionInput,
  context: McpToolCallContext,
): Promise<WorkspaceCandidateAdmission> {
  if (rawInput === null || typeof rawInput !== "object") invalid("candidate admission input is invalid");
  const { readback, candidate_bytes: candidateBytes, owner_authorization_ref: authorizationRef } = rawInput;
  if (readback === null || typeof readback !== "object" ||
      readback.observation === null || typeof readback.observation !== "object" ||
      readback.receipt === null || typeof readback.receipt !== "object" ||
      readback.provenance === null || typeof readback.provenance !== "object") {
    invalid("candidate admission observation readback is invalid");
  }
  if (!(candidateBytes instanceof Uint8Array)) invalid("candidate bytes must be a Uint8Array");
  if (candidateBytes.byteLength === 0) invalid("candidate bytes are empty");
  if (candidateBytes.byteLength > MAX_WORKSPACE_CANDIDATE_BYTES) {
    fail("CANDIDATE_BYTES_OVERSIZED", "candidate bytes exceed the admission ceiling");
  }
  if (typeof authorizationRef !== "string" || authorizationRef.length === 0 ||
      authorizationRef.length > MAX_AUTHORIZATION_REF_CHARS) {
    fail("CANDIDATE_AUTHORIZATION_MISSING", "owner-issued exact-candidate authorization reference is required");
  }
  if (context === null || typeof context !== "object" ||
      typeof context.principal_ref !== "string" || typeof context.deployment_generation !== "string") {
    invalid("candidate admission caller context is invalid");
  }

  const { observation, receipt, provenance } = readback;
  // The observation is candidate-only by contract; only an exact readback match
  // may have its bytes bound, and even then the bytes are not authority.
  if (observation.disposition !== "OBSERVED_MATCH" || observation.state !== "OBSERVED") {
    fail("CANDIDATE_OBSERVATION_NOT_MATCHED", "candidate observation is not an exact readback match");
  }
  if (observation.candidate_only !== true || observation.source_evidence_authority_changed !== false) {
    fail("CANDIDATE_OBSERVATION_NOT_MATCHED", "candidate observation authority flags are invalid");
  }
  if (receipt.readback_performed !== true) fail("CANDIDATE_READBACK_MISSING", "exact readback was not performed");
  const expectedDigest = receipt.readback_payload_sha256;
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/u.test(expectedDigest)) {
    fail("CANDIDATE_PAYLOAD_DIGEST_UNBOUND", "candidate observation has no readback payload digest");
  }
  // No cross-actor admission: only the actor that produced the observation may bind
  // its bytes. Owner admission of the same bytes uses the owner ingest path.
  if (context.principal_ref !== provenance.principal_ref ||
      context.deployment_generation !== provenance.deployment_generation) {
    fail("CANDIDATE_PRINCIPAL_MISMATCH", "candidate admission caller does not own the observation");
  }
  const bytesDigest = await sha256Bytes(candidateBytes);
  if (bytesDigest !== expectedDigest) {
    fail("CANDIDATE_PAYLOAD_DIGEST_MISMATCH", "candidate bytes do not match the observed readback digest");
  }

  return Object.freeze({
    protocol: WORKSPACE_CANDIDATE_ADMISSION_PROTOCOL,
    observation_id: provenance.observation_id,
    plan_id: provenance.plan_id,
    receipt_sha256: provenance.receipt_sha256,
    observation_sha256: provenance.observation_sha256,
    candidate_bytes_sha256: bytesDigest,
    candidate_byte_length: candidateBytes.byteLength,
    principal_ref: provenance.principal_ref,
    deployment_generation: provenance.deployment_generation,
    auth_profile: provenance.auth_profile,
    google_transport: provenance.google_transport,
    owner_authorization_ref: authorizationRef,
    candidate_only: true as const,
    source_evidence_authority_changed: false as const,
  });
}
