import { describe, expect, it } from "vitest";
import {
  MCP_DIAGNOSTIC_PROTOCOL,
  McpDiagnosticChallengeResultSchema,
  McpDiagnosticConsumeInputSchema,
  McpDiagnosticConsumeResultSchema,
  McpDiagnosticCreateInputSchema,
  McpDiagnosticLatestStatusSchema,
} from "./mcp-diagnostic.js";

const issuedAt = "2026-09-12T12:00:00.000Z";
const expiresAt = "2026-09-12T12:05:00.000Z";
const observedAt = "2026-09-12T12:01:00.000Z";

const challenge = {
  protocol: MCP_DIAGNOSTIC_PROTOCOL,
  status: "ISSUED",
  challenge_id: "challenge-1",
  challenge_token: "opaque-token/with punctuation",
  issued_at: issuedAt,
  expires_at: expiresAt,
  deployment_generation: "deployment-1",
  auth_profile: "managed-oauth",
} as const;

const confirmed = {
  protocol: MCP_DIAGNOSTIC_PROTOCOL,
  status: "CONFIRMED",
  challenge_id: "challenge-1",
  issued_at: issuedAt,
  expires_at: expiresAt,
  observation_ref: "observation-1",
  observed_at: observedAt,
  deployment_generation: "deployment-1",
  auth_profile: "managed-oauth",
  trace_id: "trace-1",
} as const;

const issuedStatus = {
  protocol: MCP_DIAGNOSTIC_PROTOCOL,
  status: "ISSUED",
  challenge_id: "challenge-1",
  issued_at: issuedAt,
  expires_at: expiresAt,
  deployment_generation: "deployment-1",
  auth_profile: "managed-oauth",
} as const;

const expiredStatus = {
  ...issuedStatus,
  status: "EXPIRED",
} as const;

describe("MCP client diagnostic contract", () => {
  it("accepts empty create, issued challenge, and confirmed consume DTOs", () => {
    expect(McpDiagnosticCreateInputSchema.safeParse({}).success).toBe(true);
    expect(McpDiagnosticChallengeResultSchema.safeParse(challenge).success).toBe(true);
    expect(McpDiagnosticConsumeInputSchema.safeParse({
      challenge_id: challenge.challenge_id,
      challenge_token: challenge.challenge_token,
    }).success).toBe(true);
    expect(McpDiagnosticLatestStatusSchema.safeParse(issuedStatus).success).toBe(true);
    expect(McpDiagnosticLatestStatusSchema.safeParse(confirmed).success).toBe(true);
    expect(McpDiagnosticLatestStatusSchema.safeParse(expiredStatus).success).toBe(true);
    expect(McpDiagnosticConsumeResultSchema.safeParse({
      protocol: MCP_DIAGNOSTIC_PROTOCOL,
      status: "CONFIRMED",
      challenge_id: confirmed.challenge_id,
      observation_ref: confirmed.observation_ref,
      observed_at: confirmed.observed_at,
      deployment_generation: confirmed.deployment_generation,
      auth_profile: confirmed.auth_profile,
      trace_id: confirmed.trace_id,
    }).success).toBe(true);
  });

  it("rejects caller authority fields and token leakage from status readback", () => {
    expect(McpDiagnosticCreateInputSchema.safeParse({ principal_ref: "owner-1" }).success).toBe(false);
    expect(McpDiagnosticConsumeInputSchema.safeParse({
      challenge_id: challenge.challenge_id,
      challenge_token: challenge.challenge_token,
      credential_generation: "credential-1",
    }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, actor_ref: "actor-1" }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, verified_actor: { actor_ref: "actor-1" } }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, credential_generation: "credential-1" }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...challenge, challenge_token: undefined }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, challenge_token: challenge.challenge_token }).success).toBe(false);
  });

  it("rejects unknown, cancelled, malformed, expired-before-issued, and inconsistent confirmed bindings", () => {
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, status: "UNKNOWN" }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, status: "CANCELLED" }).success).toBe(false);
    expect(McpDiagnosticChallengeResultSchema.safeParse({ ...challenge, issued_at: "not-a-timestamp" }).success).toBe(false);
    expect(McpDiagnosticChallengeResultSchema.safeParse({ ...challenge, issued_at: "2026-09-12T08:00:00.000-04:00" }).success).toBe(false);
    expect(McpDiagnosticChallengeResultSchema.safeParse({ ...challenge, issued_at: "2026-09-12T12:00:00Z" }).success).toBe(false);
    expect(McpDiagnosticChallengeResultSchema.safeParse({ ...challenge, expires_at: issuedAt }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...issuedStatus, expires_at: issuedAt }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...expiredStatus, expires_at: issuedAt }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, observed_at: "2026-09-12T11:59:00.000Z" }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, observed_at: expiresAt }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, observed_at: "2026-09-12T12:06:00.000Z" }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, auth_profile: "service" }).success).toBe(false);
    expect(McpDiagnosticLatestStatusSchema.safeParse({ ...confirmed, deployment_generation: "" }).success).toBe(false);
  });

  it("bounds opaque challenge tokens and does not apply defaults", () => {
    expect(McpDiagnosticConsumeInputSchema.safeParse({ challenge_id: "challenge-1" }).success).toBe(false);
    expect(McpDiagnosticConsumeInputSchema.safeParse({ challenge_id: "challenge-1", challenge_token: "" }).success).toBe(false);
    expect(McpDiagnosticConsumeInputSchema.safeParse({ challenge_id: "challenge-1", challenge_token: "t".repeat(1025) }).success).toBe(false);
  });
});
