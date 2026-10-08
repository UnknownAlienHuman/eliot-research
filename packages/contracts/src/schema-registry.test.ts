import { describe, expect, it } from "vitest";
import * as z from "zod";

import canonicalFixturesRaw from "../../../docs/contracts/canonical-fixtures.v1.json?raw";
import diagnosticConfirmedFixtureRaw from "../../../docs/contracts/fixtures/eliotr.mcp-client-diagnostic.confirmed.v1.json?raw";
import diagnosticIssuedFixtureRaw from "../../../docs/contracts/fixtures/eliotr.mcp-client-diagnostic.issued.v1.json?raw";
import schemaCorpusRaw from "../../../docs/contracts/schema-corpus.v1.json?raw";
import libraryReadinessFixtureRaw from "../../../tests/fixtures/contracts/eliotr.library-readiness.v1.json?raw";
import workspaceMcpFixtureRaw from "../../../tests/fixtures/contracts/eliotr.workspace-mcp-plan-input.v2.json?raw";
import * as computerAgentConnection from "./computer-agent-connection.js";
import * as computerAgentDispatch from "./computer-agent-dispatch.js";
import * as computerAgentQualification from "./computer-agent-qualification.js";
import * as computerAgentRoute from "./computer-agent-route.js";
import * as researchBranch from "./research-branch.js";
import * as researchProviderKey from "./research-provider-key.js";
import * as researchProviderKeyModelUse from "./research-provider-key-model-use.js";
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
  CONTRACT_SCHEMA_REGISTRY,
  CanonicalFixtureDescriptorSchema,
  ContractSchemaCorpusDocumentSchema,
  buildContractSchemaId,
  generateContractSchemaCorpus,
  getContractSchemaDescriptor,
  requireContractSchemaDescriptor,
  serializeCanonicalContractJson,
} from "./registry-index.js";
import { sha256 } from "./schema-registry-test-support.js";

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

    const additiveSchemaFamilies = [
      ["computer-agent", computerAgentConnection],
      ["computer-agent", computerAgentDispatch],
      ["computer-agent", computerAgentQualification],
      ["computer-agent", computerAgentRoute],
      ["research", researchBranch],
      ["research", researchProviderKey],
      ["research", researchProviderKeyModelUse],
    ] as const;
    for (const [family, schemaModule] of additiveSchemaFamilies) {
      for (const [exportName, candidate] of Object.entries(schemaModule)) {
        if (!(candidate instanceof z.ZodType)) continue;
        expect(requireContractSchemaDescriptor(exportName)).toMatchObject({
          family,
          schema_version: 1,
          schema_generation: 1,
          schema_id: buildContractSchemaId(family, exportName, 1, 1),
        });
      }
    }

    expect(
      registryContracts.ContractSchemaFamilySchema.safeParse("computer-agent")
        .success,
    ).toBe(true);
    for (const [exportName, candidate] of Object.entries(registryContracts)) {
      if (!(candidate instanceof z.ZodType) || !exportName.endsWith("Schema")) {
        continue;
      }
      expect(requireContractSchemaDescriptor(exportName)).toMatchObject({
        family: "registry",
        schema_version: 3,
        schema_generation: 1,
        schema_id: buildContractSchemaId("registry", exportName, 3, 1),
      });
    }
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

  it.each([
    ["library-readiness-v1", libraryReadinessFixtureRaw],
    ["workspace-mcp-plan-input-v2", workspaceMcpFixtureRaw],
    ["mcp-client-diagnostic-issued-v1", diagnosticIssuedFixtureRaw],
    ["mcp-client-diagnostic-confirmed-v1", diagnosticConfirmedFixtureRaw],
  ])("round-trips %s with its published canonical digest", async (fixtureId, raw) => {
    const fixture = CANONICAL_FIXTURE_REGISTRY.fixtures.find((item) => item.fixture_id === fixtureId);
    if (fixture === undefined) throw new Error(`Missing canonical fixture ${fixtureId}`);
    const value = parseJson(raw);
    const schema = requireContractSchemaDescriptor(fixture.schema_export).schema;
    expect(schema.parse(value)).toEqual(value);
    expect(schema.parse(parseJson(serializeCanonicalContractJson(value)))).toEqual(value);
    expect(await sha256(value)).toBe(fixture.canonical_body_sha256);
  });

  it("serializes deterministic plain JSON and rejects hidden runtime state", () => {
    expect(
      serializeCanonicalContractJson({ z: 1, A: 2, a: 3, omitted: undefined }),
    ).toBe('{"A":2,"a":3,"z":1}');

    const hostileKey = JSON.parse(
      '{"__proto__":{"polluted":true},"a":1}',
    ) as unknown;
    expect(serializeCanonicalContractJson(hostileKey)).toBe(
      '{"__proto__":{"polluted":true},"a":1}',
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeCanonicalContractJson(cyclic)).toThrow(
      "cyclic value",
    );
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
