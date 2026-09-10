import {
  createExhaustiveQueryService as createAuthorityQueryService,
  ExhaustiveQueryError as AuthorityQueryError,
  type ExhaustiveQueryEnvironment,
  type ExhaustiveQueryOptions,
  type ExhaustiveQueryRequest,
  type ExhaustiveQueryRuntime,
} from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext, ExhaustiveQueryResult } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";

export {
  EXHAUSTIVE_QUERY_BUDGET,
  EXHAUSTIVE_QUERY_MAX_RESULTS,
  EXHAUSTIVE_QUERY_MAX_SOURCES,
  EXHAUSTIVE_QUERY_PROTOCOL,
  exhaustiveIdempotencyKey,
  parseExhaustiveQueryRequest,
} from "@eliotr/cloudflare-navigation";
export type { ExhaustiveQueryEnvironment, ExhaustiveQueryOptions, ExhaustiveQueryRequest, ExhaustiveQueryRuntime };

export class ExhaustiveQueryError extends CatalogInputError {}

function translate(error: unknown): never {
  if (error instanceof AuthorityQueryError) {
    throw new ExhaustiveQueryError(error.code, error.message, error.status, error.retryable);
  }
  throw error;
}

export function createExhaustiveQueryService(
  env: Pick<Env, "CORE_DB"> & Partial<Pick<Env, "SEARCH_DB" | "EVIDENCE_BUCKET">>,
  options: ExhaustiveQueryOptions = {},
): { query(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveQueryResult> } {
  const service = createAuthorityQueryService(env as ExhaustiveQueryEnvironment, options);
  return { query: (context, raw) => service.query(context, raw).catch(translate) };
}
