import type { Env } from "./env.js";

export const REQUIRED_CORE_SCHEMA_GENERATION = "core-v7-evidence-resolution" as const;
export const REQUIRED_SEARCH_SCHEMA_GENERATION = "search-v2-projection-generations" as const;

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
    const row = await database.prepare(
      "SELECT value FROM schema_state WHERE key = 'schema_generation'",
    ).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function readReadiness(env: Env): Promise<ReadinessReport> {
  const [core, search] = await Promise.all([
    schemaGeneration(env.CORE_DB),
    schemaGeneration(env.SEARCH_DB),
  ]);
  const blocking: string[] = [];
  if (core === null) blocking.push("CORE_SCHEMA_NOT_APPLIED");
  else if (core !== REQUIRED_CORE_SCHEMA_GENERATION) {
    blocking.push("CORE_SCHEMA_GENERATION_MISMATCH");
  }
  if (search === null) blocking.push("SEARCH_SCHEMA_NOT_APPLIED");
  else if (search !== REQUIRED_SEARCH_SCHEMA_GENERATION) {
    blocking.push("SEARCH_SCHEMA_GENERATION_MISMATCH");
  }
  return {
    ready: blocking.length === 0,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    core_schema_generation: core,
    search_schema_generation: search,
    blocking_reason_codes: blocking,
    checked_at: new Date().toISOString(),
  };
}
