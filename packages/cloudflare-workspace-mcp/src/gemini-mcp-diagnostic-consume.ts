import type { D1Database } from "@cloudflare/workers-types";
import type {
  McpDiagnosticAuthProfile,
  McpDiagnosticConsumeInput,
  McpDiagnosticConsumeResult,
} from "@eliotr/contracts";
import {
  createD1McpClientDiagnosticService,
  McpClientDiagnosticServiceError,
} from "./mcp-client-diagnostics.js";
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import {
  GeminiMcpToolError,
  type McpClientDiagnosticConsume,
} from "./gemini-mcp-tool-common.js";

const MCP_DIAGNOSTIC_ERROR_MAP: Readonly<Record<string, {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}>> = Object.freeze({
  MCP_DIAGNOSTIC_CLOCK_INVALID: {
    code: "MCP_DIAGNOSTIC_CLOCK_INVALID",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_CONFIG_INVALID: {
    code: "MCP_DIAGNOSTIC_CONFIG_INVALID",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE: {
    code: "MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_D1_CORRUPT: {
    code: "MCP_DIAGNOSTIC_D1_CORRUPT",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_D1_UNAVAILABLE: {
    code: "MCP_DIAGNOSTIC_D1_UNAVAILABLE",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED: {
    code: "MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED",
    message: "Client diagnostic authentication has expired",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID: {
    code: "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID",
    message: "Authenticated client diagnostic context is invalid",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED: {
    code: "MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED",
    message: "Authenticated client diagnostic context is required",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH: {
    code: "MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH",
    message: "Client diagnostic authentication is not current",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH: {
    code: "MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH",
    message: "Client diagnostic authentication is not current",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_EXPIRED: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_EXPIRED",
    message: "Client diagnostic challenge has expired",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_NOT_FOUND",
    message: "Client diagnostic challenge was not found",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_REPLAY: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_REPLAY",
    message: "Client diagnostic challenge was already consumed",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_STALE: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_STALE",
    message: "Client diagnostic challenge is no longer current",
    retryable: false,
  },
  MCP_DIAGNOSTIC_OWNER_INVALID: {
    code: "MCP_DIAGNOSTIC_OWNER_INVALID",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_INPUT_INVALID: {
    code: "INPUT_INVALID",
    message: "Client diagnostic input is invalid",
    retryable: false,
  },
  MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN: {
    code: "MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_TOKEN_INVALID: {
    code: "MCP_CLIENT_DIAGNOSTIC_TOKEN_INVALID",
    message: "Client diagnostic challenge token is invalid",
    retryable: false,
  },
});

export interface WorkspaceMcpDiagnosticConsumeDependencies {
  readonly database: D1Database;
  readonly auth_profile: McpDiagnosticAuthProfile;
  readonly deployment_generation: string;
  readonly preflight_computer_agent_qualification: (
    input: McpDiagnosticConsumeInput,
    context: McpToolCallContext,
  ) => Promise<boolean>;
  readonly require_computer_agent_qualification_current: (
    input: McpDiagnosticConsumeInput,
    context: McpToolCallContext,
  ) => Promise<void>;
  readonly translate_computer_agent_qualification_error: (
    error: unknown,
  ) => GeminiMcpToolError | undefined;
}

function diagnosticServiceError(error: McpClientDiagnosticServiceError): GeminiMcpToolError {
  const mapped = MCP_DIAGNOSTIC_ERROR_MAP[error.code];
  return mapped === undefined
    ? new GeminiMcpToolError(
        "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
        "Client diagnostic confirmation is temporarily unavailable",
        true,
      )
    : new GeminiMcpToolError(mapped.code, mapped.message, mapped.retryable);
}

function diagnosticUnavailableError(): GeminiMcpToolError {
  return new GeminiMcpToolError(
    "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
    "Client diagnostic confirmation is temporarily unavailable",
    true,
  );
}

function copyDiagnosticContext(context: McpToolCallContext): McpToolCallContext {
  const verifiedActor = context.verified_actor;
  return Object.freeze({
    principal_ref: context.principal_ref,
    trace_id: context.trace_id,
    deployment_generation: context.deployment_generation,
    ...(verifiedActor === undefined
      ? {}
      : { verified_actor: Object.freeze({ ...verifiedActor }) }),
  });
}

/** Owns one canonical diagnostic consume while Core supplies its ComputerAgent authority hooks. */
export function createWorkspaceMcpDiagnosticConsume(
  dependencies: WorkspaceMcpDiagnosticConsumeDependencies,
): McpClientDiagnosticConsume {
  return async (input, context) => {
    const consumeInput = Object.freeze({
      challenge_id: input.challenge_id,
      challenge_token: input.challenge_token,
    });
    const consumeContext = copyDiagnosticContext(context);
    try {
      const bound = await dependencies.preflight_computer_agent_qualification(consumeInput, context);
      const service = createD1McpClientDiagnosticService(dependencies.database, {
        now: Date.now,
        auth_profile: dependencies.auth_profile,
        deployment_generation: dependencies.deployment_generation,
      });
      const result: McpDiagnosticConsumeResult = await service.consume(consumeInput, consumeContext);
      if (bound && context.verified_actor !== undefined) {
        await dependencies.require_computer_agent_qualification_current(consumeInput, context);
      }
      return result;
    } catch (error) {
      const qualificationError = dependencies.translate_computer_agent_qualification_error(error);
      if (qualificationError !== undefined) throw qualificationError;
      if (error instanceof McpClientDiagnosticServiceError) throw diagnosticServiceError(error);
      throw diagnosticUnavailableError();
    }
  };
}
