import type { QueryProduct, RetrievalLane } from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";

export interface QueryPlan {
  readonly raw_query: string;
  readonly preserved_literals: readonly string[];
  readonly product: QueryProduct;
  readonly lanes: readonly RetrievalLane[];
  readonly context_expansion: 0 | 1 | 2 | 3;
  readonly rerank: boolean;
  readonly exact_resolution_required: true;
  readonly complete_scope_required: boolean;
  readonly max_candidates_before_policy_recheck: number;
  readonly skip_reasons: Readonly<Record<string, string>>;
}

type QueryPlanDefaults = Omit<QueryPlan, "raw_query" | "preserved_literals" | "product" | "skip_reasons">;

const PLAN_DEFAULTS: Readonly<Record<QueryProduct, QueryPlanDefaults>> = {
  FAST_SEARCH: { lanes: ["IDENT", "EXACT", "LEX"], context_expansion: 0, rerank: false, exact_resolution_required: true, complete_scope_required: false, max_candidates_before_policy_recheck: 50 },
  LOCATE: { lanes: ["IDENT", "EXACT", "LEX", "SEM", "LITERAL", "STRUCTURE"], context_expansion: 1, rerank: true, exact_resolution_required: true, complete_scope_required: false, max_candidates_before_policy_recheck: 100 },
  ORIENT: { lanes: ["ATLAS", "SOURCECARD", "WIKI", "LEX", "SEM"], context_expansion: 1, rerank: true, exact_resolution_required: true, complete_scope_required: false, max_candidates_before_policy_recheck: 100 },
  RESEARCH: { lanes: ["IDENT", "EXACT", "LEX", "SEM", "LITERAL", "SOURCECARD", "ATLAS", "ATOM", "ARGUMENT", "STRUCTURE", "WEB", "VERIFY"], context_expansion: 2, rerank: true, exact_resolution_required: true, complete_scope_required: false, max_candidates_before_policy_recheck: 200 },
  EXHAUSTIVE_JOB: { lanes: ["EXHAUSTIVE", "VERIFY"], context_expansion: 0, rerank: false, exact_resolution_required: true, complete_scope_required: true, max_candidates_before_policy_recheck: 500 },
  VERIFY_EXACT: { lanes: ["VERIFY"], context_expansion: 0, rerank: false, exact_resolution_required: true, complete_scope_required: false, max_candidates_before_policy_recheck: 1 },
  MATERIALIZE: { lanes: ["ARTIFACT", "WIKI", "VERIFY"], context_expansion: 0, rerank: false, exact_resolution_required: true, complete_scope_required: false, max_candidates_before_policy_recheck: 100 },
};

export function compileQueryPlan(request: RetrievalRequest): QueryPlan {
  const defaults = PLAN_DEFAULTS[request.product as keyof typeof PLAN_DEFAULTS] as QueryPlanDefaults | undefined;
  if (defaults === undefined) throw new Error(`unsupported query product: ${String(request.product)}`);
  return {
    raw_query: request.raw_query,
    preserved_literals: request.literals,
    product: request.product,
    ...defaults,
    skip_reasons: {},
  };
}

export function rerankingMayAffectCoverage(_plan: QueryPlan): false {
  return false;
}
