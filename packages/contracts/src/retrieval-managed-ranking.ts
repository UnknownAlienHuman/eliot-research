import { z } from "zod";
import { IdentifierSchema, Sha256Schema } from "./common.js";
import { RetrievalTraceSchema } from "./retrieval.js";

export const MANAGED_RANKING_OUTCOME_PROTOCOL = "eliotr.managed-ranking-outcome.v1";
export const MANAGED_RETRIEVAL_TRACE_PROTOCOL = "eliotr.retrieval-trace.managed.v1";

const CLOUDFLARE_AI_SEARCH_MAX_CANDIDATES = 50;
const FiniteNumberSchema = z.number().refine((value) => Number.isFinite(value), "Expected a finite number");
const SafePositiveIntegerSchema = z.number().int().positive()
  .refine((value) => Number.isSafeInteger(value), "Expected a safe positive integer");
const SafeNonNegativeIntegerSchema = z.number().int().nonnegative()
  .refine((value) => Number.isSafeInteger(value), "Expected a safe nonnegative integer");

export const ManagedRankingSignalSchema = z.object({
  signal: z.enum(["KEYWORD", "VECTOR", "NATIVE_FUSION", "RERANK"]),
  basis: z.enum(["EXECUTED_QUERY", "RESPONSE_SCORING_DETAILS"]),
}).strict();
export type ManagedRankingSignal = z.infer<typeof ManagedRankingSignalSchema>;

const ManagedRankingLocatorMetadataSchema = z.object({
  provider_item_key: IdentifierSchema,
  provider_chunk_type: z.literal("text"),
  content_sha256: Sha256Schema,
  instruction_taint: z.enum(["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"]),
  provider_item_timestamp: SafeNonNegativeIntegerSchema.optional(),
}).strict();

export const ManagedRankingCandidateSchema = z.object({
  provider_rank: SafePositiveIntegerSchema,
  raw_score: FiniteNumberSchema,
  locator: z.object({
    candidate_id: IdentifierSchema,
    source_revision_ref: IdentifierSchema,
    canonical_section_id: IdentifierSchema,
    index_generation: IdentifierSchema,
    metadata: ManagedRankingLocatorMetadataSchema,
  }).strict(),
  scoring_details: z.object({
    fusion_method: z.enum(["rrf", "max"]).optional(),
    keyword_rank: SafePositiveIntegerSchema.optional(),
    keyword_score: FiniteNumberSchema.optional(),
    reranking_score: FiniteNumberSchema.optional(),
    vector_rank: SafePositiveIntegerSchema.optional(),
    vector_score: FiniteNumberSchema.optional(),
  }).strict().nullable(),
}).strict();
export type ManagedRankingCandidate = z.infer<typeof ManagedRankingCandidateSchema>;

const ProviderAuthoritySchema = z.object({
  namespace: IdentifierSchema,
  instance_id: IdentifierSchema,
  registry_revision: SafePositiveIntegerSchema,
  registry_artifact_sha256: Sha256Schema,
}).strict();

const AuthorityGenerationsSchema = z.object({
  policy_generation: IdentifierSchema.nullable(),
  execution_generation: IdentifierSchema.nullable(),
  index_generation: IdentifierSchema,
  query_compiler_generation: IdentifierSchema.nullable(),
}).strict();

const ProviderExecutionIdentitySchema = z.object({
  available: z.literal(false),
  provider_execution_id: z.null(),
  reason: z.literal("BINDING_RESPONSE_HAS_NO_EXECUTION_ID"),
}).strict();

export const ManagedRankingOutcomeSchema = z.object({
  protocol: z.literal(MANAGED_RANKING_OUTCOME_PROTOCOL),
  provider: z.literal("cloudflare_ai_search"),
  request_digest: Sha256Schema,
  scoped_invocation_id: IdentifierSchema,
  provider_execution_identity: ProviderExecutionIdentitySchema,
  output_digest: Sha256Schema,
  provider_authority: ProviderAuthoritySchema,
  authority_generations: AuthorityGenerationsSchema,
  executed_query: z.string().min(1),
  contributing_signals: z.array(ManagedRankingSignalSchema).min(1),
  list_semantics: z.literal("ONE_PHYSICAL_MANAGED_LIST"),
  scope_absence_proven: z.literal(false),
  rerank_requested: z.boolean(),
  rerank_attempted: z.boolean(),
  rerank_succeeded: z.boolean().nullable(),
  rerank_provider: z.literal("cloudflare_ai_search").nullable(),
  rerank_model: IdentifierSchema.nullable(),
  fallback_used: z.boolean(),
  failure_class: IdentifierSchema.nullable(),
  processing_state: z.enum(["COMPLETE", "DEGRADED", "NO_HIT", "FAILED"]),
  // The existing adapter and managed compiler both enforce the provider's 50-result ceiling.
  ordered_candidates: z.array(ManagedRankingCandidateSchema).max(CLOUDFLARE_AI_SEARCH_MAX_CANDIDATES),
}).strict().superRefine((outcome, context) => {
  const issue = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: "custom", path, message });
  };

  outcome.contributing_signals.forEach((signal, index) => {
    if (outcome.contributing_signals.some((other, otherIndex) =>
      otherIndex < index && other.signal === signal.signal && other.basis === signal.basis)) {
      issue(["contributing_signals", index], "A signal and basis pair may appear only once");
    }
  });

  outcome.ordered_candidates.forEach((candidate, index) => {
    if (candidate.provider_rank !== index + 1) {
      issue(["ordered_candidates", index, "provider_rank"], "Provider ranks must preserve the ordered list positions");
    }
    if (candidate.locator.index_generation !== outcome.authority_generations.index_generation) {
      issue(["ordered_candidates", index, "locator", "index_generation"], "Candidate index generation must match outcome authority");
    }
  });

  if (outcome.rerank_attempted && !outcome.rerank_requested) {
    issue(["rerank_attempted"], "A rerank can be attempted only when requested");
  }
  if (!outcome.rerank_attempted &&
      (outcome.rerank_succeeded !== false || outcome.rerank_provider !== null || outcome.rerank_model !== null)) {
    issue(["rerank_attempted"], "A non-attempted rerank must be false and carry no rerank provider or model");
  }
  if (outcome.rerank_succeeded === true &&
      (!outcome.rerank_attempted || outcome.rerank_provider === null)) {
    issue(["rerank_succeeded"], "Successful reranking must have been attempted by a named provider");
  }
  if (outcome.rerank_attempted && outcome.rerank_succeeded === false && outcome.failure_class === null) {
    issue(["failure_class"], "A known rerank failure requires a failure class");
  }
  if (outcome.fallback_used && outcome.failure_class === null) {
    issue(["failure_class"], "A used fallback requires its failure class");
  }

  switch (outcome.processing_state) {
    case "COMPLETE":
      if (outcome.ordered_candidates.length === 0 || outcome.fallback_used ||
          outcome.failure_class !== null || (outcome.rerank_attempted && outcome.rerank_succeeded === false)) {
        issue(["processing_state"], "COMPLETE requires candidates and no known fallback or failure");
      }
      break;
    case "NO_HIT":
      if (outcome.ordered_candidates.length !== 0 || outcome.fallback_used || outcome.failure_class !== null) {
        issue(["processing_state"], "NO_HIT requires an empty provider list without fallback or failure");
      }
      break;
    case "DEGRADED":
      if (outcome.failure_class === null ||
          (!outcome.fallback_used && !(outcome.rerank_attempted && outcome.rerank_succeeded === false))) {
        issue(["processing_state"], "DEGRADED requires an explicit fallback or rerank failure class");
      }
      break;
    case "FAILED":
      if (outcome.ordered_candidates.length !== 0 || outcome.fallback_used || outcome.failure_class === null) {
        issue(["processing_state"], "FAILED requires an empty list, a failure class, and no returned fallback list");
      }
      break;
  }
});
export type ManagedRankingOutcome = z.infer<typeof ManagedRankingOutcomeSchema>;

/**
 * Additive managed trace variant. Historical RetrievalTraceSchema stays strict and unchanged;
 * every managed trace carries at least one explicit provider outcome.
 */
export const ManagedRetrievalTraceSchema = RetrievalTraceSchema.extend({
  protocol: z.literal(MANAGED_RETRIEVAL_TRACE_PROTOCOL),
  managed_ranking_outcomes: z.array(ManagedRankingOutcomeSchema).min(1),
}).strict().superRefine((trace, context) => {
  trace.managed_ranking_outcomes.forEach((outcome, outcomeIndex) => {
    if (!trace.index_generations.includes(outcome.authority_generations.index_generation)) {
      context.addIssue({
        code: "custom",
        path: ["managed_ranking_outcomes", outcomeIndex, "authority_generations", "index_generation"],
        message: "Managed outcome index generation must be listed by the trace",
      });
    }
    outcome.ordered_candidates.forEach((candidate, candidateIndex) => {
      if (!trace.scope_snapshot.member_source_revision_refs.includes(candidate.locator.source_revision_ref)) {
        context.addIssue({
          code: "custom",
          path: ["managed_ranking_outcomes", outcomeIndex, "ordered_candidates", candidateIndex, "locator", "source_revision_ref"],
          message: "Managed candidate source revision must belong to the frozen trace scope",
        });
      }
    });
  });
});
export type ManagedRetrievalTrace = z.infer<typeof ManagedRetrievalTraceSchema>;
