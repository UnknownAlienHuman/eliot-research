import type { ErasureRequest } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  exactLocationEquality,
  validateErasureRequest,
} from "./canonical.js";

function request(overrides: Partial<ErasureRequest> = {}): ErasureRequest {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: "erasure-1", revision: 1 },
    requested_by_principal_ref: "privacy-officer-1",
    exact_subject_refs: ["source-revision:revision-b", "source-revision:revision-a"],
    required_locations: ["ProviderCopy", "CanonicalPayload"],
    legal_basis_ref: "deletion-request-1",
    admitted_at: "2026-09-01T00:00:00.000Z",
    deadline: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("erasure canonical request boundary", () => {
  it("canonicalizes set-like request members before identity hashing", () => {
    const validated = validateErasureRequest(request());
    expect(validated.exact_subject_refs).toEqual([
      "source-revision:revision-a",
      "source-revision:revision-b",
    ]);
    expect(validated.required_locations).toEqual(["CanonicalPayload", "ProviderCopy"]);
  });

  it("rejects duplicate subjects and a non-forward deadline", () => {
    expect(() => validateErasureRequest(request({
      exact_subject_refs: ["source:one", "source:one"],
    }))).toThrow();
    expect(() => validateErasureRequest(request({
      deadline: "2026-09-01T00:00:00.000Z",
    }))).toThrow();
  });

  it("requires exact location equality rather than subset completion", () => {
    expect(exactLocationEquality(
      ["CanonicalPayload", "BackupRestorePath"],
      ["CanonicalPayload"],
    )).toBe(false);
    expect(exactLocationEquality(
      ["BackupRestorePath", "CanonicalPayload"],
      ["CanonicalPayload", "BackupRestorePath"],
    )).toBe(true);
  });
});
