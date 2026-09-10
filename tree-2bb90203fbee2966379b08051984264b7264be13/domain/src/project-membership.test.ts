import type { ProjectSourceMembership, ScopeExpression } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  activeProjectMembershipsAt,
  closeMembership,
  inspectScopeExpression,
  isMembershipActiveAt,
  membershipIdentity,
  normalizeScopeExpression,
  scopeExpressionIdentity,
  validateProjectMembershipTimeline,
} from "./index.js";

let membershipSequence = 0;

function membership(
  projectId: string,
  sourceId: string,
  validFrom: string,
  validTo?: string,
): ProjectSourceMembership {
  membershipSequence += 1;
  return {
    membership_ref: {
      id: `membership-${membershipSequence}`,
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

function binary(
  kind: "UNION" | "INTERSECT" | "EXCEPT",
  left: ScopeExpression,
  right: ScopeExpression,
): ScopeExpression {
  return { kind, left, right };
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

  it("treats intervals as half-open, accepts adjacency and rejects overlap", () => {
    const first = membership(
      "project-alpha",
      "source-1",
      "2026-08-01T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
    );
    const second = membership(
      "project-alpha",
      "source-1",
      "2026-08-15T00:00:00.000Z",
    );
    expect(validateProjectMembershipTimeline([second, first]).ok).toBe(true);
    expect(isMembershipActiveAt(first, first.valid_from)).toBe(true);
    expect(isMembershipActiveAt(first, "2026-08-15T00:00:00.000Z")).toBe(false);
    expect(isMembershipActiveAt(second, "2026-08-15T00:00:00.000Z")).toBe(true);

    const overlap = validateProjectMembershipTimeline([
      membership(
        "project-alpha",
        "source-2",
        "2026-08-01T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
      ),
      membership("project-alpha", "source-2", "2026-08-15T00:00:00.000Z"),
    ]);
    expect(overlap).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_MEMBERSHIP_INTERVAL",
        details: { reason: "INTERVAL_OVERLAP" },
      },
    });
  });

  it("orders offset timestamps by instant and rejects equivalent-instant overlap", () => {
    const result = validateProjectMembershipTimeline([
      membership(
        "project-alpha",
        "source-offset",
        "2026-09-01T00:00:00+00:00",
        "2026-09-01T02:00:00+00:00",
      ),
      membership(
        "project-alpha",
        "source-offset",
        "2026-08-31T21:00:00-04:00",
        "2026-08-31T22:00:00-04:00",
      ),
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_MEMBERSHIP_INTERVAL",
        details: { reason: "INTERVAL_OVERLAP" },
      },
    });
  });

  it("uses collision-free tuple identities when identifiers contain delimiters", () => {
    const first = membership("a:b", "c", "2026-09-01T00:00:00.000Z");
    const second = membership("a", "b:c", "2026-09-01T00:00:00.000Z");

    expect(membershipIdentity(first)).not.toBe(membershipIdentity(second));
    expect(validateProjectMembershipTimeline([first, second]).ok).toBe(true);
  });

  it("closes an open interval exactly once and rejects malformed time authority", () => {
    const open = membership("project-alpha", "source-1", "2026-09-01T00:00:00.000Z");
    const closed = closeMembership(open, "2026-09-02T00:00:00+00:00");
    expect(closed).toMatchObject({
      ok: true,
      value: { valid_to: "2026-09-02T00:00:00+00:00" },
    });
    if (!closed.ok) return;
    expect(closeMembership(closed.value, "2026-09-03T00:00:00.000Z")).toMatchObject({
      ok: false,
      error: { code: "MEMBERSHIP_ALREADY_CLOSED" },
    });
    expect(closeMembership(open, "2026-08-31T23:59:59.999Z")).toMatchObject({
      ok: false,
      error: { details: { reason: "END_NOT_AFTER_START" } },
    });
    expect(activeProjectMembershipsAt([open], "not-an-instant")).toMatchObject({
      ok: false,
      error: { details: { reason: "OBSERVED_AT_INVALID" } },
    });
  });

  it("fails closed for strict-schema and tuple-identity conflicts", () => {
    const invalid = {
      ...membership("project-alpha", "source-1", "2026-09-01T00:00:00.000Z"),
      valid_from: "not-an-instant",
    } as ProjectSourceMembership;
    expect(validateProjectMembershipTimeline([invalid])).toMatchObject({
      ok: false,
      error: { details: { reason: "SCHEMA_INVALID" } },
    });

    const duplicate = membership("project-alpha", "source-2", "2026-09-01T00:00:00.000Z");
    expect(validateProjectMembershipTimeline([
      duplicate,
      { ...duplicate, membership_ref: { id: "membership-duplicate", revision: 1 } },
    ])).toMatchObject({
      ok: false,
      error: { details: { reason: "IDENTITY_CONFLICT" } },
    });
  });

  it("normalizes commutative scopes and preserves EXCEPT operand order", () => {
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
    expect(scopeExpressionIdentity(binary("EXCEPT", project("a"), project("b"))))
      .not.toBe(scopeExpressionIdentity(binary("EXCEPT", project("b"), project("a"))));
    expect(inspectScopeExpression(first)).toEqual({
      depth: 2,
      atom_count: 2,
      selected_source_count: 3,
    });
  });
});
