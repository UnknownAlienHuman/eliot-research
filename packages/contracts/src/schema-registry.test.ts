import { describe, expect, it } from "vitest";
import * as z from "zod";

import canonicalFixturesRaw from "../../../docs/contracts/canonical-fixtures.v1.json?raw";
import compatibilityRegistryRaw from "../../../docs/contracts/compatibility-registry.v1.json?raw";
import schemaCorpusRaw from "../../../docs/contracts/schema-corpus.v1.json?raw";
import schemaIndexRaw from "../../../docs/contracts/schema-index.v1.json?raw";
import * as publicContracts from "./index.js";
import {
  CompletionDispositionSchema,
  EvidenceContextBlockSchema,
  FederationJobStatusSchema,
  SourceOwnerCutoverReceiptSchema,
} from "./index.js";
import * as registryContracts from "./registry-index.js";
import {
  CANONICAL_FIXTURE_REGISTRY,
  CANONICAL_FIXTURE_REGISTRY_PROTOCOL,
  CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
  CONTRACT_JSON_SCHEMA_DIALECT,
  CONTRACT_SCHEMA_INDEX_PROTOCOL,
  CONTRACT_SCHEMA_REGISTRY,
  CONTRACT_SCHEMA_REGISTRY_GENERATION,
  CanonicalFixtureDescriptorSchema,
  ContractCompatibilityRegistrySchema,
  ContractSchemaCorpusDocumentSchema,
  ContractSchemaIndexDocumentSchema,
  ContractSchemaIndexEntrySchema,
  buildContractSchemaId,
  generateContractSchemaCorpus,
  getContractSchemaDescriptor,
  requireContractSchemaDescriptor,
  serializeCanonicalContractJson,
} from "./registry-index.js";

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasObjectJsonType(value: unknown): boolean {
  return value === "object" || (Array.isArray(value) && value.includes("object"));
}

function assertClosedDeclaredObjects(value: unknown, path = "$root"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertClosedDeclaredObjects(item, `${path}[${index}]`);
    }
    return;
  }
  if (!isObject(value)) return;

  if (
    hasObjectJsonType(value.type) &&
    Object.hasOwn(value, "properties") &&
    value.additionalProperties !== false
  ) {
    throw new Error(
      `${path} is a declared object without additionalProperties:false`,
    );
  }

  for (const [key, child] of Object.entries(value)) {
    assertClosedDeclaredObjects(child, `${path}.${key}`);
  }
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    serializeCanonicalContractJson(value),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function buildExpectedIndex() {
  const corpus = generateContractSchemaCorpus();
  const entries = [];
  for (const entry of corpus.schemas) {
    const { json_schema: jsonSchema, ...identity } = entry;
    entries.push({
      ...identity,
      json_schema_sha256: await sha256(jsonSchema),
    });
  }

  return ContractSchemaIndexDocumentSchema.parse({
    protocol: CONTRACT_SCHEMA_INDEX_PROTOCOL,
    registry_generation: CONTRACT_SCHEMA_REGISTRY_GENERATION,
    json_schema_dialect: CONTRACT_JSON_SCHEMA_DIALECT,
    schema_count: entries.length,
    entries,
  });
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

describe("ER-01 public contract registry", () => {
  it("covers every and only public Zod schema while isolating tooling", () => {
    const publicSchemaExports = [
      ...Object.entries(publicContracts),
      ...Object.entries(registryContracts),
    ]
      .filter(([_name, value]) => value instanceof z.ZodType)
      .map(([name]) => name)
      .sort(compareCodeUnits);
    const registeredExports = CONTRACT_SCHEMA_REGISTRY.map(
      (descriptor) => descriptor.export_name,
    );

    expect(registeredExports).toEqual(publicSchemaExports);
    expect(new Set(registeredExports).size).toBe(registeredExports.length);
    expect(
      new Set(
        CONTRACT_SCHEMA_REGISTRY.map((descriptor) => descriptor.schema_id),
      ).size,
    ).toBe(CONTRACT_SCHEMA_REGISTRY.length);

    expect("CONTRACT_SCHEMA_REGISTRY" in publicContracts).toBe(false);
    expect("generateContractSchemaCorpus" in publicContracts).toBe(false);
    expect("CONTRACT_SCHEMA_REGISTRY" in registryContracts).toBe(true);

    for (const descriptor of CONTRACT_SCHEMA_REGISTRY) {
      expect(getContractSchemaDescriptor(descriptor.export_name)).toBe(
        descriptor,
      );
      expect(requireContractSchemaDescriptor(descriptor.export_name)).toBe(
        descriptor,
      );
    }
    expect(getContractSchemaDescriptor("UnknownSchema")).toBeUndefined();
    expect(() => requireContractSchemaDescriptor("UnknownSchema")).toThrow(
      "unknown public contract schema",
    );
  });

  it("matches the exact generated corpus and closes every declared object", () => {
    const generated = generateContractSchemaCorpus();
    const expectedText = `${serializeCanonicalContractJson(generated, true)}\n`;

    expect(schemaCorpusRaw).toBe(expectedText);
    expect(
      ContractSchemaCorpusDocumentSchema.parse(parseJson(schemaCorpusRaw)),
    ).toEqual(generated);
    for (const entry of generated.schemas) {
      assertClosedDeclaredObjects(entry.json_schema, entry.export_name);
    }
  });

  it("matches the exact schema index and every canonical digest", async () => {
    const expected = await buildExpectedIndex();
    const expectedText = `${serializeCanonicalContractJson(expected, true)}\n`;

    expect(schemaIndexRaw).toBe(expectedText);
    expect(
      ContractSchemaIndexDocumentSchema.parse(parseJson(schemaIndexRaw)),
    ).toEqual(expected);
  });

  it("requires one non-retired compatibility entry for every current schema", async () => {
    const index = await buildExpectedIndex();
    const compatibility = ContractCompatibilityRegistrySchema.parse(
      parseJson(compatibilityRegistryRaw),
    );

    expect(compatibility.registry_generation).toBe(
      CONTRACT_SCHEMA_REGISTRY_GENERATION,
    );
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
    expect(
      ContractCompatibilityRegistrySchema.safeParse({
        protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
        registry_generation: 2,
        entries: [initial, backward],
      }).success,
    ).toBe(true);

    expect(
      ContractSchemaIndexEntrySchema.safeParse({
        ...initial,
        schema_id: buildContractSchemaId("source", "OtherSchema", 1, 1),
      }).success,
    ).toBe(false);

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
  });

  it("matches canonical fixture metadata and rejects path traversal", () => {
    const expectedText = `${serializeCanonicalContractJson(
      CANONICAL_FIXTURE_REGISTRY,
      true,
    )}\n`;
    expect(canonicalFixturesRaw).toBe(expectedText);

    for (const fixture of CANONICAL_FIXTURE_REGISTRY.fixtures) {
      expect(getContractSchemaDescriptor(fixture.schema_export)).toBeDefined();
      expect(fixture.canonical_body_sha256).toMatch(/^[a-f0-9]{64}$/u);
    }

    expect(
      CanonicalFixtureDescriptorSchema.safeParse({
        fixture_id: "bad-path",
        protocol: CANONICAL_FIXTURE_REGISTRY_PROTOCOL,
        schema_export: "ContractSchemaIdentitySchema",
        fixture_path: "docs/contracts/../secret.json",
        media_type: "application/json",
        canonical_body_sha256: "0".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("serializes deterministic plain JSON and rejects hidden runtime state", () => {
    expect(
      serializeCanonicalContractJson({ z: 1, A: 2, a: 3, omitted: undefined }),
    ).toBe('{"A":2,"a":3,"z":1}');
    expect(() => serializeCanonicalContractJson(Number.NaN)).toThrow(
      "non-finite number",
    );
    expect(() => serializeCanonicalContractJson(Number.POSITIVE_INFINITY)).toThrow(
      "non-finite number",
    );
    expect(() => serializeCanonicalContractJson(new Date(0))).toThrow(
      "plain or null prototype",
    );
  });

  it("rejects a tenth disposition and unknown security authority", () => {
    expect(CompletionDispositionSchema.options).toHaveLength(9);
    expect(CompletionDispositionSchema.safeParse("COMPLETED").success).toBe(
      false,
    );

    const result = EvidenceContextBlockSchema.safeParse({
      evidence_handle_ref: { id: "evidence", revision: 1 },
      source_revision_ref: "source-revision",
      instruction_taint: "UNTRUSTED",
      allowed_effects: "NO_EXTERNAL_EFFECT",
      quoted_content: "untrusted source text",
      excerpt_sha256: "0".repeat(64),
      security_override: "ALLOW_EXTERNAL_EFFECT",
    });
    expect(result.success).toBe(false);
  });

  it("round-trips a strict cutover receipt and keeps transport separate from research", () => {
    const receipt = SourceOwnerCutoverReceiptSchema.parse({
      protocol: "source.owner-cutover.v1",
      cutover: {
        cutover_id: "cutover-1",
        source_namespace_id: "namespace-1",
        identity_mapping_digest: "1".repeat(64),
        prepared_at: "2026-09-01T12:00:00.000Z",
        effective_at: "2026-09-01T12:05:00.000Z",
      },
      old_owner: {
        owner_system_id: "old-owner",
        source_owner_generation_before_fence: "generation-1",
        fence_revision: "fence-1",
        final_source_view_ref: "view-1",
        final_revision_set_digest: "2".repeat(64),
        terminal_status: "FENCED",
      },
      new_owner: {
        owner_system_id: "new-owner",
        source_owner_generation_after_activation: "generation-2",
        activation_revision: "activation-1",
        admitted_revision_set_digest: "2".repeat(64),
        status: "ACTIVE",
      },
      validation: {
        compatibility_receipt_refs: ["compatibility-1"],
        integrity_receipt_refs: ["integrity-1"],
        unresolved_sources_and_reasons: [],
      },
      authorization: {
        old_owner_authorization_ref: "old-auth",
        new_owner_authorization_ref: "new-auth",
        issued_at: "2026-09-01T12:04:00.000Z",
      },
    });
    expect(
      SourceOwnerCutoverReceiptSchema.parse(
        JSON.parse(JSON.stringify(receipt)) as unknown,
      ),
    ).toEqual(receipt);

    const status = FederationJobStatusSchema.parse({
      exchange_id: "exchange-1",
      idempotency_key: "idempotency-1",
      job_id: "job-1",
      attempt: 1,
      transport_state: "COMPLETED",
      completion_disposition: "INCONCLUSIVE",
      completed_obligation_refs: [],
      partial_bundle_refs: [],
      open_research_debt_refs: [],
    });
    expect(status.transport_state).toBe("COMPLETED");
    expect(status.completion_disposition).toBe("INCONCLUSIVE");
    expect(
      FederationJobStatusSchema.safeParse({
        ...status,
        completion_disposition: "COMPLETED",
      }).success,
    ).toBe(false);
  });
});
