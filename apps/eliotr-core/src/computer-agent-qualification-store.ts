import {
  confirmWebInboxComputerAgentQualification as confirm,
  createComputerAgentQualificationService as createService,
  type ComputerAgentDiagnosticServiceFactory,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";
import {
  createD1McpClientDiagnosticService,
  McpClientDiagnosticServiceError,
} from "@eliotr/cloudflare-workspace-mcp";
import type { D1Database } from "@cloudflare/workers-types";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

export {
  ComputerAgentQualificationError,
  preflightComputerAgentQualificationChallenge,
  requireComputerAgentQualificationChallengeReady,
  requireCurrentComputerAgentQualification,
  readComputerAgentQualificationStatusForConnection,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";
export type {
  ComputerAgentQualificationErrorCode,
  ComputerAgentDiagnosticPort,
  ComputerAgentDiagnosticServiceFactory,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";

const createDiagnosticService: ComputerAgentDiagnosticServiceFactory = (input) =>
  createD1McpClientDiagnosticService(input.database, {
    now: input.now,
    auth_profile: input.auth_profile,
    deployment_generation: input.deployment_generation,
  });
const isDiagnosticError = (error: unknown): error is McpClientDiagnosticServiceError =>
  error instanceof McpClientDiagnosticServiceError;

export function createComputerAgentQualificationService(options: {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly mcp_auth_profile?: string;
  readonly now?: () => number;
}) {
  return createService({
    ...options,
    create_diagnostic_service: createDiagnosticService,
    is_diagnostic_error: isDiagnosticError,
  });
}

export function confirmWebInboxComputerAgentQualification(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly body: unknown;
  readonly deployment_generation: string;
  readonly now?: () => number;
}) {
  return confirm({
    ...input,
    create_diagnostic_service: createDiagnosticService,
    is_diagnostic_error: isDiagnosticError,
  });
}
