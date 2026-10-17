import { describe, expect, it } from "vitest";
import { ProjectGuideRequestSchema, ProjectGuideViewSchema } from "./project-guide.js";

const missing = { protocol: "eliotr.project-guide.v1", project_id: "project", language: "en", state: "MISSING",
  corpus_digest: "a".repeat(64), identity_digest: "b".repeat(64), source_count: 10,
  workflow_instance_id: null, artifact_ref: null, reason_code: null, guide: null };
describe("project guide public wire contract", () => {
  it("rejects extra caller controls rather than accepting provider or budget overrides", () => {
    expect(ProjectGuideRequestSchema.parse({ protocol: "eliotr.project-guide.v1", language: "en" }).language).toBe("en");
    for (const extra of [{ provider_id: "other" }, { max_results: 100 }, { scope_expression: { kind: "GLOBAL_LIBRARY" } }, { key: "secret" }]) {
      expect(ProjectGuideRequestSchema.safeParse({ protocol: "eliotr.project-guide.v1", language: "en", ...extra }).success).toBe(false);
    }
  });
  it("cannot declare success or empty-project state without their required proof", () => {
    expect(ProjectGuideViewSchema.parse(missing).state).toBe("MISSING");
    for (const invalid of [
      { ...missing, state: "READY" }, { ...missing, state: "PARTIAL" }, { ...missing, state: "EMPTY" },
      { ...missing, extra: "unrecognized authority" },
    ]) expect(ProjectGuideViewSchema.safeParse(invalid).success).toBe(false);
  });
});
