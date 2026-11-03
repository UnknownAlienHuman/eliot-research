import type { MeResponse } from "../shared/api";

export async function apiErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch { /* use the status when the API body is not readable */ }
  return "Request failed with status " + res.status + ".";
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", ...init });
  if (res.ok) return (await res.json()) as T;
  throw new Error(await apiErrorMessage(res));
}

export interface MeRequestError extends Error {
  readonly status: number;
}

export async function fetchMe(signal?: AbortSignal): Promise<MeResponse> {
  const response = await fetch("/api/me", {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const failure = new Error("Request failed with status " + response.status + ".") as MeRequestError;
    (failure as { status?: number }).status = response.status;
    throw failure;
  }
  return response.json() as Promise<MeResponse>;
}
