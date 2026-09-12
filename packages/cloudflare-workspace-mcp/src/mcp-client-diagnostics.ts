import type { D1Database } from "@cloudflare/workers-types";
import {
  MCP_DIAGNOSTIC_PROTOCOL,
  McpDiagnosticChallengeResultSchema,
  McpDiagnosticConsumeInputSchema,
  McpDiagnosticConsumeResultSchema,
  McpDiagnosticLatestStatusSchema,
  type McpDiagnosticChallengeResult,
  type McpDiagnosticConsumeResult,
  type McpDiagnosticLatestStatus,
} from "@eliotr/contracts";
import {
  AUTH_PROFILE_METHOD,
  MCP_DIAGNOSTIC_TTL_MS,
  McpClientDiagnosticServiceError,
  currentTime,
  copyConfig,
  exactConfirmed,
  exactIssued,
  fail,
  isCanonicalTimestamp,
  isRecord,
  parseRawChallengeRow,
  randomIdentifier,
  randomToken,
  requiredIdentifier,
  requiredOwner,
  SELECT_BY_ID,
  SELECT_LATEST,
  timestampFor,
  tokenDigest,
  mutationChanges,
  type ChallengeRow,
  type ConfirmedExpectation,
  type DiagnosticConfig,
  type IssuedExpectation,
  type McpClientDiagnosticContext,
  type McpClientDiagnosticOwner,
  type McpClientDiagnosticService,
  type McpClientDiagnosticServiceOptions,
  type RawChallengeRow,
} from "./mcp-client-diagnostic-record.js";

export {
  MCP_DIAGNOSTIC_TTL_MS,
  McpClientDiagnosticServiceError,
  type McpClientDiagnosticContext,
  type McpClientDiagnosticOwner,
  type McpClientDiagnosticService,
  type McpClientDiagnosticServiceErrorCode,
  type McpClientDiagnosticServiceOptions,
} from "./mcp-client-diagnostic-record.js";

function publicChallenge(
  expected: IssuedExpectation,
  token: string,
): McpDiagnosticChallengeResult {
  const parsed = McpDiagnosticChallengeResultSchema.safeParse({
    protocol: MCP_DIAGNOSTIC_PROTOCOL,
    status: "ISSUED",
    challenge_id: expected.challenge_id,
    challenge_token: token,
    issued_at: expected.issued_at,
    expires_at: expected.expires_at,
    deployment_generation: expected.deployment_generation,
    auth_profile: expected.auth_profile,
  });
  if (!parsed.success) fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic challenge result is invalid");
  return Object.freeze(parsed.data);
}

function publicLatest(row: ChallengeRow, nowMilliseconds: number): McpDiagnosticLatestStatus {
  const base = {
    protocol: MCP_DIAGNOSTIC_PROTOCOL,
    challenge_id: row.challenge_id,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    deployment_generation: row.deployment_generation,
    auth_profile: row.auth_profile,
  };
  const value = row.state === "CONFIRMED"
    ? {
        ...base,
        status: "CONFIRMED" as const,
        observation_ref: row.observation_ref,
        observed_at: row.observed_at,
        trace_id: row.trace_id,
      }
    : {
        ...base,
        status: nowMilliseconds >= Date.parse(row.expires_at) ? "EXPIRED" as const : "ISSUED" as const,
      };
  const parsed = McpDiagnosticLatestStatusSchema.safeParse(value);
  if (!parsed.success) fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic status result is invalid");
  return Object.freeze(parsed.data);
}

function publicConsume(row: ChallengeRow): McpDiagnosticConsumeResult {
  const parsed = McpDiagnosticConsumeResultSchema.safeParse({
    protocol: MCP_DIAGNOSTIC_PROTOCOL,
    status: "CONFIRMED",
    challenge_id: row.challenge_id,
    observation_ref: row.observation_ref,
    observed_at: row.observed_at,
    auth_profile: row.auth_profile,
    deployment_generation: row.deployment_generation,
    trace_id: row.trace_id,
  });
  if (!parsed.success) fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic observation result is invalid");
  return Object.freeze(parsed.data);
}

function snapshotContext(
  raw: McpClientDiagnosticContext,
  config: DiagnosticConfig,
  nowMilliseconds: number,
): {
  readonly principal_ref: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
  readonly actor_ref: string;
  readonly credential_generation: string;
  readonly authentication_method: "cloudflare_access" | "service_token";
  readonly expires_at: string;
  readonly auth_profile: "service-token" | "managed-oauth";
} {
  if (!isRecord(raw)) fail("MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED", 401, false, "verified MCP context is required");
  const principalRef = requiredIdentifier(raw.principal_ref, "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", "verified MCP context is invalid");
  const traceId = requiredIdentifier(raw.trace_id, "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", "verified MCP context is invalid");
  const deploymentGeneration = requiredIdentifier(raw.deployment_generation, "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", "verified MCP context is invalid");
  const verified = raw.verified_actor;
  if (!isRecord(verified)) fail("MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED", 401, false, "verified MCP context is required");
  const actorRef = requiredIdentifier(verified.actor_ref, "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", "verified MCP context is invalid");
  const credentialGeneration = requiredIdentifier(verified.credential_generation, "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", "verified MCP context is invalid");
  const expiresAt = verified.expires_at;
  if (!isCanonicalTimestamp(expiresAt)) fail("MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", 403, false, "verified MCP context is invalid");
  const authProfile = verified.auth_profile;
  if (authProfile !== "service-token" && authProfile !== "managed-oauth") {
    fail("MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH", 403, false, "verified MCP profile is not selected");
  }
  const authenticationMethod = verified.authentication_method;
  if (authenticationMethod !== "cloudflare_access" && authenticationMethod !== "service_token") {
    fail("MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", 403, false, "verified MCP context is invalid");
  }
  const verifiedDeploymentGeneration = requiredIdentifier(verified.deployment_generation, "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", "verified MCP context is invalid");
  if (principalRef !== actorRef || deploymentGeneration !== verifiedDeploymentGeneration) {
    fail("MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID", 403, false, "verified MCP context does not match its actor");
  }
  if (deploymentGeneration !== config.deployment_generation || verifiedDeploymentGeneration !== config.deployment_generation) {
    fail("MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH", 409, false, "verified MCP deployment is stale");
  }
  if (authProfile !== config.auth_profile || authenticationMethod !== AUTH_PROFILE_METHOD[config.auth_profile] ||
      authenticationMethod !== AUTH_PROFILE_METHOD[authProfile]) {
    fail("MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH", 409, false, "verified MCP profile is stale");
  }
  if (Date.parse(expiresAt) <= nowMilliseconds) {
    fail("MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED", 409, false, "verified MCP authentication has expired");
  }
  return Object.freeze({
    principal_ref: principalRef,
    trace_id: traceId,
    deployment_generation: deploymentGeneration,
    actor_ref: actorRef,
    credential_generation: credentialGeneration,
    authentication_method: authenticationMethod,
    expires_at: expiresAt,
    auth_profile: authProfile,
  });
}

export function createD1McpClientDiagnosticService(
  database: D1Database,
  rawOptions: McpClientDiagnosticServiceOptions,
): McpClientDiagnosticService {
  const config = copyConfig(rawOptions);

  async function readById(challengeId: string, afterMutation = false): Promise<ChallengeRow | null> {
    try {
      const raw = await database.prepare(SELECT_BY_ID).bind(challengeId).first<RawChallengeRow>();
      return raw === null ? null : parseRawChallengeRow(raw);
    } catch (error) {
      if (error instanceof McpClientDiagnosticServiceError) throw error;
      fail(
        afterMutation ? "MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN" : "MCP_DIAGNOSTIC_D1_UNAVAILABLE",
        503,
        true,
        afterMutation ? "diagnostic mutation readback is uncertain" : "diagnostic row read is unavailable",
      );
    }
  }

  async function readLatest(owner: McpClientDiagnosticOwner): Promise<ChallengeRow | null> {
    try {
      const raw = await database.prepare(SELECT_LATEST).bind(
        owner.principal_ref,
        owner.credential_generation,
        config.deployment_generation,
      ).first<RawChallengeRow>();
      return raw === null ? null : parseRawChallengeRow(raw);
    } catch (error) {
      if (error instanceof McpClientDiagnosticServiceError) throw error;
      fail("MCP_DIAGNOSTIC_D1_UNAVAILABLE", 503, true, "diagnostic status read is unavailable");
    }
  }

  async function issue(ownerRaw: McpClientDiagnosticOwner): Promise<McpDiagnosticChallengeResult> {
    const owner = requiredOwner(ownerRaw);
    const challengeId = await randomIdentifier("mcp-diagnostic-challenge");
    const challengeToken = await randomToken();
    const tokenSha256 = await tokenDigest(challengeToken);
    const clock = currentTime(config.now);
    const expected: IssuedExpectation = Object.freeze({
      challenge_id: challengeId,
      token_sha256: tokenSha256,
      owner,
      deployment_generation: config.deployment_generation,
      auth_profile: config.auth_profile,
      issued_at: clock.timestamp,
      expires_at: timestampFor(clock.milliseconds + MCP_DIAGNOSTIC_TTL_MS),
    });
    let mutationError: unknown;
    try {
      await database.prepare(
        "INSERT INTO mcp_client_diagnostic_challenge(challenge_id,token_sha256,owner_principal_ref,owner_credential_generation,deployment_generation,auth_profile,issued_at,expires_at,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'ISSUED') ON CONFLICT(challenge_id) DO NOTHING",
      ).bind(
        expected.challenge_id,
        expected.token_sha256,
        expected.owner.principal_ref,
        expected.owner.credential_generation,
        expected.deployment_generation,
        expected.auth_profile,
        expected.issued_at,
        expected.expires_at,
      ).run();
    } catch (error) {
      mutationError = error;
    }
    const stored = await readById(expected.challenge_id, mutationError !== undefined);
    if (stored === null) fail("MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN", 503, true, "diagnostic challenge issuance lacks exact durable readback");
    if (!exactIssued(stored, expected)) {
      fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic challenge readback does not match its issuance");
    }
    const returnClock = currentTime(config.now);
    if (returnClock.milliseconds >= Date.parse(stored.expires_at)) {
      fail("MCP_DIAGNOSTIC_CHALLENGE_EXPIRED", 409, false, "diagnostic challenge expired before it could be returned");
    }
    return publicChallenge(expected, challengeToken);
  }

  async function latest(ownerRaw: McpClientDiagnosticOwner): Promise<McpDiagnosticLatestStatus | null> {
    const owner = requiredOwner(ownerRaw);
    const stored = await readLatest(owner);
    if (stored === null) return null;
    if (stored.owner_principal_ref !== owner.principal_ref ||
        stored.owner_credential_generation !== owner.credential_generation ||
        stored.deployment_generation !== config.deployment_generation) {
      fail("MCP_DIAGNOSTIC_D1_CORRUPT", 503, true, "diagnostic status readback does not match its owner");
    }
    const clock = currentTime(config.now);
    return publicLatest(stored, clock.milliseconds);
  }

  async function consume(inputRaw: unknown, contextRaw: McpClientDiagnosticContext): Promise<McpDiagnosticConsumeResult> {
    const parsedInput = McpDiagnosticConsumeInputSchema.safeParse(inputRaw);
    if (!parsedInput.success) fail("MCP_DIAGNOSTIC_INPUT_INVALID", 400, false, "diagnostic consume input is invalid");
    const initialClock = currentTime(config.now);
    const context = snapshotContext(contextRaw, config, initialClock.milliseconds);
    const input = parsedInput.data;
    const stored = await readById(input.challenge_id);
    if (stored === null) fail("MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND", 404, false, "diagnostic challenge was not found");
    if (stored.state === "CONFIRMED") fail("MCP_DIAGNOSTIC_CHALLENGE_REPLAY", 409, false, "diagnostic challenge was already consumed");
    if (stored.deployment_generation !== config.deployment_generation || stored.auth_profile !== config.auth_profile) {
      fail("MCP_DIAGNOSTIC_CHALLENGE_STALE", 409, false, "diagnostic challenge belongs to another deployment");
    }
    if (initialClock.milliseconds >= Date.parse(stored.expires_at)) {
      fail("MCP_DIAGNOSTIC_CHALLENGE_EXPIRED", 409, false, "diagnostic challenge has expired");
    }
    const suppliedHash = await tokenDigest(input.challenge_token);
    if (suppliedHash !== stored.token_sha256) fail("MCP_DIAGNOSTIC_TOKEN_INVALID", 409, false, "diagnostic challenge token is invalid");
    const observationRef = await randomIdentifier("mcp-diagnostic-observation");
    const freshClock = currentTime(config.now);
    if (freshClock.milliseconds < Date.parse(stored.issued_at)) {
      fail("MCP_DIAGNOSTIC_CLOCK_INVALID", 503, true, "diagnostic clock regressed during confirmation");
    }
    if (freshClock.milliseconds >= Date.parse(stored.expires_at)) {
      fail("MCP_DIAGNOSTIC_CHALLENGE_EXPIRED", 409, false, "diagnostic challenge has expired");
    }
    if (Date.parse(context.expires_at) <= freshClock.milliseconds) {
      fail("MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED", 409, false, "verified MCP authentication has expired");
    }
    const expected: ConfirmedExpectation = Object.freeze({
      challenge_id: stored.challenge_id,
      token_sha256: stored.token_sha256,
      owner_principal_ref: stored.owner_principal_ref,
      owner_credential_generation: stored.owner_credential_generation,
      deployment_generation: stored.deployment_generation,
      auth_profile: stored.auth_profile,
      issued_at: stored.issued_at,
      expires_at: stored.expires_at,
      observation_ref: observationRef,
      observed_at: freshClock.timestamp,
      trace_id: context.trace_id,
      verified_actor_ref: context.actor_ref,
      verified_credential_generation: context.credential_generation,
      verified_authentication_method: context.authentication_method,
      verified_expires_at: context.expires_at,
    });
    let mutationError: unknown;
    let mutationApplied = false;
    try {
      const result = await database.prepare(
        "UPDATE mcp_client_diagnostic_challenge SET state='CONFIRMED',observation_ref=?1,observed_at=?2,trace_id=?3,verified_actor_ref=?4,verified_credential_generation=?5,verified_authentication_method=?6,verified_expires_at=?7 WHERE challenge_id=?8 AND state='ISSUED' AND token_sha256=?9 AND auth_profile=?10 AND deployment_generation=?11 AND julianday(expires_at)>julianday(?12)",
      ).bind(
        expected.observation_ref,
        expected.observed_at,
        expected.trace_id,
        expected.verified_actor_ref,
        expected.verified_credential_generation,
        expected.verified_authentication_method,
        expected.verified_expires_at,
        expected.challenge_id,
        expected.token_sha256,
        expected.auth_profile,
        expected.deployment_generation,
        expected.observed_at,
      ).run();
      const changes = mutationChanges(result);
      mutationApplied = changes === undefined || changes === 1;
    } catch (error) {
      mutationError = error;
    }

    const readback = await readById(expected.challenge_id, mutationError !== undefined);
    if (readback === null) fail("MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN", 503, true, "diagnostic confirmation readback is uncertain");
    if (mutationError !== undefined) {
      if (!exactConfirmed(readback, expected)) fail("MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN", 503, true, "diagnostic confirmation settlement is uncertain");
      return publicConsume(readback);
    }
    if (exactConfirmed(readback, expected)) return publicConsume(readback);
    if (readback.state === "CONFIRMED") fail("MCP_DIAGNOSTIC_CHALLENGE_REPLAY", 409, false, "diagnostic challenge was already consumed");
    if (freshClock.milliseconds >= Date.parse(readback.expires_at)) fail("MCP_DIAGNOSTIC_CHALLENGE_EXPIRED", 409, false, "diagnostic challenge has expired");
    if (readback.token_sha256 !== suppliedHash) fail("MCP_DIAGNOSTIC_TOKEN_INVALID", 409, false, "diagnostic challenge token is invalid");
    if (!mutationApplied) fail("MCP_DIAGNOSTIC_CHALLENGE_STALE", 409, false, "diagnostic challenge could not be consumed");
    fail("MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN", 503, true, "diagnostic confirmation readback does not match its mutation");
  }

  return Object.freeze({ issue, latest, consume });
}
