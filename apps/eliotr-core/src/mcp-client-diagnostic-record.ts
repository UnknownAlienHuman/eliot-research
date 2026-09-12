import {
  IdentifierSchema,
  type McpDiagnosticAuthProfile,
  type McpDiagnosticChallengeResult,
  type McpDiagnosticConsumeResult,
  type McpDiagnosticLatestStatus,
} from "@eliotr/contracts";
import type { McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";

export const MCP_DIAGNOSTIC_TTL_MS = 5 * 60 * 1000;

export interface McpClientDiagnosticOwner {
  readonly principal_ref: string;
  readonly credential_generation: string;
}

export interface McpClientDiagnosticServiceOptions {
  readonly now: () => number;
  readonly auth_profile: McpDiagnosticAuthProfile;
  readonly deployment_generation: string;
}

export type McpClientDiagnosticContext = McpToolCallContext;

export type McpClientDiagnosticServiceErrorCode =
  | "MCP_DIAGNOSTIC_CONFIG_INVALID"
  | "MCP_DIAGNOSTIC_CLOCK_INVALID"
  | "MCP_DIAGNOSTIC_OWNER_INVALID"
  | "MCP_DIAGNOSTIC_INPUT_INVALID"
  | "MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED"
  | "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID"
  | "MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH"
  | "MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH"
  | "MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED"
  | "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND"
  | "MCP_DIAGNOSTIC_CHALLENGE_EXPIRED"
  | "MCP_DIAGNOSTIC_TOKEN_INVALID"
  | "MCP_DIAGNOSTIC_CHALLENGE_REPLAY"
  | "MCP_DIAGNOSTIC_CHALLENGE_STALE"
  | "MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE"
  | "MCP_DIAGNOSTIC_D1_UNAVAILABLE"
  | "MCP_DIAGNOSTIC_D1_CORRUPT"
  | "MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN";

export class McpClientDiagnosticServiceError extends Error {
  public readonly code: McpClientDiagnosticServiceErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(
    code: McpClientDiagnosticServiceErrorCode,
    status: number,
    retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "McpClientDiagnosticServiceError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface McpClientDiagnosticService {
  issue(owner: McpClientDiagnosticOwner): Promise<McpDiagnosticChallengeResult>;
  latest(owner: McpClientDiagnosticOwner): Promise<McpDiagnosticLatestStatus | null>;
  consume(input: unknown, context: McpClientDiagnosticContext): Promise<McpDiagnosticConsumeResult>;
}

export interface DiagnosticConfig {
  readonly now: () => number;
  readonly auth_profile: McpDiagnosticAuthProfile;
  readonly deployment_generation: string;
}

export interface ChallengeRow {
  readonly challenge_id: string;
  readonly token_sha256: string;
  readonly owner_principal_ref: string;
  readonly owner_credential_generation: string;
  readonly deployment_generation: string;
  readonly auth_profile: McpDiagnosticAuthProfile;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly state: "ISSUED" | "CONFIRMED";
  readonly observation_ref: string | null;
  readonly observed_at: string | null;
  readonly trace_id: string | null;
  readonly verified_actor_ref: string | null;
  readonly verified_credential_generation: string | null;
  readonly verified_authentication_method: "cloudflare_access" | "service_token" | null;
  readonly verified_expires_at: string | null;
}

export interface RawChallengeRow {
  readonly challenge_id: unknown;
  readonly token_sha256: unknown;
  readonly owner_principal_ref: unknown;
  readonly owner_credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly auth_profile: unknown;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly state: unknown;
  readonly observation_ref: unknown;
  readonly observed_at: unknown;
  readonly trace_id: unknown;
  readonly verified_actor_ref: unknown;
  readonly verified_credential_generation: unknown;
  readonly verified_authentication_method: unknown;
  readonly verified_expires_at: unknown;
}

export interface IssuedExpectation {
  readonly challenge_id: string;
  readonly token_sha256: string;
  readonly owner: McpClientDiagnosticOwner;
  readonly deployment_generation: string;
  readonly auth_profile: McpDiagnosticAuthProfile;
  readonly issued_at: string;
  readonly expires_at: string;
}

export interface ConfirmedExpectation {
  readonly challenge_id: string;
  readonly token_sha256: string;
  readonly owner_principal_ref: string;
  readonly owner_credential_generation: string;
  readonly deployment_generation: string;
  readonly auth_profile: McpDiagnosticAuthProfile;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly observation_ref: string;
  readonly observed_at: string;
  readonly trace_id: string;
  readonly verified_actor_ref: string;
  readonly verified_credential_generation: string;
  readonly verified_authentication_method: "cloudflare_access" | "service_token";
  readonly verified_expires_at: string;
}

export const AUTH_PROFILE_METHOD: Readonly<Record<McpDiagnosticAuthProfile, "cloudflare_access" | "service_token">> = {
  "service-token": "service_token",
  "managed-oauth": "cloudflare_access",
};

const CHALLENGE_COLUMNS = [
  "challenge_id",
  "token_sha256",
  "owner_principal_ref",
  "owner_credential_generation",
  "deployment_generation",
  "auth_profile",
  "issued_at",
  "expires_at",
  "state",
  "observation_ref",
  "observed_at",
  "trace_id",
  "verified_actor_ref",
  "verified_credential_generation",
  "verified_authentication_method",
  "verified_expires_at",
] as const;

export const SELECT_BY_ID =
  `SELECT ${CHALLENGE_COLUMNS.join(",")} FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1`;
export const SELECT_LATEST =
  `SELECT ${CHALLENGE_COLUMNS.join(",")} FROM mcp_client_diagnostic_challenge ` +
  "WHERE owner_principal_ref=?1 AND owner_credential_generation=?2 AND deployment_generation=?3 " +
  "ORDER BY issued_at DESC, challenge_id DESC LIMIT 1";

export function fail(
  code: McpClientDiagnosticServiceErrorCode,
  status: number,
  retryable: boolean,
  message: string,
): never {
  throw new McpClientDiagnosticServiceError(code, status, retryable, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function timestampFor(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds)) {
    fail("MCP_DIAGNOSTIC_CLOCK_INVALID", 503, true, "diagnostic timestamp is invalid");
  }
  try {
    const timestamp = new Date(milliseconds).toISOString();
    if (!isCanonicalTimestamp(timestamp)) {
      fail("MCP_DIAGNOSTIC_CLOCK_INVALID", 503, true, "diagnostic timestamp is invalid");
    }
    return timestamp;
  } catch {
    fail("MCP_DIAGNOSTIC_CLOCK_INVALID", 503, true, "diagnostic timestamp is invalid");
  }
}

export function currentTime(now: () => number): { readonly milliseconds: number; readonly timestamp: string } {
  let milliseconds: number;
  try {
    milliseconds = now();
  } catch {
    fail("MCP_DIAGNOSTIC_CLOCK_INVALID", 503, true, "diagnostic clock is unavailable");
  }
  if (!Number.isSafeInteger(milliseconds)) {
    fail("MCP_DIAGNOSTIC_CLOCK_INVALID", 503, true, "diagnostic clock is invalid");
  }
  return { milliseconds, timestamp: timestampFor(milliseconds) };
}

export function requiredIdentifier(value: unknown, code: McpClientDiagnosticServiceErrorCode, message: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    const serviceUnavailable = code === "MCP_DIAGNOSTIC_CONFIG_INVALID" || code === "MCP_DIAGNOSTIC_D1_CORRUPT";
    const contextDenied = code === "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID";
    fail(code, serviceUnavailable ? 503 : contextDenied ? 403 : 400, serviceUnavailable, message);
  }
  return parsed.data;
}

export function requiredOwner(raw: McpClientDiagnosticOwner): McpClientDiagnosticOwner {
  if (!isRecord(raw)) fail("MCP_DIAGNOSTIC_OWNER_INVALID", 400, false, "diagnostic owner is invalid");
  const principalRef = requiredIdentifier(raw.principal_ref, "MCP_DIAGNOSTIC_OWNER_INVALID", "diagnostic owner is invalid");
  const credentialGeneration = requiredIdentifier(raw.credential_generation, "MCP_DIAGNOSTIC_OWNER_INVALID", "diagnostic owner is invalid");
  return Object.freeze({
    principal_ref: principalRef,
    credential_generation: credentialGeneration,
  });
}

export function copyConfig(options: McpClientDiagnosticServiceOptions): DiagnosticConfig {
  if (!isRecord(options) || typeof options.now !== "function") {
    fail("MCP_DIAGNOSTIC_CONFIG_INVALID", 503, true, "diagnostic service configuration is invalid");
  }
  if (options.auth_profile !== "service-token" && options.auth_profile !== "managed-oauth") {
    fail("MCP_DIAGNOSTIC_CONFIG_INVALID", 503, true, "diagnostic service configuration is invalid");
  }
  const deploymentGeneration = requiredIdentifier(options.deployment_generation, "MCP_DIAGNOSTIC_CONFIG_INVALID", "diagnostic service configuration is invalid");
  return Object.freeze({
    now: options.now,
    auth_profile: options.auth_profile,
    deployment_generation: deploymentGeneration,
  });
}

function hasSelectedColumns(raw: Record<string, unknown>): boolean {
  return CHALLENGE_COLUMNS.every((column) => Object.prototype.hasOwnProperty.call(raw, column));
}

export function parseRawChallengeRow(raw: unknown): ChallengeRow {
  if (!isRecord(raw) || !hasSelectedColumns(raw)) {
    fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  }
  const challengeId = requiredIdentifier(raw.challenge_id, "MCP_DIAGNOSTIC_D1_CORRUPT", "diagnostic row is corrupt");
  const tokenSha256 = raw.token_sha256;
  if (typeof tokenSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(tokenSha256)) {
    fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  }
  const ownerPrincipalRef = requiredIdentifier(raw.owner_principal_ref, "MCP_DIAGNOSTIC_D1_CORRUPT", "diagnostic row is corrupt");
  const ownerCredentialGeneration = requiredIdentifier(raw.owner_credential_generation, "MCP_DIAGNOSTIC_D1_CORRUPT", "diagnostic row is corrupt");
  const deploymentGeneration = requiredIdentifier(raw.deployment_generation, "MCP_DIAGNOSTIC_D1_CORRUPT", "diagnostic row is corrupt");
  const authProfile = raw.auth_profile;
  if (authProfile !== "service-token" && authProfile !== "managed-oauth") {
    fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  }
  const issuedAt = raw.issued_at;
  const expiresAt = raw.expires_at;
  if (!isCanonicalTimestamp(issuedAt) || !isCanonicalTimestamp(expiresAt) || Date.parse(expiresAt) <= Date.parse(issuedAt)) {
    fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  }
  if (raw.state !== "ISSUED" && raw.state !== "CONFIRMED") {
    fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  }

  const nullableIdentifier = (value: unknown): string | null => {
    if (value === null) return null;
    return requiredIdentifier(value, "MCP_DIAGNOSTIC_D1_CORRUPT", "diagnostic row is corrupt");
  };
  const observationRef = nullableIdentifier(raw.observation_ref);
  const observedAtRaw = raw.observed_at;
  const observedAt = observedAtRaw === null
    ? null
    : isCanonicalTimestamp(observedAtRaw) ? observedAtRaw : fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  const traceId = nullableIdentifier(raw.trace_id);
  const verifiedActorRef = nullableIdentifier(raw.verified_actor_ref);
  const verifiedCredentialGeneration = nullableIdentifier(raw.verified_credential_generation);
  const methodRaw = raw.verified_authentication_method;
  const verifiedAuthenticationMethod = methodRaw === null
    ? null
    : methodRaw === "cloudflare_access" || methodRaw === "service_token"
      ? methodRaw
      : fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
  const verifiedExpiresAtRaw = raw.verified_expires_at;
  const verifiedExpiresAt = verifiedExpiresAtRaw === null
    ? null
    : isCanonicalTimestamp(verifiedExpiresAtRaw) ? verifiedExpiresAtRaw : fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");

  if (raw.state === "ISSUED") {
    if (observationRef !== null || observedAt !== null || traceId !== null || verifiedActorRef !== null ||
        verifiedCredentialGeneration !== null || verifiedAuthenticationMethod !== null || verifiedExpiresAt !== null) {
      fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
    }
  } else {
    if (observationRef === null || observedAt === null || traceId === null || verifiedActorRef === null ||
        verifiedCredentialGeneration === null || verifiedAuthenticationMethod === null || verifiedExpiresAt === null ||
        verifiedAuthenticationMethod !== AUTH_PROFILE_METHOD[authProfile] ||
        Date.parse(observedAt) < Date.parse(issuedAt) || Date.parse(observedAt) >= Date.parse(expiresAt) ||
        Date.parse(verifiedExpiresAt) <= Date.parse(observedAt)) {
      fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic row is corrupt");
    }
  }

  return Object.freeze({
    challenge_id: challengeId,
    token_sha256: tokenSha256,
    owner_principal_ref: ownerPrincipalRef,
    owner_credential_generation: ownerCredentialGeneration,
    deployment_generation: deploymentGeneration,
    auth_profile: authProfile,
    issued_at: issuedAt,
    expires_at: expiresAt,
    state: raw.state,
    observation_ref: observationRef,
    observed_at: observedAt,
    trace_id: traceId,
    verified_actor_ref: verifiedActorRef,
    verified_credential_generation: verifiedCredentialGeneration,
    verified_authentication_method: verifiedAuthenticationMethod,
    verified_expires_at: verifiedExpiresAt,
  });
}

export function mutationChanges(result: unknown): number | undefined {
  if (!isRecord(result) || !isRecord(result.meta)) return undefined;
  return typeof result.meta.changes === "number" ? result.meta.changes : undefined;
}

export function exactIssued(row: ChallengeRow, expected: IssuedExpectation): boolean {
  return row.state === "ISSUED" && row.challenge_id === expected.challenge_id &&
    row.token_sha256 === expected.token_sha256 &&
    row.owner_principal_ref === expected.owner.principal_ref &&
    row.owner_credential_generation === expected.owner.credential_generation &&
    row.deployment_generation === expected.deployment_generation && row.auth_profile === expected.auth_profile &&
    row.issued_at === expected.issued_at && row.expires_at === expected.expires_at &&
    row.observation_ref === null && row.observed_at === null && row.trace_id === null &&
    row.verified_actor_ref === null && row.verified_credential_generation === null &&
    row.verified_authentication_method === null && row.verified_expires_at === null;
}

export function exactConfirmed(row: ChallengeRow, expected: ConfirmedExpectation): boolean {
  return row.state === "CONFIRMED" && row.challenge_id === expected.challenge_id &&
    row.token_sha256 === expected.token_sha256 &&
    row.owner_principal_ref === expected.owner_principal_ref &&
    row.owner_credential_generation === expected.owner_credential_generation &&
    row.deployment_generation === expected.deployment_generation && row.auth_profile === expected.auth_profile &&
    row.issued_at === expected.issued_at && row.expires_at === expected.expires_at &&
    row.observation_ref === expected.observation_ref && row.observed_at === expected.observed_at &&
    row.trace_id === expected.trace_id && row.verified_actor_ref === expected.verified_actor_ref &&
    row.verified_credential_generation === expected.verified_credential_generation &&
    row.verified_authentication_method === expected.verified_authentication_method &&
    row.verified_expires_at === expected.verified_expires_at;
}

export function byteString(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export async function randomToken(): Promise<string> {
  try {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return byteString(bytes);
  } catch {
    fail("MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE", 503, true, "diagnostic token generation is unavailable");
  }
}

export async function randomIdentifier(prefix: string): Promise<string> {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    fail("MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE", 503, true, "diagnostic identity generation is unavailable");
  }
}

export async function tokenDigest(token: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return byteString(new Uint8Array(digest));
  } catch {
    fail("MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE", 503, true, "diagnostic token hashing is unavailable");
  }
}
