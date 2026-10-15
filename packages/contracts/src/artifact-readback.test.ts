import { expect, it } from "vitest";
import { canonicalArtifactRevisionFromReadback } from "./publication.js";

const canonical = {
  artifact_ref: { id: "report", revision: 1 }, spec_ref: { id: "spec", revision: 1 },
  spec_digest: "a".repeat(64), evidence_freeze_ref: { id: "freeze", revision: 1 },
  sections: [{ section_ref: { id: "section", revision: 1 }, contract_id: "contract",
    body_object_ref: "body", body_sha256: "b".repeat(64), statement_labels: { claim: "SOURCE_SUPPORTED" },
    evidence_ledger_ref: "ledger", verification_receipt_ref: "receipt" }],
  dependency_manifest_ref: "dependencies", deterministic_export_refs: {}, status: "DRAFT",
  created_at: "2026-10-15T00:00:00.000Z",
};

it("keeps durable artifact identity byte-for-byte when display titles change", () => {
  const readback = { ...canonical, title: "Owner report", sections: canonical.sections.map(s => ({ ...s, title: "Evidence" })) };
  expect(JSON.stringify(canonicalArtifactRevisionFromReadback(readback))).toBe(JSON.stringify(canonical));
  expect(canonicalArtifactRevisionFromReadback(canonical)).toEqual(canonical);
  expect(() => canonicalArtifactRevisionFromReadback({ ...readback, unknown_authority: "forged" })).toThrow();
  expect(() => canonicalArtifactRevisionFromReadback({ ...canonical, title: "Incomplete title projection" })).toThrow();
});
