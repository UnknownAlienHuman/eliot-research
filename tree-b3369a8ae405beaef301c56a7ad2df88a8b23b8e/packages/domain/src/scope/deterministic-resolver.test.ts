import { describe, expect, it } from "vitest";
import type { ScopeExpression } from "@eliotr/contracts";
import {
  canonicalizeDeterministicScopeExpression,
  resolveDeterministicScopeSnapshotDraft,
  DeterministicScopeResolutionError,
  type DeterministicScopeAtom,
  type DeterministicScopeAtomResolution,
} from "./deterministic-resolver.js";

const member = (id: string, generation = "owner-g1") => ({
  source_revision_ref: id,
  source_owner_generation: generation,
  policy_closure_ref: "policy-r1",
});

const fixtures = new Map<string, DeterministicScopeAtomResolution>([
  ["a", { atom_generation_ref: "project-a-r1", members: [member("r2"), member("r1")] }],
  ["b", { atom_generation_ref: "project-b-r3", members: [member("r2"), member("r3")] }],
]);
const resolver = {
  async resolve(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution> {
    if (atom.kind !== "PROJECT") throw new Error("fixture supports PROJECT atoms only");
    const result = fixtures.get(atom.project_id);
    if (result === undefined) throw new Error("unknown project fixture");
    return result;
  },
};
const project = (project_id: string): ScopeExpression => ({ kind: "PROJECT", project_id });

function binary(
  kind: "UNION" | "INTERSECT" | "EXCEPT",
  left: ScopeExpression,
  right: ScopeExpression,
): ScopeExpression {
  return { kind, left, right };
}

describe("deterministic scope resolver", () => {
  it("sorts and deduplicates UNION members and generations", async () => {
    const result = await resolveDeterministicScopeSnapshotDraft(
      binary("UNION", project("a"), project("b")),
      resolver,
    );
    expect(result.members.map((item) => item.source_revision_ref)).toEqual(["r1", "r2", "r3"]);
    expect(result.participant_generation_refs).toEqual(["project-a-r1", "project-b-r3"]);
  });

  it("canonicalizes commutative and associative expressions identically", () => {
    const first = binary("UNION", project("b"), binary("UNION", project("c"), project("a")));
    const second = binary("UNION", binary("UNION", project("a"), project("b")), project("c"));
    expect(canonicalizeDeterministicScopeExpression(first))
      .toBe(canonicalizeDeterministicScopeExpression(second));
  });

  it("implements INTERSECT and EXCEPT as exact revision-set operations", async () => {
    const intersection = await resolveDeterministicScopeSnapshotDraft(
      binary("INTERSECT", project("a"), project("b")),
      resolver,
    );
    expect(intersection.members.map((item) => item.source_revision_ref)).toEqual(["r2"]);

    const difference = await resolveDeterministicScopeSnapshotDraft(
      binary("EXCEPT", project("a"), project("b")),
      resolver,
    );
    expect(difference.members.map((item) => item.source_revision_ref)).toEqual(["r1"]);
  });

  for (const kind of ["UNION", "INTERSECT", "EXCEPT"] as const) {
    it(`fails closed on conflicting generations in ${kind}`, async () => {
      const conflictingResolver = {
        async resolve(atom: DeterministicScopeAtom): Promise<DeterministicScopeAtomResolution> {
          return atom.kind === "PROJECT" && atom.project_id === "a"
            ? { atom_generation_ref: "a", members: [member("same", "g1")] }
            : { atom_generation_ref: "b", members: [member("same", "g2")] };
        },
      };
      await expect(resolveDeterministicScopeSnapshotDraft(
        binary(kind, project("a"), project("b")),
        conflictingResolver,
      )).rejects.toBeInstanceOf(DeterministicScopeResolutionError);
    });
  }

  it("rejects surrounding whitespace instead of silently normalizing identity", async () => {
    const whitespaceResolver = {
      async resolve(): Promise<DeterministicScopeAtomResolution> {
        return { atom_generation_ref: "generation", members: [member(" revision ")] };
      },
    };
    await expect(resolveDeterministicScopeSnapshotDraft(
      project("a"),
      whitespaceResolver,
    )).rejects.toThrow("surrounding whitespace");
  });
});
