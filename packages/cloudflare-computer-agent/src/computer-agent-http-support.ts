import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { ComputerAgentDiagnosticServiceFactory } from "./computer-agent-qualification-store.js";

export interface ComputerAgentHttpRuntime {
  readonly database: D1Database;
  readonly deployment_generation: string;
  readonly access_team_domain?: string | undefined;
  readonly mcp_access_team_domain?: string | undefined;
  readonly mcp_auth_profile?: string | undefined;
}

/** Core-owned HTTP primitives. The adapter binds its Env and preserves the existing route gate. */
export interface ComputerAgentHttpSupport {
  readonly api_result: (request: Request, result: unknown, status?: number) => Response;
  readonly http_error: (code: string, status: number, message: string, retryable?: boolean) => Error;
  readonly require_no_query: (url: URL) => void;
  readonly read_json_body: (request: Request, maximumBytes: number) => Promise<unknown>;
}

export interface ComputerAgentDispatchHttpSupport extends ComputerAgentHttpSupport {
  readonly start_run: (context: AuthenticatedRequestContext, request: QueryRequest) => Promise<{
    investigation_ref: { readonly id: string; readonly revision: number };
    workflow_instance_id: string;
  }>;
  readonly parse_run_request: (raw: unknown) => QueryRequest;
  readonly is_run_request_input_error: (error: unknown) => boolean;
}

export interface ComputerAgentQualificationHttpSupport extends ComputerAgentHttpSupport {
  readonly create_diagnostic_service: ComputerAgentDiagnosticServiceFactory;
  readonly is_diagnostic_error: (error: unknown) => error is {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
  };
}
