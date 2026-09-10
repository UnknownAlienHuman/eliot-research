import { describe, expect, it } from "vitest";
import { splitExhaustiveSourceRefs } from "./orientation-authority.js";

describe("exhaustive source authority batching", () => {
  it("keeps the 4096 retrieval bound while splitting every authority read at 64", () => {
    const refs = Array.from({ length: 65 }, (_, index) => `revision-${index + 1}`);
    const batches = splitExhaustiveSourceRefs(refs);

    expect(batches.map((batch) => batch.length)).toEqual([64, 1]);
    expect(batches.flat()).toEqual(refs);
  });

  it("rejects duplicate authority identities before any batch can run", () => {
    expect(() => splitExhaustiveSourceRefs(["revision-1", "revision-1"])).toThrow("ORIENTATION_SCOPE_LIMIT");
  });
});
