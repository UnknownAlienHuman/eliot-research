import { describe, expect, it } from "vitest";
import { mapInternalOutcomeToDisposition, resolveScopeExpression, serializeObjectResidencyKey } from "./index.js";

describe("domain invariants", () => {
  it("maps internal failures toward a less assertive wire disposition", () => {
    expect(mapInternalOutcomeToDisposition("FAILED")).toBe("INCONCLUSIVE");
    expect(mapInternalOutcomeToDisposition("BUDGET_EXHAUSTED_PARTIAL")).toBe("INCOMPLETE_COVERAGE");
  });

  it("resolves deterministic project unions", () => {
    const result = resolveScopeExpression(
      { kind: "UNION", left: { kind: "PROJECT", project_id: "a" }, right: { kind: "PROJECT", project_id: "b" } },
      {
        globalSourceRevisionRefs: new Set(),
        projects: new Map([["a", new Set(["r1"])], ["b", new Set(["r2"])]]),
        sourceClasses: new Map(),
        tags: new Map(),
        selectedSourceHeads: new Map(),
      },
    );
    expect(result.ok && [...result.value].sort()).toEqual(["r1", "r2"]);
  });

  it("serializes every residency domain", () => {
    const serialized = serializeObjectResidencyKey({
      scope_domain_id: "s", access_domain_id: "a", confidentiality_domain_id: "c",
      encryption_key_domain_id: "k", retention_domain_id: "r", erasure_domain_id: "e",
      content_digest: { algorithm: "sha256", digest: "0".repeat(64) },
    });
    expect(serialized).toContain("object-residency-key.v1/s/a/c/k/r/e/sha256");
  });
});
