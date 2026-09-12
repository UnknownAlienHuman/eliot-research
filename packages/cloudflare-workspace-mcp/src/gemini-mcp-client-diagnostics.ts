import {
  McpDiagnosticConsumeInputSchema,
  McpDiagnosticConsumeResultSchema,
  type McpDiagnosticAuthProfile,
  type McpDiagnosticConsumeInput,
  type McpDiagnosticConsumeResult,
} from "@eliotr/contracts";
import type {
  McpToolCallContext,
  McpVerifiedActorContext,
} from "./gemini-mcp-protocol.js";
import {
  GeminiMcpToolError,
  type McpClientDiagnosticConsume,
} from "./gemini-mcp-tool-common.js";

export const MCP_CLIENT_DIAGNOSTIC_TOOL_NAME = "eliotr_confirm_client_diagnostic" as const;

export interface McpClientDiagnosticToolDependencies {
  readonly mcpClientDiagnosticConsume?: McpClientDiagnosticConsume;
  readonly mcp_auth_profile?: unknown;
  readonly deployment_generation?: unknown;
  readonly now?: () => number;
}

interface TrustedContextSnapshot {
  readonly principal_ref: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
  readonly verified_actor: Readonly<McpVerifiedActorContext>;
  readonly expires_at_ms: number;
  readonly now_ms: number;
}

function unavailable(cause?: unknown): never {
  throw new GeminiMcpToolError(
    "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
    "Client diagnostic confirmation is unavailable",
    true,
    cause,
  );
}

function invalidInput(): never {
  throw new GeminiMcpToolError(
    "INPUT_INVALID",
    "Client diagnostic consume input is invalid",
  );
}

function boundedText(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (!boundedText(value, 64)) return false;
  const milliseconds = Date.parse(value);
  try {
    return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value;
  } catch {
    return false;
  }
}

function profile(value: unknown): McpDiagnosticAuthProfile {
  if (value === "service-token" || value === "managed-oauth") return value;
  return unavailable();
}

function deployment(value: unknown): string {
  if (!boundedText(value)) return unavailable();
  return value;
}

function nowMilliseconds(now: (() => number) | undefined): number {
  if (typeof now !== "function") return unavailable();
  let value: number;
  try {
    value = now();
  } catch (cause) {
    return unavailable(cause);
  }
  if (!Number.isSafeInteger(value)) return unavailable();
  return value;
}

function contextSnapshot(
  context: McpToolCallContext,
  selectedProfile: McpDiagnosticAuthProfile,
  selectedDeployment: string,
  now: number,
): TrustedContextSnapshot {
  const actor = context.verified_actor;
  const expectedAuthenticationMethod = selectedProfile === "service-token"
    ? "service_token"
    : "cloudflare_access";
  if (
    !boundedText(context.principal_ref) ||
    !boundedText(context.trace_id) ||
    !boundedText(context.deployment_generation) ||
    context.deployment_generation !== selectedDeployment ||
    actor === undefined ||
    !boundedText(actor.actor_ref) ||
    !boundedText(actor.credential_generation) ||
    !canonicalTimestamp(actor.expires_at) ||
    actor.actor_ref !== context.principal_ref ||
    actor.auth_profile !== selectedProfile ||
    actor.authentication_method !== expectedAuthenticationMethod ||
    actor.deployment_generation !== selectedDeployment
  ) {
    return unavailable();
  }
  const expiresAtMs = Date.parse(actor.expires_at);
  if (!Number.isSafeInteger(expiresAtMs) || now >= expiresAtMs) return unavailable();
  return Object.freeze({
    principal_ref: context.principal_ref,
    trace_id: context.trace_id,
    deployment_generation: context.deployment_generation,
    verified_actor: Object.freeze({ ...actor }),
    expires_at_ms: expiresAtMs,
    now_ms: now,
  });
}

function sameContext(
  before: TrustedContextSnapshot,
  after: TrustedContextSnapshot,
): boolean {
  return before.principal_ref === after.principal_ref &&
    before.trace_id === after.trace_id &&
    before.deployment_generation === after.deployment_generation &&
    before.expires_at_ms === after.expires_at_ms &&
    before.now_ms <= after.now_ms &&
    before.verified_actor.actor_ref === after.verified_actor.actor_ref &&
    before.verified_actor.credential_generation === after.verified_actor.credential_generation &&
    before.verified_actor.authentication_method === after.verified_actor.authentication_method &&
    before.verified_actor.auth_profile === after.verified_actor.auth_profile &&
    before.verified_actor.deployment_generation === after.verified_actor.deployment_generation &&
    before.verified_actor.expires_at === after.verified_actor.expires_at;
}

/**
 * Validate the trusted MCP context around one server-owned diagnostic consume.
 * The callback is the only component allowed to consume the opaque challenge;
 * this package exposes only the public observation DTO to the MCP client.
 */
export async function confirmClientDiagnostic(
  dependencies: McpClientDiagnosticToolDependencies,
  input: unknown,
  context: McpToolCallContext,
): Promise<McpDiagnosticConsumeResult> {
  const parsedInput = McpDiagnosticConsumeInputSchema.safeParse(input);
  if (!parsedInput.success) return invalidInput();
  const consumeInput: McpDiagnosticConsumeInput = Object.freeze({ ...parsedInput.data });
  const consume = dependencies.mcpClientDiagnosticConsume;
  const now = dependencies.now;
  if (typeof consume !== "function" || typeof now !== "function") return unavailable();

  const selectedProfile = profile(dependencies.mcp_auth_profile);
  const selectedDeployment = deployment(dependencies.deployment_generation);
  const before = contextSnapshot(
    context,
    selectedProfile,
    selectedDeployment,
    nowMilliseconds(now),
  );
  const callbackContext: McpToolCallContext = Object.freeze({
    principal_ref: before.principal_ref,
    trace_id: before.trace_id,
    deployment_generation: before.deployment_generation,
    verified_actor: before.verified_actor,
  });

  let rawResult: unknown;
  try {
    rawResult = await consume(consumeInput, callbackContext);
  } catch (cause) {
    if (cause instanceof GeminiMcpToolError) throw cause;
    return unavailable(cause);
  }

  const after = contextSnapshot(
    context,
    selectedProfile,
    selectedDeployment,
    nowMilliseconds(now),
  );
  if (!sameContext(before, after)) return unavailable();

  const parsedResult = McpDiagnosticConsumeResultSchema.safeParse(rawResult);
  if (!parsedResult.success) return unavailable();
  const result = parsedResult.data;
  if (
    result.challenge_id !== consumeInput.challenge_id ||
    result.auth_profile !== selectedProfile ||
    result.deployment_generation !== selectedDeployment ||
    result.trace_id !== before.trace_id
  ) {
    return unavailable();
  }
  const observedAtMs = Date.parse(result.observed_at);
  if (!Number.isSafeInteger(observedAtMs) ||
      observedAtMs < before.now_ms ||
      observedAtMs > after.now_ms ||
      observedAtMs >= before.expires_at_ms) {
    return unavailable();
  }
  return Object.freeze({ ...result });
}
