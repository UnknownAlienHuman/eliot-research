import { describe, expect, it } from "vitest";
import { WorkflowFailureOutcomeSchema } from "@eliotr/cloudflare-workflows";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { compileQueryPlan, executePlannedLanes, type RetrievalRequest } from "@eliotr/retrieval";
import {
  createProjectSearchSemLaneExecutor,
  annotateNoRetrievalEffectDispatched,
  managedProjectSearchProviderLimit,
  retrievalEffectNotDispatched,
  settleRetrievalFailure,
  settledReadOnlyRetrievalStop,
} from "./research-retrieval-composition.js";

/**
 * The review finding: absence of durable q4 admission rows does NOT prove that the
 * native SEM lane did not reach a provider, because that lane is not
 * `managed_outcome_capable` and performs no q4 admission. These cases pin the
 * server-local proof gate that replaces that unsound assumption.
 */
function budgetStop() {
  return Object.assign(new Error("query budget is exhausted"), { code: "RETRIEVAL_BUDGET_STOP" });
}

describe("retrieval dispatch proof gate", () => {
  it("keeps the provider candidate cap independent from a smaller resolved-evidence limit", () => {
    expect(managedProjectSearchProviderLimit({
      request: { requested_limit: 16, budgets: {
        candidate_limit: 50, scan_limit: 100, evidence_limit: 16, max_evidence_bytes: 65_536,
      } },
      provider_candidate_limit: 50,
    })).toBe(50);
  });

  it("refuses to settle an unannotated stop even for a mapped read-only code", () => {
    const error = budgetStop();
    expect(retrievalEffectNotDispatched(error)).toBe(false);
    expect(settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" })).toBeNull();
  });

  it("refuses to settle an unannotated RESOLUTION_UNCERTAIN stop", () => {
    const error = Object.assign(new Error("settlement is uncertain"), { code: "RETRIEVAL_RESOLUTION_UNCERTAIN" });
    expect(settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" })).toBeNull();
  });

  it("never settles RESOLUTION_UNCERTAIN even when the tracker is untouched", () => {
    // The code itself means "cannot tell", so proven non-dispatch must not turn it
    // into a settled known failure; the durable admission probe stays irrelevant.
    const error = Object.assign(new Error("stored query result is unavailable"), {
      code: "RETRIEVAL_RESOLUTION_UNCERTAIN",
    });
    annotateNoRetrievalEffectDispatched(error);
    expect(retrievalEffectNotDispatched(error)).toBe(true);
    expect(settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" })).toBeNull();
  });

  it("refuses an annotated stop whose code is not a pre-dispatch candidate", () => {
    const error = Object.assign(new Error("managed provider execution outcome is uncertain"), {
      code: "RETRIEVAL_RESOLUTION_UNCERTAIN",
    });
    annotateNoRetrievalEffectDispatched(error);
    // Annotated, but an unproven code still cannot widen settlement beyond the map.
    const dispatchCapable = Object.assign(new Error("provider transport failed"), {
      code: "MODEL_GATEWAY_TRANSPORT_FAILED",
    });
    annotateNoRetrievalEffectDispatched(dispatchCapable);
    expect(settledReadOnlyRetrievalStop({ error: dispatchCapable, code: dispatchCapable.code, stage: "RETRIEVE_BRANCHES" }))
      .toBeNull();
  });

  it("settles only an annotated stop with a mapped pre-dispatch code", () => {
    const error = budgetStop();
    annotateNoRetrievalEffectDispatched(error);
    const settled = settledReadOnlyRetrievalStop({ error, code: error.code, stage: "RETRIEVE_BRANCHES" });
    expect(settled).toEqual({
      protocol: "eliotr.workflow-failure-outcome.v1",
      code: "WORKFLOW_BUDGET_STOP",
      phase: "STAGE",
      stage: "RETRIEVE_BRANCHES",
      retryable: false,
      dispatch_state: "NOT_STARTED",
      references_intact: "INTACT",
      recovery_action: "NONE",
    });
    expect(WorkflowFailureOutcomeSchema.safeParse(settled).success).toBe(true);
  });

  it("does not treat a browser-supplied or inherited property as dispatch proof", () => {
    const spoofed = { code: "RETRIEVAL_BUDGET_STOP", "eliotr.retrieval-no-effect-dispatched": true };
    expect(retrievalEffectNotDispatched(spoofed)).toBe(false);
    const inherited = Object.create({ "eliotr.retrieval-no-effect-dispatched": true }) as object;
    Object.assign(inherited, { code: "RETRIEVAL_BUDGET_STOP" });
    expect(retrievalEffectNotDispatched(inherited)).toBe(false);
  });

  it("reports a frozen error as unproven rather than throwing", () => {
    const frozen = Object.freeze(Object.assign(new Error("budget stop"), { code: "RETRIEVAL_BUDGET_STOP" }));
    expect(retrievalEffectNotDispatched(frozen)).toBe(false);
    expect(settledReadOnlyRetrievalStop({ error: frozen, code: "RETRIEVAL_BUDGET_STOP", stage: "RETRIEVE_BRANCHES" }))
      .toBeNull();
  });

  it("annotates only the untouched tracker and leaves a dispatched stop unproven", () => {
    const untouched = budgetStop();
    expect(() => settleRetrievalFailure({ effect_dispatched: false }, untouched)).toThrow(untouched);
    expect(retrievalEffectNotDispatched(untouched)).toBe(true);

    const dispatched = budgetStop();
    expect(() => settleRetrievalFailure({ effect_dispatched: true }, dispatched)).toThrow(dispatched);
    expect(retrievalEffectNotDispatched(dispatched)).toBe(false);
    expect(settledReadOnlyRetrievalStop({ error: dispatched, code: dispatched.code, stage: "RETRIEVE_BRANCHES" }))
      .toBeNull();
  });
});

describe("held-scope SEM managed-mode selection", () => {
  const request = {
    raw_query: "How do positional encodings work?",
    product: "RESEARCH",
    scope_snapshot: {
      member_source_revision_refs: ["revision-1"],
      source_owner_generations: { "revision-1": "owner-generation-1" },
    },
    literals: ["positional"],
    requested_limit: 4,
    deadline_ms: Date.now() + 5_000,
  } as unknown as RetrievalRequest;

  function database(kind: "core" | "search", registryAvailable = false) {
    const projection = {
      item_key: "projection-item-1",
      source_revision_ref: "revision-1",
      title: "Positional encodings",
      document_context_header: "",
      section_text: "Canonical indexed section.",
      canonical_section_id: "section-1",
      content_sha256: "a".repeat(64),
      instruction_taint: "DATA_ONLY",
      projection_generation: "projection-generation-1",
    };
    return {
      prepare(sql: string) {
        return {
          bind() {
            return {
              all: async () => {
                if (kind === "core" && sql.includes("FROM project_source_membership m")) {
                  return { success: true, results: [{ source_id: "source-1", source_revision_ref: "revision-1" }] };
                }
                if (kind === "search" && sql.includes("FROM projection_item WHERE source_revision_ref")) {
                  return { success: true, results: [projection] };
                }
                return { success: true, results: [] };
              },
              first: async () => {
                if (kind === "core" && sql.includes("SELECT 1 AS current FROM project_source_membership")) {
                  return { current: 1 };
                }
                if (kind === "search" && sql.includes("FROM ai_search_generation_registry")) {
                  return registryAvailable ? {} : null;
                }
                return null;
              },
              run: async () => ({ success: true }),
            };
          },
        };
      },
    } as unknown as D1Database;
  }

  it("keeps the legacy LEX then native SEM path when no server-owned budgets are present", async () => {
    const providerCalls: Record<string, unknown>[] = [];
    const namespace = {
      get(instanceId: string) {
        return {
          search: async (request: Record<string, unknown>) => {
            providerCalls.push({ instance_id: instanceId, request });
            return { chunks: [] };
          },
        };
      },
    } as unknown as AiSearchNamespaceLike;
    const dispatchProof = { effect_dispatched: false };
    const sem = createProjectSearchSemLaneExecutor({
      namespace,
      core_database: database("core"),
      search_database: database("search"),
      project_id: "project-1",
      dispatch_proof: dispatchProof,
    });
    expect(sem.managed_outcome_capable).toBe(false);

    const lanes: string[] = [];
    const plan = compileQueryPlan(request);
    const receipts = await executePlannedLanes(plan, request, {
      executorFor(lane) {
        if (lane === "IDENT" || lane === "EXACT" || lane === "LEX") {
          return { execute: async () => { lanes.push(lane); return []; } };
        }
        if (lane === "SEM") return sem;
        return null;
      },
    });

    expect(lanes).toEqual(["IDENT", "EXACT", "LEX"]);
    expect(plan.lanes.indexOf("LEX")).toBeLessThan(plan.lanes.indexOf("SEM"));
    expect(plan.lanes.indexOf("EXACT")).toBeLessThan(plan.lanes.indexOf("SEM"));
    expect(receipts.find((receipt) => receipt.lane === "LEX")?.disposition).toBe("EXECUTED");
    expect(receipts.find((receipt) => receipt.lane === "SEM")?.disposition).toBe("EXECUTED");
    expect(providerCalls).toHaveLength(1);
    expect((providerCalls[0]?.request as { ai_search_options?: { retrieval?: { context_expansion?: number } } })
      .ai_search_options?.retrieval?.context_expansion).toBe(2);
    expect(dispatchProof.effect_dispatched).toBe(true);
  });

  it("keeps V9 managed execution fail-closed when the canonical registry is absent", async () => {
    const providerCalls: unknown[] = [];
    const namespace = {
      get() { return { search: async (request: unknown) => { providerCalls.push(request); return { chunks: [] }; } }; },
    } as unknown as AiSearchNamespaceLike;
    const dispatchProof = { effect_dispatched: false };
    const sem = createProjectSearchSemLaneExecutor({
      namespace,
      core_database: database("core"),
      search_database: database("search"),
      project_id: "project-1",
      budgets: { candidate_limit: 12, scan_limit: 24, evidence_limit: 2, max_evidence_bytes: 4096 },
      dispatch_proof: dispatchProof,
    });
    expect(sem.managed_outcome_capable).toBe(true);
    await expect(sem.preflightManagedCall?.(request, { provider_candidate_limit: 12 }))
      .rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_NOT_PROMOTED" });
    expect(providerCalls).toHaveLength(0);
    expect(dispatchProof.effect_dispatched).toBe(false);
  });
});
