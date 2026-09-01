import { z } from "zod";
import {
  IdentifierSchema,
  PositiveIntegerSchema,
  Sha256Schema,
} from "./common.js";

export const CONTRACT_SCHEMA_CORPUS_PROTOCOL =
  "eliotr.contract-schema-corpus.v1" as const;
export const CONTRACT_SCHEMA_INDEX_PROTOCOL =
  "eliotr.contract-schema-index.v1" as const;
export const CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL =
  "eliotr.contract-compatibility-registry.v1" as const;
export const CANONICAL_FIXTURE_REGISTRY_PROTOCOL =
  "eliotr.contract-canonical-fixtures.v1" as const;
export const CONTRACT_JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;

export const CONTRACT_SCHEMA_FAMILIES = [
  "backup",
  "common",
  "drive-exchange",
  "erasure",
  "evidence",
  "federation",
  "library",
  "model",
  "navigation",
  "normalized-bundle",
  "operations",
  "owner-cutover",
  "policy",
  "publication",
  "registry",
  "research",
  "residency",
  "retrieval",
  "scope",
  "security",
  "source",
] as const;

export const ContractSchemaFamilySchema = z.enum(CONTRACT_SCHEMA_FAMILIES);
export type ContractSchemaFamily = z.infer<typeof ContractSchemaFamilySchema>;

export const ContractSchemaIdSchema = z
  .string()
  .max(256)
  .regex(
    /^urn:eliotr:contracts:[a-z0-9-]+:[a-z0-9-]+:v[1-9][0-9]*:g[1-9][0-9]*$/u,
  );
export type ContractSchemaId = z.infer<typeof ContractSchemaIdSchema>;

export const ContractSchemaExportNameSchema = z
  .string()
  .max(256)
  .regex(/^[A-Z][A-Za-z0-9]*Schema$/u);

export const ContractSchemaKindSchema = z.enum([
  "SCALAR",
  "ENUM",
  "OBJECT",
  "UNION",
  "OTHER",
]);
export type ContractSchemaKind = z.infer<typeof ContractSchemaKindSchema>;

export const ContractStructuralStrictnessSchema = z.enum([
  "CLOSED_OBJECT",
  "EXPLICIT_MAP",
  "NON_OBJECT",
]);
export type ContractStructuralStrictness = z.infer<
  typeof ContractStructuralStrictnessSchema
>;

export const ContractSchemaIdentitySchema = z
  .object({
    schema_id: ContractSchemaIdSchema,
    export_name: ContractSchemaExportNameSchema,
    family: ContractSchemaFamilySchema,
    schema_version: PositiveIntegerSchema,
    schema_generation: PositiveIntegerSchema,
  })
  .strict();
export type ContractSchemaIdentity = z.infer<
  typeof ContractSchemaIdentitySchema
>;

export const ContractSchemaCorpusEntrySchema = z
  .object({
    schema_id: ContractSchemaIdSchema,
    export_name: ContractSchemaExportNameSchema,
    family: ContractSchemaFamilySchema,
    schema_version: PositiveIntegerSchema,
    schema_generation: PositiveIntegerSchema,
    kind: ContractSchemaKindSchema,
    structural_strictness: ContractStructuralStrictnessSchema,
    json_schema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ContractSchemaCorpusDocumentSchema = z
  .object({
    protocol: z.literal(CONTRACT_SCHEMA_CORPUS_PROTOCOL),
    registry_generation: PositiveIntegerSchema,
    json_schema_dialect: z.literal(CONTRACT_JSON_SCHEMA_DIALECT),
    schema_count: PositiveIntegerSchema,
    schemas: z.array(ContractSchemaCorpusEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.schema_count !== value.schemas.length) {
      context.addIssue({
        code: "custom",
        path: ["schema_count"],
        message: "schema_count must equal schemas.length",
      });
    }

    const schemaIds = new Set<string>();
    const exportNames = new Set<string>();
    for (const [index, entry] of value.schemas.entries()) {
      if (schemaIds.has(entry.schema_id)) {
        context.addIssue({
          code: "custom",
          path: ["schemas", index, "schema_id"],
          message: "duplicate schema_id",
        });
      }
      schemaIds.add(entry.schema_id);

      if (exportNames.has(entry.export_name)) {
        context.addIssue({
          code: "custom",
          path: ["schemas", index, "export_name"],
          message: "duplicate export_name",
        });
      }
      exportNames.add(entry.export_name);
    }
  });
export type ContractSchemaCorpusDocument = z.infer<
  typeof ContractSchemaCorpusDocumentSchema
>;

export const ContractSchemaIndexEntrySchema = z
  .object({
    schema_id: ContractSchemaIdSchema,
    export_name: ContractSchemaExportNameSchema,
    family: ContractSchemaFamilySchema,
    schema_version: PositiveIntegerSchema,
    schema_generation: PositiveIntegerSchema,
    kind: ContractSchemaKindSchema,
    structural_strictness: ContractStructuralStrictnessSchema,
    json_schema_sha256: Sha256Schema,
  })
  .strict();
export type ContractSchemaIndexEntry = z.infer<
  typeof ContractSchemaIndexEntrySchema
>;

export const ContractSchemaIndexDocumentSchema = z
  .object({
    protocol: z.literal(CONTRACT_SCHEMA_INDEX_PROTOCOL),
    registry_generation: PositiveIntegerSchema,
    json_schema_dialect: z.literal(CONTRACT_JSON_SCHEMA_DIALECT),
    schema_count: PositiveIntegerSchema,
    entries: z.array(ContractSchemaIndexEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.schema_count !== value.entries.length) {
      context.addIssue({
        code: "custom",
        path: ["schema_count"],
        message: "schema_count must equal entries.length",
      });
    }

    const schemaIds = new Set<string>();
    const exportNames = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      if (schemaIds.has(entry.schema_id)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "schema_id"],
          message: "duplicate schema_id",
        });
      }
      schemaIds.add(entry.schema_id);

      if (exportNames.has(entry.export_name)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "export_name"],
          message: "duplicate export_name in current generation",
        });
      }
      exportNames.add(entry.export_name);
    }
  });
export type ContractSchemaIndexDocument = z.infer<
  typeof ContractSchemaIndexDocumentSchema
>;

export const ContractCompatibilityClassSchema = z.enum([
  "INITIAL",
  "BACKWARD_COMPATIBLE",
  "BREAKING",
  "RETIRED",
]);
export type ContractCompatibilityClass = z.infer<
  typeof ContractCompatibilityClassSchema
>;

export const ContractCompatibilityEntrySchema = z
  .object({
    schema_id: ContractSchemaIdSchema,
    export_name: ContractSchemaExportNameSchema,
    family: ContractSchemaFamilySchema,
    schema_version: PositiveIntegerSchema,
    schema_generation: PositiveIntegerSchema,
    kind: ContractSchemaKindSchema,
    structural_strictness: ContractStructuralStrictnessSchema,
    json_schema_sha256: Sha256Schema,
    compatibility: ContractCompatibilityClassSchema,
    supersedes_schema_id: ContractSchemaIdSchema.optional(),
    note: z.string().min(1).max(1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.compatibility === "INITIAL" &&
      value.supersedes_schema_id !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["supersedes_schema_id"],
        message: "INITIAL entries cannot supersede another schema",
      });
    }
    if (
      value.compatibility !== "INITIAL" &&
      value.supersedes_schema_id === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["supersedes_schema_id"],
        message: "non-initial entries must identify the superseded schema",
      });
    }
  });
export type ContractCompatibilityEntry = z.infer<
  typeof ContractCompatibilityEntrySchema
>;

export const ContractCompatibilityRegistrySchema = z
  .object({
    protocol: z.literal(CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL),
    registry_generation: PositiveIntegerSchema,
    entries: z.array(ContractCompatibilityEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const schemaIds = new Set<string>();
    const generationKeys = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      if (schemaIds.has(entry.schema_id)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "schema_id"],
          message: "duplicate compatibility schema_id",
        });
      }
      schemaIds.add(entry.schema_id);

      const generationKey = `${entry.export_name}:${entry.schema_version}:${entry.schema_generation}`;
      if (generationKeys.has(generationKey)) {
        context.addIssue({
          code: "custom",
          path: ["entries", index],
          message: "duplicate export/version/generation compatibility entry",
        });
      }
      generationKeys.add(generationKey);
    }
  });
export type ContractCompatibilityRegistry = z.infer<
  typeof ContractCompatibilityRegistrySchema
>;

export const CanonicalFixtureDescriptorSchema = z
  .object({
    fixture_id: IdentifierSchema,
    protocol: IdentifierSchema,
    schema_export: ContractSchemaExportNameSchema,
    fixture_path: z.string().min(1).max(512),
    media_type: z.enum(["application/json", "application/yaml", "text/plain"]),
    canonical_body_sha256: Sha256Schema,
  })
  .strict();
export type CanonicalFixtureDescriptor = z.infer<
  typeof CanonicalFixtureDescriptorSchema
>;

export const CanonicalFixtureRegistryDocumentSchema = z
  .object({
    protocol: z.literal(CANONICAL_FIXTURE_REGISTRY_PROTOCOL),
    registry_generation: PositiveIntegerSchema,
    fixtures: z.array(CanonicalFixtureDescriptorSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const fixtureIds = new Set<string>();
    const fixturePaths = new Set<string>();
    for (const [index, fixture] of value.fixtures.entries()) {
      if (fixtureIds.has(fixture.fixture_id)) {
        context.addIssue({
          code: "custom",
          path: ["fixtures", index, "fixture_id"],
          message: "duplicate fixture_id",
        });
      }
      fixtureIds.add(fixture.fixture_id);

      if (fixturePaths.has(fixture.fixture_path)) {
        context.addIssue({
          code: "custom",
          path: ["fixtures", index, "fixture_path"],
          message: "duplicate fixture_path",
        });
      }
      fixturePaths.add(fixture.fixture_path);
    }
  });
export type CanonicalFixtureRegistryDocument = z.infer<
  typeof CanonicalFixtureRegistryDocumentSchema
>;
