import {
  BranchQueryPlanSchema,
  BranchQueryResultSchema,
  IdentifierSchema,
  Sha256Schema,
  VersionedRefSchema,
  branchQueryResultMatchesPlan,
  type BranchQueryPlan,
  type BranchQueryResult,
  type VersionedRef,
} from "@eliotr/contracts";
import { fail } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

const RELATION_KIND_SCHEMA = z.enum(["CONTRADICTS", "QUALIFIES", "ALTERNATIVE_EXPLANATION"]);

const RELATION_CATALOGUE_TARGET_SCHEMA = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("QUESTION"),
    question_ref: VersionedRefSchema,
    question_sha256: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal("HYPOTHESIS"),
    planning_manifest_ref: VersionedRefSchema,
    planning_manifest_digest: Sha256Schema,
    hypothesis_id: IdentifierSchema,
  }).strict(),
]);

export type ResearchRelationCatalogueTarget = z.infer<typeof RELATION_CATALOGUE_TARGET_SCHEMA>;

export interface ResearchRelationAliasCatalogueModelInput {
  readonly protocol: "eliotr.research.relation-alias-catalogue.v1";
  readonly facts: readonly {
    readonly alias: string;
    /** Byte-identical exact excerpt from the corresponding resolved server evidence. */
    readonly fact_text: string;
  }[];
}

export interface ResearchRelationAliasBoundFact {
  readonly alias: string;
  /** Original exact resolver result, including its handle revision, span, and receipts. */
  readonly resolved_evidence: BranchQueryResult["resolved_evidence"][number];
}

export interface ResearchRelationAliasPairSelection {
  readonly relation_kind: z.infer<typeof RELATION_KIND_SCHEMA>;
  readonly target: ResearchRelationCatalogueTarget;
  readonly query_binding: {
    readonly query_plan_ref: VersionedRef;
    readonly query_plan_digest: string;
    readonly query_result_ref: VersionedRef;
    readonly query_result_digest: string;
  };
  readonly left: ResearchRelationAliasBoundFact;
  readonly right: ResearchRelationAliasBoundFact;
  /** This catalogue binds values; it does not independently verify source or target authority. */
  readonly authority_verification: {
    readonly source_references_verified: false;
    readonly target_authority_verified: false;
  };
}

export interface ResearchRelationAliasCatalogue {
  /** Pass only this value to the selected model call. It contains no canonical refs or revisions. */
  readonly model_input: ResearchRelationAliasCatalogueModelInput;
  /** Validates aliases and resolves them to this catalogue's immutable server evidence. */
  readonly parseModelOutput: (outputBytes: Uint8Array) => readonly ResearchRelationAliasPairSelection[];
}

function corrupt(): never {
  fail("WORKFLOW_OUTPUT_CORRUPT");
  throw new Error("unreachable");
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function bindTarget(plan: BranchQueryPlan, targetInput: unknown): ResearchRelationCatalogueTarget {
  const parsed = RELATION_CATALOGUE_TARGET_SCHEMA.safeParse(targetInput);
  if (!parsed.success) return corrupt();

  const target = parsed.data;
  if (target.kind === "QUESTION") {
    const questionMatches = [plan.root_question, plan.branch_question].some((question) =>
      sameRef(question.question_ref, target.question_ref) && question.text_sha256 === target.question_sha256 &&
      plan.question_refs.some((ref) => sameRef(ref, target.question_ref)));
    if (!questionMatches) return corrupt();
  } else if (
    !sameRef(plan.planning_manifest_ref, target.planning_manifest_ref) ||
    plan.planning_manifest_digest !== target.planning_manifest_digest ||
    !plan.hypothesis_refs.includes(target.hypothesis_id)
  ) {
    return corrupt();
  }

  return deepFreeze(target);
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function sourceSpanKey(fact: ResearchRelationAliasBoundFact): string {
  const handle = fact.resolved_evidence.handle;
  return JSON.stringify([handle.source_revision_ref, handle.anchor]);
}

function resolvedEvidenceExcerptsAreWellFormed(queryResult: unknown): boolean {
  if (typeof queryResult !== "object" || queryResult === null) return true;
  const resolvedEvidence = (queryResult as { readonly resolved_evidence?: unknown }).resolved_evidence;
  if (!Array.isArray(resolvedEvidence)) return true;
  return resolvedEvidence.every((item) => {
    if (typeof item !== "object" || item === null) return true;
    const exactExcerpt = (item as { readonly exact_excerpt?: unknown }).exact_excerpt;
    return typeof exactExcerpt !== "string" || exactExcerpt.isWellFormed();
  });
}

function modelOutputSchema(candidateLimit: number, factLimit: number) {
  const maxAliasLength = `F${factLimit - 1}`.length;
  const aliasSchema = z.string().min(2).max(maxAliasLength).regex(/^F(?:0|[1-9][0-9]*)$/u);
  return z.object({
    protocol: z.literal("eliotr.research.relation-alias-output.v1"),
    relations: z.array(z.object({
      left_alias: aliasSchema,
      relation_kind: RELATION_KIND_SCHEMA,
      right_alias: aliasSchema,
    }).strict()).max(candidateLimit),
  }).strict();
}

/**
 * Build a private alias view over an already plan-bound BranchQueryResult.
 * The existing query executor spends plan candidate/ref limits before exact
 * resolver work; the byte total is checked again here before any relation model
 * call. This helper performs no hydration and is not an authority verifier.
 */
export async function createResearchRelationAliasCatalogue(input: {
  readonly plan: BranchQueryPlan;
  readonly query_result: BranchQueryResult;
  readonly target: ResearchRelationCatalogueTarget;
}): Promise<ResearchRelationAliasCatalogue> {
  if (!resolvedEvidenceExcerptsAreWellFormed(input.query_result)) return corrupt();
  const parsedPlan = BranchQueryPlanSchema.safeParse(input.plan);
  const parsedResult = BranchQueryResultSchema.safeParse(input.query_result);
  if (!parsedPlan.success || !parsedResult.success || !branchQueryResultMatchesPlan(parsedPlan.data, parsedResult.data)) {
    return corrupt();
  }
  const plan = parsedPlan.data;
  const queryResult = parsedResult.data;
  const target = bindTarget(plan, input.target);
  const factLimit = Math.min(plan.budgets.candidate_limit, plan.budgets.evidence_limit);
  if (queryResult.resolved_evidence.length > factLimit) return corrupt();

  let totalUtf8Bytes = 0;
  for (const evidence of queryResult.resolved_evidence) {
    const bytes = new TextEncoder().encode(evidence.exact_excerpt);
    if (evidence.handle.terminal_state !== "LIVE" ||
        bytes.byteLength !== evidence.handle.excerpt_byte_length ||
        await sha256Hex(bytes) !== evidence.handle.excerpt_sha256) {
      return corrupt();
    }
    totalUtf8Bytes += bytes.byteLength;
  }
  if (totalUtf8Bytes !== queryResult.total_utf8_bytes || totalUtf8Bytes > plan.budgets.max_evidence_bytes) {
    return corrupt();
  }

  const facts = deepFreeze(queryResult.resolved_evidence.map((evidence, index) => ({
    alias: `F${index}`,
    resolved_evidence: evidence,
  })) satisfies ResearchRelationAliasBoundFact[]);
  const modelInput = deepFreeze({
    protocol: "eliotr.research.relation-alias-catalogue.v1" as const,
    facts: facts.map(({ alias, resolved_evidence }) => ({
      alias,
      fact_text: resolved_evidence.exact_excerpt,
    })),
  });
  const byAlias = new Map(facts.map((fact) => [fact.alias, fact] as const));
  const queryBinding = deepFreeze({
    query_plan_ref: { ...plan.query_plan_ref },
    query_plan_digest: plan.identity_digest,
    query_result_ref: { ...queryResult.query_result_ref },
    query_result_digest: queryResult.identity_digest,
  });
  const authorityVerification = Object.freeze({
    source_references_verified: false as const,
    target_authority_verified: false as const,
  });
  const outputSchema = modelOutputSchema(plan.budgets.candidate_limit, factLimit);

  const parseModelOutput = (outputBytes: Uint8Array): readonly ResearchRelationAliasPairSelection[] => {
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outputBytes));
    } catch {
      return corrupt();
    }
    const parsedOutput = outputSchema.safeParse(decoded);
    if (!parsedOutput.success) return corrupt();

    const seen = new Set<string>();
    const selections: ResearchRelationAliasPairSelection[] = [];
    for (const relation of parsedOutput.data.relations) {
      const left = byAlias.get(relation.left_alias);
      const right = byAlias.get(relation.right_alias);
      if (left === undefined || right === undefined || left.alias === right.alias ||
          sourceSpanKey(left) === sourceSpanKey(right)) {
        return corrupt();
      }
      const pair = [left.alias, right.alias].sort();
      const duplicateKey = JSON.stringify([relation.relation_kind, pair]);
      if (seen.has(duplicateKey)) return corrupt();
      seen.add(duplicateKey);
      selections.push(deepFreeze({
        relation_kind: relation.relation_kind,
        target,
        query_binding: queryBinding,
        left,
        right,
        authority_verification: authorityVerification,
      }));
    }
    return Object.freeze(selections);
  };

  return Object.freeze({ model_input: modelInput, parseModelOutput });
}
