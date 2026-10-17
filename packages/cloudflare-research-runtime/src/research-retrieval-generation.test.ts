import { describe, expect, it } from "vitest";
import { BRANCH_QUERY_HANDLER_GENERATION } from "@eliotr/cloudflare-research";
import { compileQueryPlan, executePlannedLanes, type RetrievalRequest } from "@eliotr/retrieval";
import {
  committedResearchRetrievalProductMatches,
  researchRetrievalProductForGeneration,
} from "./research-retrieve-branches.js";

describe("retrieval generation dispatch and historical products", () => {
  it("dispatches V9 through the semantic plan with the existing context expansion", async () => {
    const product = researchRetrievalProductForGeneration(BRANCH_QUERY_HANDLER_GENERATION);
    const request: RetrievalRequest = { raw_query: "Compare positional encodings in two papers", product, literals: [],
      requested_limit: 16, deadline_ms: Date.now() + 5000, scope_snapshot: {
        snapshot_id: "generation-dispatch-scope", revision: 1,
        resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
        participant_generations: {}, member_source_revision_refs: ["revision-1"],
        source_owner_generations: { "revision-1": "owner-1" }, policy_authority_ref: "policy-1",
        disclosure_closure_digest: "a".repeat(64), purge_ledger_revision: 0, digest: "b".repeat(64),
        created_at: "2026-10-17T00:00:00.000Z", expires_at: "2026-10-18T00:00:00.000Z",
      } };
    const plan = compileQueryPlan(request);
    const semanticCalls: { product: string; expansion: number }[] = [];
    const receipts = await executePlannedLanes(plan, request, {
      executorFor(lane) {
        if (lane === "SEM") return { execute: async (_lane, semanticRequest) => {
          const semanticPlan = compileQueryPlan(semanticRequest);
          semanticCalls.push({ product: semanticPlan.product, expansion: semanticPlan.context_expansion });
          return [];
        } };
        if (lane === "IDENT" || lane === "LEX") return { execute: async () => [] };
        return null;
      },
    });
    expect(product).toBe("RESEARCH");
    expect(semanticCalls).toEqual([{ product: "RESEARCH", expansion: 2 }]);
    expect(receipts.find(receipt => receipt.lane === "SEM")?.disposition).toBe("EXECUTED");
  });

  it("retains the exact historical products of the other handler generations", () => {
    for (const version of [1, 2, 3, 5]) {
      expect(researchRetrievalProductForGeneration(`research-handlers.exploratory.v${version}`)).toBe("FAST_SEARCH");
    }
    for (const version of [4, 6, 7, 8]) {
      expect(researchRetrievalProductForGeneration(`research-handlers.exploratory.v${version}`)).toBe("RESEARCH");
    }
  });

  it("permits the committed V9 FAST_SEARCH history without allowing it for new dispatch", () => {
    expect(committedResearchRetrievalProductMatches(BRANCH_QUERY_HANDLER_GENERATION, "FAST_SEARCH")).toBe(true);
    expect(committedResearchRetrievalProductMatches(BRANCH_QUERY_HANDLER_GENERATION, "RESEARCH")).toBe(true);
    expect(researchRetrievalProductForGeneration(BRANCH_QUERY_HANDLER_GENERATION)).toBe("RESEARCH");
    expect(committedResearchRetrievalProductMatches(BRANCH_QUERY_HANDLER_GENERATION, "EXHAUSTIVE_JOB")).toBe(false);
    expect(committedResearchRetrievalProductMatches("research-handlers.exploratory.v7", "FAST_SEARCH")).toBe(false);
  });
});
