import { describe, expect, it } from "vitest";
import {
  decodeContractWithInvariants,
  isResearchClosingDisposition,
  validateCoverageClosure,
  validateNormalizedBundleOwnership,
  validateSourceOwnerCutover,
} from "./cross-field.js";

const versionedRef = { id: "ref", revision: 1 };

describe("cross-field wire invariants", () => {
  it("requires a separate cutover receipt exactly for ownership_cutover", () => {
    expect(validateNormalizedBundleOwnership({
      protocol: "eliotr.normalized.v1",
      origin: { ownership_mode: "ownership_cutover" },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_CONDITIONAL_FIELD" }),
    ]));

    expect(validateNormalizedBundleOwnership({
      protocol: "eliotr.normalized.v1",
      origin: {
        ownership_mode: "immutable_import",
        ownership_cutover_receipt_ref: "must-not-be-present",
      },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FORBIDDEN_CONDITIONAL_FIELD" }),
    ]));
  });

  it("rejects unilateral, colliding or revision-set-mismatched ownership cutover", () => {
    const issues = validateSourceOwnerCutover({
      protocol: "source.owner-cutover.v1",
      cutover: {
        prepared_at: "2026-08-29T12:00:00Z",
        effective_at: "2026-08-29T11:00:00Z",
      },
      old_owner: {
        owner_system_id: "same-owner",
        source_owner_generation_before_fence: "same-generation",
        final_revision_set_digest: "digest-a",
        terminal_status: "FENCED",
      },
      new_owner: {
        owner_system_id: "same-owner",
        source_owner_generation_after_activation: "same-generation",
        admitted_revision_set_digest: "digest-b",
        status: "ACTIVE",
      },
      authorization: { old_owner_authorization_ref: "old-auth" },
    });
    expect(issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "CUTOVER_REVISION_SET_MISMATCH",
      "CUTOVER_AUTHORIZATION_MISSING",
      "CUTOVER_OWNER_COLLISION",
      "CUTOVER_GENERATION_COLLISION",
      "CUTOVER_TIME_ORDER_INVALID",
    ]));
  });

  it("rejects an absence disposition without complete frozen denominator identity", () => {
    expect(validateCoverageClosure({
      denominator_kind: "sampled_with_method",
      terminal_disposition: "NO_MATCH_IN_COMPLETE_SCOPE",
    }).map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "ABSENCE_WITHOUT_COMPLETE_DENOMINATOR",
      "ABSENCE_WITHOUT_FROZEN_SCOPE",
      "ABSENCE_WITHOUT_COVERAGE_DENOMINATOR",
    ]));

    expect(validateCoverageClosure({
      denominator_kind: "complete_scope",
      terminal_disposition: "NO_MATCH_IN_COMPLETE_SCOPE",
      frozen_scope_snapshot_ref: versionedRef,
      coverage_denominator_ref: versionedRef,
    })).toHaveLength(0);
  });

  it("does not infer research closure from transport completion", () => {
    expect(isResearchClosingDisposition("COMPLETED")).toBe(false);
    expect(isResearchClosingDisposition("INCONCLUSIVE")).toBe(false);
    expect(isResearchClosingDisposition("ANSWERED_WITH_SUPPORTED_RESULT")).toBe(true);
  });

  it("never returns structurally valid data before semantic invariants pass", () => {
    const schema = {
      safeParse: (input: unknown) => ({
        success: true as const,
        data: input as {
          protocol: "eliotr.normalized.v1";
          origin: { ownership_mode: "ownership_cutover" };
        },
      }),
    };
    expect(() => decodeContractWithInvariants(schema, {
      protocol: "eliotr.normalized.v1",
      origin: { ownership_mode: "ownership_cutover" },
    }, [validateNormalizedBundleOwnership])).toThrow("ownership_cutover requires");
  });
});
