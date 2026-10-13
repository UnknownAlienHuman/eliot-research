import { describe, expect, it } from "vitest";
import fixtureRaw from "../../../docs/contracts/fixtures/eliotr.research-session-binding.v1.json?raw";
import { ResearchSessionBindingDescriptorSchema } from "./research-session-binding.js";
import {
  CANONICAL_FIXTURE_REGISTRY,
  buildContractSchemaId,
  requireContractSchemaDescriptor,
  serializeCanonicalContractJson,
} from "./registry-index.js";
import { sha256 } from "./schema-registry-test-support.js";

describe("research session binding registered contract", () => {
  it("registers both public schemas with stable research v1/g1 identities", () => {
    for (const name of ["ResearchSessionBindingDescriptorSchema", "ResearchSessionLocatorSchema"]) {
      expect(requireContractSchemaDescriptor(name)).toMatchObject({
        schema_id: buildContractSchemaId("research", name, 1, 1),
        family: "research",
        schema_version: 1,
        schema_generation: 1,
      });
    }
    expect(requireContractSchemaDescriptor("ResearchSessionBindingDescriptorSchema")
      .structural_strictness).toBe("CLOSED_OBJECT");
  });

  it("round-trips the registered canonical fixture without changing its digest", async () => {
    const fixture: unknown = JSON.parse(fixtureRaw);
    const parsed = ResearchSessionBindingDescriptorSchema.parse(fixture);
    expect(JSON.parse(serializeCanonicalContractJson(parsed))).toEqual(fixture);
    const metadata = CANONICAL_FIXTURE_REGISTRY.fixtures.find(
      value => value.fixture_id === "research-session-binding-v1",
    );
    expect(metadata?.schema_export).toBe("ResearchSessionBindingDescriptorSchema");
    expect(await sha256(parsed)).toBe(metadata?.canonical_body_sha256);
  });
});
