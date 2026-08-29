export interface SystemHealth {
  readonly ready: boolean;
  readonly deployment_generation: string;
  readonly core_schema_generation: string | null;
  readonly search_schema_generation: string | null;
  readonly blocking_reason_codes: readonly string[];
  readonly checked_at: string;
}

export async function getSystemHealth(signal?: AbortSignal): Promise<SystemHealth> {
  const init: RequestInit = { headers: { accept: "application/json" } };
  if (signal !== undefined) init.signal = signal;
  const response = await fetch("/api/v1/system/health", init);
  const body = await response.json() as SystemHealth;
  return body;
}
