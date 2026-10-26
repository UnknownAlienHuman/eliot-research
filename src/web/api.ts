import type { MeResponse } from "../shared/api";

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
