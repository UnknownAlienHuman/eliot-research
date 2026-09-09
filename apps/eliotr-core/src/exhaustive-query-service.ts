// IMPLEMENTED_NOT_LIVE: ER-24 composes the Q7 job loop behind research.query;
// the default Worker runtime remains fail-closed until an admitted section
// inventory and pinned section reader are supplied.
import {
  executeExhaustiveShard,
  exhaustiveRequestDigest,
  createD1ExhaustiveJobStore,
  planExhaustiveScan,
  reconcileExhaustiveJob,
  type ExhaustiveSectionDescriptor,
  type ExactScanPlan,
  type ExhaustiveSectionReader,
  type ExhaustiveJobStore,
  type RetrievalQueryAccess,
  type ExhaustiveReconcileStatus,
  type VerifyPinnedExactInput,
} from "@eliotr/retrieval";
import type { ScopeExpression, ScopeSnapshot } from "@eliotr/contracts";
import { ScopeExpressionSchema } from "@eliotr/contracts";
import { inspectScopeExpression } from "@eliotr/domain";
import type {
  AuthenticatedRequestContext,
  ExhaustiveQueryResult,
  QueryRequest,
} from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";

export const EXHAUSTIVE_QUERY_PROTOCOL = "eliotr.exhaustive-query.v1" as const;
export const EXHAUSTIVE_QUERY_BUDGET = "exhaustive-job-v1" as const;
export const EXHAUSTIVE_QUERY_MAX_SOURCES = 4096;
export const EXHAUSTIVE_QUERY_MAX_RESULTS = 16;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_SCOPE_DEPTH = 32;
const MAX_SCOPE_ATOMS = 256;

export class ExhaustiveQueryError extends CatalogInputError {}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new ExhaustiveQueryError(code, message, status, retryable);
}

function checkQuery(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 ||
      new TextEncoder().encode(value).byteLength > MAX_QUERY_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("RESEARCH_INPUT_INVALID", "query is invalid");
  }
  return value;
}

function checkScope(value: unknown): ScopeExpression {
  const parsed = ScopeExpressionSchema.safeParse(value);
  if (!parsed.success) fail("RESEARCH_INPUT_INVALID", "scope_expression is invalid");
  const metrics = inspectScopeExpression(parsed.data);
  if (metrics.depth > MAX_SCOPE_DEPTH || metrics.atom_count > MAX_SCOPE_ATOMS ||
      metrics.selected_source_count > EXHAUSTIVE_QUERY_MAX_SOURCES) {
    fail("RESEARCH_INPUT_LIMIT", "scope_expression exceeds its exhaustive bounds", 413);
  }
  return parsed.data;
}

function exactKeys(record: Record<string, unknown>): void {
  const expected = ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"];
  if (Object.keys(record).length !== expected.length || expected.some((key) => !Object.hasOwn(record, key))) {
    fail("RESEARCH_INPUT_INVALID", "request has unknown or missing fields");
  }
}

function parseLiterals(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length !== 0) {
    fail("RESEARCH_INPUT_INVALID", "literals must be empty for the exhaustive query profile");
  }
  return [];
}

function parseMaxResults(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > EXHAUSTIVE_QUERY_MAX_RESULTS) {
    fail("RESEARCH_INPUT_INVALID", "max_results is invalid");
  }
  return value as number;
}

export function parseExhaustiveQueryRequest(raw: unknown): QueryRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("RESEARCH_INPUT_INVALID", "query request must be an object");
  }
  const record = raw as Record<string, unknown>;
  exactKeys(record);
  if (record.product !== "EXHAUSTIVE_JOB" || record.evidence_grade !== "E0" ||
      record.budget_ref !== EXHAUSTIVE_QUERY_BUDGET) {
    fail("RESEARCH_PROFILE_UNSUPPORTED", "request does not match the exhaustive job profile", 422);
  }
  return {
    query: checkQuery(record.query),
    product: "EXHAUSTIVE_JOB",
    scope_expression: checkScope(record.scope_expression),
    literals: parseLiterals(record.literals),
    evidence_grade: "E0",
    budget_ref: EXHAUSTIVE_QUERY_BUDGET,
    max_results: parseMaxResults(record.max_results),
  };
}

function idempotencyKey(context: AuthenticatedRequestContext): string {
  const value = context.request.headers.get("idempotency-key");
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    fail("RESEARCH_INPUT_INVALID", "idempotency-key header is required");
  }
  return value;
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") fail("RESEARCH_OWNER_REQUIRED", "research query requires the owner profile", 403);
}

export interface ExhaustiveQueryRuntime {
  /** Resolve and persist the frozen scope from the authenticated request. */
  freezeScope(expression: ScopeExpression, credentialGeneration: string): Promise<ScopeSnapshot>;
  requireCurrentScope(scope: ScopeSnapshot): Promise<void>;
  /** Inventory is authoritative: it must come from the admitted normalized manifest. */
  inventorySections(scope: ScopeSnapshot): Promise<readonly ExhaustiveSectionDescriptor[]>;
  /** Return a pinned exact input; request supplied section identities are never trusted. */
  readSection(scope: ScopeSnapshot, sectionRef: string): Promise<VerifyPinnedExactInput>;
  checkBudget(signal: AbortSignal): void;
}

export interface ExhaustiveQueryOptions {
  readonly runtime?: (context: AuthenticatedRequestContext) => ExhaustiveQueryRuntime;
  readonly storeFactory?: (access: RetrievalQueryAccess) => ExhaustiveJobStore;
}

function unavailableRuntime(): ExhaustiveQueryRuntime {
  return {
    freezeScope: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    requireCurrentScope: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    inventorySections: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    readSection: async () => fail("RESEARCH_EXHAUSTIVE_NOT_READY", "admitted exhaustive section authority is not configured", 503, true),
    checkBudget: () => undefined,
  };
}

function mapRetrievalError(error: unknown): never {
  if (error instanceof ExhaustiveQueryError) throw error;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "RETRIEVAL_INPUT_INVALID" || code === "RETRIEVAL_SCOPE_STALE") {
    fail("RESEARCH_INPUT_INVALID", error instanceof Error ? error.message : "exhaustive request is invalid");
  }
  if (code === "RETRIEVAL_AUTHORITY_STALE") fail("RESEARCH_AUTHORITY_STALE", "exhaustive scope authority is stale", 409);
  if (code === "RETRIEVAL_IDEMPOTENCY_CONFLICT") fail("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409);
  if (code === "RETRIEVAL_RESOLUTION_UNCERTAIN") fail("RESEARCH_SETTLEMENT_UNCERTAIN", "exhaustive settlement is uncertain", 503, true);
  throw error;
}

function result(status: ExhaustiveReconcileStatus): ExhaustiveQueryResult {
  return { protocol: EXHAUSTIVE_QUERY_PROTOCOL, job: status };
}

export function createExhaustiveQueryService(
  env: Pick<Env, "CORE_DB">,
  options: ExhaustiveQueryOptions = {},
): { query(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveQueryResult> } {
  const runtimeFor = options.runtime ?? (() => unavailableRuntime());
  return {
    async query(context, raw) {
      requireOwner(context);
      const request = parseExhaustiveQueryRequest(raw);
      const key = idempotencyKey(context);
      const access = {
        principal_ref: context.principal_ref,
        client_class: context.client_class,
        credential_generation: context.credential_generation,
      } as const;
      const runtime = runtimeFor(context);
      const scope = await runtime.freezeScope(request.scope_expression, context.credential_generation);
      await runtime.requireCurrentScope(scope);
      runtime.checkBudget(context.request.signal);
      const sections = await runtime.inventorySections(scope);
      const plan: ExactScanPlan = planExhaustiveScan({ scope, probes: [request.query], sections });
      const requestDigest = await exhaustiveRequestDigest({
        plan_id: plan.plan_id,
        scope_digest: scope.digest,
        probes: plan.probes,
      });
      const store = options.storeFactory === undefined
        ? createD1ExhaustiveJobStore(env.CORE_DB, access)
        : options.storeFactory(access);
      const reader: ExhaustiveSectionReader = {
        readSection: (sectionRef) => runtime.readSection(scope, sectionRef),
      };
      const status = await reconcileExhaustiveJob({
        store,
        idempotency_key: key,
        request_digest: requestDigest,
        scope,
        plan,
        ports: {
          requireCurrentScope: (current) => runtime.requireCurrentScope(current),
          checkBudget: () => runtime.checkBudget(context.request.signal),
          executeShard: (shard, currentPlan) => executeExhaustiveShard({
            shard,
            scope: currentPlan.scope_snapshot,
            probes: currentPlan.probes,
            reader,
            signal: context.request.signal,
          }),
        },
      }).catch(mapRetrievalError);
      return result(status);
    },
  };
}
