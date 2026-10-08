import { ApiRequestError } from "./api.js";

export type HealthFailureKind = "network" | "access" | "server";
export interface HealthFailure { readonly kind: HealthFailureKind; readonly code: string; readonly status: number; }

export function classifyHealthFailure(error: unknown): HealthFailure {
  if (!(error instanceof ApiRequestError)) return { kind: "network", code: "API_UNREACHABLE", status: 0 };
  const code = /^[A-Z0-9_:-]{1,128}$/u.test(error.code) ? error.code : "API_REQUEST_FAILED";
  const status = Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : 0;
  const kind: HealthFailureKind = code === "API_UNREACHABLE" || code === "API_REQUEST_ABORTED"
    ? "network"
    : code.startsWith("ACCESS_") || status === 401 || status === 403 ? "access" : "server";
  return { kind, code, status };
}
