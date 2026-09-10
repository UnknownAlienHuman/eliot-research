import type { CompletionDisposition } from "@eliotr/contracts";

export interface ApiProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly trace_id: string;
  readonly retryable: boolean;
  readonly completion_disposition?: CompletionDisposition;
  readonly next_probe?: string;
}

export interface AuthenticatedRequestContext {
  readonly request: Request;
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
  readonly trace_id: string;
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export function jsonResponse<T>(body: T, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}
