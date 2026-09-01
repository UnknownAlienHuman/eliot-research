import * as z from "zod";

import * as backup from "./backup.js";
import * as common from "./common.js";
import * as driveExchange from "./drive-exchange.js";
import * as erasure from "./erasure.js";
import * as evidence from "./evidence.js";
import * as federation from "./federation.js";
import * as library from "./library.js";
import * as model from "./model.js";
import * as navigation from "./navigation.js";
import * as normalizedBundle from "./normalized-bundle.js";
import * as operations from "./operations.js";
import * as ownerCutover from "./owner-cutover.js";
import * as policy from "./policy.js";
import * as publication from "./publication.js";
import * as registryContracts from "./registry-contracts.js";
import * as research from "./research.js";
import * as residency from "./residency.js";
import * as retrieval from "./retrieval.js";
import * as scope from "./scope.js";
import * as security from "./security.js";
import * as source from "./source.js";
import {
  CONTRACT_JSON_SCHEMA_DIALECT,
  CONTRACT_SCHEMA_CORPUS_PROTOCOL,
  ContractSchemaCorpusDocumentSchema,
  type ContractSchemaFamily,
  type ContractSchemaKind,
  type ContractStructuralStrictness,
} from "./registry-contracts.js";

export const CONTRACT_SCHEMA_REGISTRY_GENERATION = 1 as const;

export type ContractJsonPrimitive = string | number | boolean | null;
export type ContractJsonValue =
  | ContractJsonPrimitive
  | ContractJsonValue[]
  | { [key: string]: ContractJsonValue };
export type ContractJsonObject = { [key: string]: ContractJsonValue };

export interface ContractSchemaDescriptor {
  readonly schema_id: string;
  readonly export_name: string;
  readonly family: ContractSchemaFamily;
  readonly schema_version: number;
  readonly schema_generation: number;
  readonly kind: ContractSchemaKind;
  readonly structural_strictness: ContractStructuralStrictness;
  readonly schema: z.ZodType;
}

interface SchemaModule {
  readonly family: ContractSchemaFamily;
  readonly exports: Readonly<Record<string, unknown>>;
}

const SCHEMA_MODULES: readonly SchemaModule[] = [
  { family: "backup", exports: backup },
  { family: "common", exports: common },
  { family: "drive-exchange", exports: driveExchange },
  { family: "erasure", exports: erasure },
  { family: "evidence", exports: evidence },
  { family: "federation", exports: federation },
  { family: "library", exports: library },
  { family: "model", exports: model },
  { family: "navigation", exports: navigation },
  { family: "normalized-bundle", exports: normalizedBundle },
  { family: "operations", exports: operations },
  { family: "owner-cutover", exports: ownerCutover },
  { family: "policy", exports: policy },
  { family: "publication", exports: publication },
  { family: "registry", exports: registryContracts },
  { family: "research", exports: research },
  { family: "residency", exports: residency },
  { family: "retrieval", exports: retrieval },
  { family: "scope", exports: scope },
  { family: "security", exports: security },
  { family: "source", exports: source },
];

const FAMILY_VERSIONS: Readonly<
  Record<
    ContractSchemaFamily,
    { readonly schema_version: number; readonly schema_generation: number }
  >
> = Object.freeze({
  backup: { schema_version: 1, schema_generation: 1 },
  common: { schema_version: 1, schema_generation: 1 },
  "drive-exchange": { schema_version: 1, schema_generation: 1 },
  erasure: { schema_version: 1, schema_generation: 1 },
  evidence: { schema_version: 1, schema_generation: 1 },
  federation: { schema_version: 1, schema_generation: 1 },
  library: { schema_version: 1, schema_generation: 1 },
  model: { schema_version: 1, schema_generation: 1 },
  navigation: { schema_version: 1, schema_generation: 1 },
  "normalized-bundle": { schema_version: 1, schema_generation: 1 },
  operations: { schema_version: 1, schema_generation: 1 },
  "owner-cutover": { schema_version: 1, schema_generation: 1 },
  policy: { schema_version: 1, schema_generation: 1 },
  publication: { schema_version: 1, schema_generation: 1 },
  registry: { schema_version: 1, schema_generation: 1 },
  research: { schema_version: 1, schema_generation: 1 },
  residency: { schema_version: 1, schema_generation: 1 },
  retrieval: { schema_version: 1, schema_generation: 1 },
  scope: { schema_version: 1, schema_generation: 1 },
  security: { schema_version: 1, schema_generation: 1 },
  source: { schema_version: 1, schema_generation: 1 },
});

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function schemaSlug(exportName: string): string {
  return exportName
    .replace(/Schema$/u, "")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
}

function canonicalizeJson(value: unknown): ContractJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("contract JSON cannot contain a non-finite number");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "contract JSON objects must have a plain or null prototype",
      );
    }

    const output: ContractJsonObject = {};
    for (const [key, child] of Object.entries(value).sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      if (child !== undefined) output[key] = canonicalizeJson(child);
    }
    return output;
  }

  throw new TypeError(`contract JSON contains unsupported ${typeof value}`);
}

function asJsonObject(value: unknown): ContractJsonObject {
  const canonical = canonicalizeJson(value);
  if (
    canonical === null ||
    Array.isArray(canonical) ||
    typeof canonical !== "object"
  ) {
    throw new TypeError("contract JSON Schema root must be an object");
  }
  return canonical;
}

function hasJsonType(
  document: ContractJsonObject,
  expected: string,
): boolean {
  const value = document.type;
  return value === expected || (Array.isArray(value) && value.includes(expected));
}

function classifyKind(document: ContractJsonObject): ContractSchemaKind {
  if (Array.isArray(document.enum)) return "ENUM";
  if (Array.isArray(document.anyOf) || Array.isArray(document.oneOf)) {
    return "UNION";
  }
  if (hasJsonType(document, "object")) return "OBJECT";
  if (
    hasJsonType(document, "string") ||
    hasJsonType(document, "integer") ||
    hasJsonType(document, "number") ||
    hasJsonType(document, "boolean")
  ) {
    return "SCALAR";
  }
  return "OTHER";
}

function classifyStrictness(
  document: ContractJsonObject,
): ContractStructuralStrictness {
  if (!hasJsonType(document, "object")) return "NON_OBJECT";
  if (document.properties !== undefined) {
    return document.additionalProperties === false
      ? "CLOSED_OBJECT"
      : "EXPLICIT_MAP";
  }
  return "EXPLICIT_MAP";
}

function buildJsonSchema(
  descriptor: Pick<
    ContractSchemaDescriptor,
    | "schema_id"
    | "export_name"
    | "family"
    | "schema_version"
    | "schema_generation"
    | "schema"
  >,
): ContractJsonObject {
  const generated = z.toJSONSchema(descriptor.schema, {
    cycles: "ref",
    io: "input",
    reused: "ref",
    unrepresentable: "any",
  });

  return asJsonObject({
    ...generated,
    $id: descriptor.schema_id,
    $schema: CONTRACT_JSON_SCHEMA_DIALECT,
    title: descriptor.export_name.replace(/Schema$/u, ""),
    "x-eliotr-family": descriptor.family,
    "x-eliotr-schema-generation": descriptor.schema_generation,
    "x-eliotr-schema-version": descriptor.schema_version,
    "x-eliotr-semantic-authority": "zod-runtime",
  });
}

function buildRegistry(): readonly ContractSchemaDescriptor[] {
  const descriptors: ContractSchemaDescriptor[] = [];
  const exportNames = new Set<string>();
  const schemaIds = new Set<string>();

  for (const module of SCHEMA_MODULES) {
    const version = FAMILY_VERSIONS[module.family];
    for (const [exportName, candidate] of Object.entries(module.exports).sort(
      ([left], [right]) => compareCodeUnits(left, right),
    )) {
      if (!(candidate instanceof z.ZodType)) continue;
      if (!exportName.endsWith("Schema")) {
        throw new Error(
          `exported Zod value ${module.family}.${exportName} must end with Schema`,
        );
      }
      if (exportNames.has(exportName)) {
        throw new Error(`duplicate public contract schema export ${exportName}`);
      }

      const schemaId = `urn:eliotr:contracts:${module.family}:${schemaSlug(exportName)}:v${version.schema_version}:g${version.schema_generation}`;
      if (schemaIds.has(schemaId)) {
        throw new Error(`duplicate public contract schema ID ${schemaId}`);
      }

      const core = {
        schema_id: schemaId,
        export_name: exportName,
        family: module.family,
        schema_version: version.schema_version,
        schema_generation: version.schema_generation,
        schema: candidate,
      } as const;
      const document = buildJsonSchema(core);
      descriptors.push(
        Object.freeze({
          ...core,
          kind: classifyKind(document),
          structural_strictness: classifyStrictness(document),
        }),
      );
      exportNames.add(exportName);
      schemaIds.add(schemaId);
    }
  }

  return Object.freeze(
    descriptors.sort((left, right) =>
      compareCodeUnits(left.export_name, right.export_name),
    ),
  );
}

export const CONTRACT_SCHEMA_REGISTRY = buildRegistry();

const SCHEMAS_BY_EXPORT_NAME = new Map(
  CONTRACT_SCHEMA_REGISTRY.map((descriptor) => [
    descriptor.export_name,
    descriptor,
  ]),
);

export function getContractSchemaDescriptor(
  exportName: string,
): ContractSchemaDescriptor | undefined {
  return SCHEMAS_BY_EXPORT_NAME.get(exportName);
}

export function requireContractSchemaDescriptor(
  exportName: string,
): ContractSchemaDescriptor {
  const descriptor = getContractSchemaDescriptor(exportName);
  if (descriptor === undefined) {
    throw new RangeError(`unknown public contract schema ${exportName}`);
  }
  return descriptor;
}

export function generateContractJsonSchema(
  descriptor: ContractSchemaDescriptor,
): ContractJsonObject {
  return buildJsonSchema(descriptor);
}

export function generateContractSchemaCorpus() {
  const document = {
    protocol: CONTRACT_SCHEMA_CORPUS_PROTOCOL,
    registry_generation: CONTRACT_SCHEMA_REGISTRY_GENERATION,
    json_schema_dialect: CONTRACT_JSON_SCHEMA_DIALECT,
    schema_count: CONTRACT_SCHEMA_REGISTRY.length,
    schemas: CONTRACT_SCHEMA_REGISTRY.map((descriptor) => ({
      schema_id: descriptor.schema_id,
      export_name: descriptor.export_name,
      family: descriptor.family,
      schema_version: descriptor.schema_version,
      schema_generation: descriptor.schema_generation,
      kind: descriptor.kind,
      structural_strictness: descriptor.structural_strictness,
      json_schema: generateContractJsonSchema(descriptor),
    })),
  };
  return ContractSchemaCorpusDocumentSchema.parse(document);
}

export function serializeCanonicalContractJson(
  value: unknown,
  pretty = false,
): string {
  return JSON.stringify(canonicalizeJson(value), null, pretty ? 2 : undefined);
}
