import { describe, expect, it } from "vitest";
import type { LocatorCandidate } from "@eliotr/contracts";
import { createSemLaneExecutor } from "./lanes.js";
import type { ManagedSearchPort, RetrievalRequest } from "./ports.js";

function request(): RetrievalRequest {
  return {
    raw_query: "needle",
    product: "ORIENT",
    scope_snapshot: {} as never,
    literals: [],
    requested_limit: 8,
    deadline_ms: 5_000,
  };
}

function candidate(): LocatorCandidate {
  return {
    candidate_id: "chunk-sem-1",
    lane: "SEM",
    source_revision_ref: "rev-1",
    canonical_section_id: "sec-1",
    preview: "",
    raw_score: 0.83,
    rank: 1,
    index_generation: "gen-1",
    metadata: {},
  };
}

function managedStub(
  onSearch: (
    request: RetrievalRequest,
    lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
    expansion: 0 | 1 | 2 | 3,
  ) => Promise<readonly LocatorCandidate[]>,
): ManagedSearchPort {
  return { search: onSearch };
}

async function laneError(
  promise: Promise<unknown>,
): Promise<{ readonly code?: unknown; readonly name?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { readonly code?: unknown; readonly name?: string };
  }
  throw new Error("expected lane execution to fail");
}

describe("SEM lane executor over the managed-search surface", () => {
  it("serves SEM with plan expansion and drops the local proof_state marker", async () => {
    let observed: { readonly lanes: readonly string[]; readonly expansion: number } | null = null;
    const executor = createSemLaneExecutor(
      managedStub(async (_request, lanes, expansion) => {
        observed = { lanes: [...lanes], expansion };
        return [
          { ...candidate(), proof_state: "UNRESOLVED_LOCATOR" } as unknown as LocatorCandidate,
        ];
      }),
    );
    const results = await executor.execute("SEM", request());
    // ORIENT plans carry context_expansion 1.
    expect(observed).toEqual({ lanes: ["SEM"], expansion: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty("proof_state");
    expect(results[0]).toMatchObject({ candidate_id: "chunk-sem-1", lane: "SEM" });
  });

  it("refuses lanes other than SEM", async () => {
    const executor = createSemLaneExecutor(managedStub(async () => [candidate()]));
    const error = await laneError(executor.execute("LEX", request()));
    expect(error.code).toBe("SEARCH_INPUT_INVALID");
  });

  it("degrades an unpromoted managed generation to SEARCH_UNAVAILABLE", async () => {
    const executor = createSemLaneExecutor(
      managedStub(async () => {
        throw Object.assign(new Error("no promoted generation"), {
          code: "AI_SEARCH_MANAGED_NOT_PROMOTED",
        });
      }),
    );
    const error = await laneError(executor.execute("SEM", request()));
    expect(error.code).toBe("SEARCH_UNAVAILABLE");
  });

  it("fails a mid-read registry rotation as SEARCH_INCOMPLETE instead of serving it", async () => {
    const executor = createSemLaneExecutor(
      managedStub(async () => {
        throw Object.assign(new Error("active head rotated"), {
          code: "AI_SEARCH_MANAGED_REGISTRY_CHANGED",
        });
      }),
    );
    const error = await laneError(executor.execute("SEM", request()));
    expect(error.code).toBe("SEARCH_INCOMPLETE");
  });

  it("passes other managed failures through with their original code", async () => {
    const executor = createSemLaneExecutor(
      managedStub(async () => {
        throw Object.assign(new Error("provider call failed"), {
          code: "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED",
        });
      }),
    );
    const error = await laneError(executor.execute("SEM", request()));
    expect(error.code).toBe("AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED");
  });
});
