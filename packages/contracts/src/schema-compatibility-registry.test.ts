import { describe, expect, it } from "vitest";

import compatibilityRegistryRaw from "../../../docs/contracts/compatibility-registry.v1.json?raw";
import schemaIndexRaw from "../../../docs/contracts/schema-index.v1.json?raw";
import {
  CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
  CONTRACT_SCHEMA_MAX_ORDINAL,
  CONTRACT_SCHEMA_REGISTRY_GENERATION,
  ContractCompatibilityRegistrySchema,
  ContractSchemaIndexDocumentSchema,
  ContractSchemaIndexEntrySchema,
  assertCurrentContractCompatibility,
  buildContractSchemaId,
  serializeCanonicalContractJson,
} from "./registry-index.js";
import { buildExpectedIndex } from "./schema-registry-test-support.js";

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function exactIndexFields(entry: {
  readonly schema_id: string;
  readonly export_name: string;
  readonly family: string;
  readonly schema_version: number;
  readonly schema_generation: number;
  readonly kind: string;
  readonly structural_strictness: string;
  readonly json_schema_sha256: string;
}) {
  return {
    schema_id: entry.schema_id,
    export_name: entry.export_name,
    family: entry.family,
    schema_version: entry.schema_version,
    schema_generation: entry.schema_generation,
    kind: entry.kind,
    structural_strictness: entry.structural_strictness,
    json_schema_sha256: entry.json_schema_sha256,
  };
}

function compatibilityEntry(
  exportName: string,
  family: "common" | "source",
  version: number,
  generation: number,
  compatibility: "INITIAL" | "BACKWARD_COMPATIBLE" | "BREAKING" | "RETIRED",
  supersedesSchemaId?: string,
) {
  return {
    schema_id: buildContractSchemaId(
      family,
      exportName,
      version,
      generation,
    ),
    export_name: exportName,
    family,
    schema_version: version,
    schema_generation: generation,
    kind: "OBJECT" as const,
    structural_strictness: "CLOSED_OBJECT" as const,
    json_schema_sha256: "0".repeat(64),
    compatibility,
    ...(supersedesSchemaId === undefined
      ? {}
      : { supersedes_schema_id: supersedesSchemaId }),
    note: "synthetic compatibility fixture",
  };
}

describe("ER-01 public contract compatibility registry", () => {
  it("matches the exact schema index and every canonical digest", async () => {
    const expected = await buildExpectedIndex();
    const expectedText = `${serializeCanonicalContractJson(expected, true)}\n`;

    expect(schemaIndexRaw).toBe(expectedText);
    expect(
      ContractSchemaIndexDocumentSchema.parse(parseJson(schemaIndexRaw)),
    ).toEqual(expected);
  });

  it("requires the current index to equal every active terminal history entry", async () => {
    const index = await buildExpectedIndex();
    const compatibility = ContractCompatibilityRegistrySchema.parse(
      parseJson(compatibilityRegistryRaw),
    );

    expect(compatibility.registry_generation).toBe(
      CONTRACT_SCHEMA_REGISTRY_GENERATION,
    );
    expect(() =>
      assertCurrentContractCompatibility(index.entries, compatibility),
    ).not.toThrow();
    for (const current of index.entries) {
      const matches = compatibility.entries.filter(
        (entry) =>
          entry.export_name === current.export_name &&
          entry.schema_version === current.schema_version &&
          entry.schema_generation === current.schema_generation,
      );
      expect(matches).toHaveLength(1);
      const [match] = matches;
      if (match === undefined) throw new Error("missing compatibility entry");
      expect(match.compatibility).not.toBe("RETIRED");
      expect(exactIndexFields(match)).toEqual(exactIndexFields(current));
    }
  });

  it("rejects malformed identity and compatibility histories", () => {
    const initial = compatibilityEntry(
      "SyntheticSchema",
      "common",
      1,
      1,
      "INITIAL",
    );
    const backward = compatibilityEntry(
      "SyntheticSchema",
      "common",
      1,
      2,
      "BACKWARD_COMPATIBLE",
      initial.schema_id,
    );
    const validHistory = ContractCompatibilityRegistrySchema.parse({
      protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
      registry_generation: 2,
      entries: [initial, backward],
    });

    expect(() =>
      assertCurrentContractCompatibility(
        [exactIndexFields(backward)],
        validHistory,
      ),
    ).not.toThrow();
    expect(() =>
      assertCurrentContractCompatibility(
        [exactIndexFields(initial)],
        validHistory,
      ),
    ).toThrow("terminal history");
    expect(() =>
      assertCurrentContractCompatibility([], validHistory),
    ).toThrow("missing from the current index");

    expect(
      ContractSchemaIndexEntrySchema.safeParse({
        schema_id: buildContractSchemaId("source", "OtherSchema", 1, 1),
        export_name: initial.export_name,
        family: initial.family,
        schema_version: initial.schema_version,
        schema_generation: initial.schema_generation,
        kind: initial.kind,
        structural_strictness: initial.structural_strictness,
        json_schema_sha256: initial.json_schema_sha256,
      }).success,
    ).toBe(false);
    expect(
      ContractSchemaIndexEntrySchema.safeParse({
        ...exactIndexFields(initial),
        schema_generation: CONTRACT_SCHEMA_MAX_ORDINAL + 1,
      }).success,
    ).toBe(false);
    expect(() =>
      buildContractSchemaId(
        "common",
        "SyntheticSchema",
        1,
        CONTRACT_SCHEMA_MAX_ORDINAL + 1,
      ),
    ).toThrow();

    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 2,
        entries: [backward],
      }).success,
    ).toBe(false);

    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 3,
        entries: [
          initial,
          backward,
          compatibilityEntry(
            "SyntheticSchema",
            "common",
            1,
            3,
            "BACKWARD_COMPATIBLE",
            initial.schema_id,
          ),
        ],
      }).success,
    ).toBe(false);

    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 2,
        entries: [
          initial,
          { ...backward, supersedes_schema_id: backward.schema_id },
        ],
      }).success,
    ).toBe(false);

    const otherInitial = compatibilityEntry(
      "OtherSchema",
      "source",
      1,
      1,
      "INITIAL",
    );
    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 2,
        entries: [
          otherInitial,
          { ...backward, supersedes_schema_id: otherInitial.schema_id },
        ],
      }).success,
    ).toBe(false);

    const newerInitial = compatibilityEntry(
      "SyntheticSchema",
      "common",
      1,
      2,
      "INITIAL",
    );
    const olderBackward = compatibilityEntry(
      "SyntheticSchema",
      "common",
      1,
      1,
      "BACKWARD_COMPATIBLE",
      newerInitial.schema_id,
    );
    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 2,
        entries: [newerInitial, olderBackward],
      }).success,
    ).toBe(false);

    const versionTwo = compatibilityEntry(
      "SyntheticSchema",
      "common",
      2,
      1,
      "INITIAL",
    );
    const lowerBreaking = compatibilityEntry(
      "SyntheticSchema",
      "common",
      1,
      3,
      "BREAKING",
      versionTwo.schema_id,
    );
    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 3,
        entries: [versionTwo, lowerBreaking],
      }).success,
    ).toBe(false);

    const retired = compatibilityEntry(
      "SyntheticSchema",
      "common",
      1,
      2,
      "RETIRED",
      initial.schema_id,
    );
    const retiredHistory = ContractCompatibilityRegistrySchema.parse({
      protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
      registry_generation: 2,
      entries: [initial, retired],
    });
    expect(() =>
      assertCurrentContractCompatibility([], retiredHistory),
    ).not.toThrow();
    expect(() =>
      assertCurrentContractCompatibility(
        [exactIndexFields(retired)],
        retiredHistory,
      ),
    ).toThrow("retired");
  });

});
