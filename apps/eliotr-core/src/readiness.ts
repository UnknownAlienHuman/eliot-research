import type { Env } from "./env.js";

export interface ReadinessReport {
  readonly ready: boolean;
  readonly deployment_generation: string;
  readonly core_schema_generation: string | null;
  readonly search_schema_generation: string | null;
  readonly blocking_reason_codes: readonly string[];
  readonly checked_at: string;
}

async function schemaGeneration(database: D1Database): Promise<string | null> {
  try {
    const row = await database.prepare("SELECT value FROM schema_state WHERE key = 'schema_generation'").first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function readReadiness(env: Env): Promise<ReadinessReport> {
  const [core, search] = await Promise.all([schemaGeneration(env.CORE_DB), schemaGeneration(env.SEARCH_DB)]);
  const blocking: string[] = [];
  if (core === null) blocking.push("CORE_SCHEMA_NOT_APPLIED");
  if (search === null) blocking.push("SEARCH_SCHEMA_NOT_APPLIED");
  return {
    ready: blocking.length === 0,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    core_schema_generation: core,
    search_schema_generation: search,
    blocking_reason_codes: blocking,
    checked_at: new Date().toISOString(),
  };
}
