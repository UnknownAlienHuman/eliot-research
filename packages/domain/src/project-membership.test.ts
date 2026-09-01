import type { ProjectSourceMembership, ScopeExpression } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  activeProjectMembershipsAt,
  inspectScopeExpression,
  normalizeScopeExpression,
  scopeExpressionIdentity,
  validateProjectMembershipTimeline,
} from "./index.js";

function membership(
  projectId: string,
  sourceId: string,
  validFrom: string,
  validTo?: string,
): ProjectSourceMembership {
  return {
    membership_ref: {
      id: `membership-${projectId}-${sourceId}-${validFrom.replaceAll(":", "-")}`,
      revision: 1,
    },
    project_id: projectId,
    source_id: sourceId,
    role: "evidence",
    valid_from: validFrom,
    ...(validTo === undefined ? {} : { valid_to: validTo }),
    membership_generation: `membership-generation-${projectId}`,
    admitted_by_receipt_ref: `receipt-${projectId}`,
  };
}

function project(projectId: string): ScopeExpression {
  return { kind: "PROJECT", project_id: projectId };
}

describe("ER-30 project membership and scope normalization", () => {
  it("allows one source to be active in several projects without duplicating source identity", () => {
    const sourceId = "global-source-1";
    const result = activeProjectMembershipsAt([
      membership("project-alpha", sourceId, "2026-08-01T00:00:00.000Z"),
      membership("project-beta", sourceId, "2026-08-15T00:00:00.000Z"),
    ], "2026-09-01T00:00:00.000Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry) => entry.project_id)).toEqual([
      "project-alpha",
      "project-beta",
    ]);
    expect(new Set(result.value.map((entry) => entry.source_id))).toEqual(new Set([sourceId]));
  });

  it("accepts adjacent intervals but rejects overlapping authority for one project/source pair", () => {
    const adjacent = validateProjectMembershipTimeline([
      membership(
        "project-alpha",
        "source-1",
        "2026-08-01T00:00:00.000Z",
        "2026-08-15T00:00:00.000Z",
      ),
      membership("project-alpha", "source-1", "2026-08-15T00:00:00.000Z"),
    ]);
    expect(adjacent.ok).toBe(true);

    const overlap = validateProjectMembershipTimeline([
      membership(
        "project-alpha",
        "source-1",
        "2026-08-01T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ),
      membership("project-alpha", "source-1", "2026-08-15T00:00:00.000Z"),
    ]);
    expect(overlap).toMatchObject({
      ok: false,
      error: { code: "MEMBERSHIP_INTERVAL_OVERLAP" },
    });
  });

  it("normalizes commutative scope ASTs and selected-source identities deterministically", () => {
    const first: ScopeExpression = {
      kind: "UNION",
      left: project("project-beta"),
      right: {
        kind: "SELECTED_SOURCES",
        source_ids: ["source-2", "source-1", "source-1"],
      },
    };
    const second: ScopeExpression = {
      kind: "UNION",
      left: {
        kind: "SELECTED_SOURCES",
        source_ids: ["source-1", "source-2"],
      },
      right: project("project-beta"),
    };

    expect(normalizeScopeExpression(first)).toEqual(normalizeScopeExpression(second));
    expect(scopeExpressionIdentity(first)).toBe(scopeExpressionIdentity(second));
    expect(inspectScopeExpression(first)).toEqual({
      depth: 2,
      atom_count: 2,
      selected_source_count: 3,
    });
  });
});
