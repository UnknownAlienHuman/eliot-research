from __future__ import annotations

import json
from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise SystemExit(f"{label}: expected one exact match, found {source.count(old)}")
    return source.replace(old, new, 1)


def patch_schema_registry() -> None:
    path = Path("packages/contracts/src/schema-registry.ts")
    source = path.read_text()

    comparator = '''function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

'''
    source = replace_once(
        source,
        "function schemaSlug(exportName: string): string {\n",
        comparator + "function schemaSlug(exportName: string): string {\n",
        "schema comparator insertion",
    )
    if source.count("left.localeCompare(right)") != 3:
        raise SystemExit("unexpected localeCompare count in schema registry")
    source = source.replace(
        "left.localeCompare(right)",
        "compareCodeUnits(left, right)",
    )

    source = replace_once(
        source,
        '''  if (typeof value === "object") {
    const output: ContractJsonObject = {};
''',
        '''  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("contract JSON objects must have a plain or null prototype");
    }

    const output: ContractJsonObject = {};
''',
        "plain-object guard",
    )

    start = source.index("function classifyKind(")
    end = source.index("function buildJsonSchema(")
    replacement = '''function hasJsonType(
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

'''
    source = source[:start] + replacement + source[end:]
    path.write_text(source)


def patch_compatibility_contract() -> None:
    path = Path("packages/contracts/src/registry-contracts.ts")
    source = path.read_text()

    start = source.index("export const ContractCompatibilityRegistrySchema =")
    end = source.index("export type ContractCompatibilityRegistry =")
    replacement = '''export const ContractCompatibilityRegistrySchema = z
  .object({
    protocol: z.literal(CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL),
    registry_generation: PositiveIntegerSchema,
    entries: z.array(ContractCompatibilityEntrySchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const schemaIds = new Set<string>();
    const generationKeys = new Set<string>();
    const entriesById = new Map(
      value.entries.map((entry) => [entry.schema_id, entry]),
    );

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

    for (const [index, entry] of value.entries.entries()) {
      const predecessorId = entry.supersedes_schema_id;
      if (predecessorId === undefined) continue;
      if (predecessorId === entry.schema_id) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "supersedes_schema_id"],
          message: "a compatibility entry cannot supersede itself",
        });
        continue;
      }

      const predecessor = entriesById.get(predecessorId);
      if (predecessor === undefined) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "supersedes_schema_id"],
          message: "superseded schema_id is absent from compatibility history",
        });
        continue;
      }
      if (
        predecessor.export_name !== entry.export_name ||
        predecessor.family !== entry.family
      ) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "supersedes_schema_id"],
          message: "a compatibility chain cannot cross export names or families",
        });
      }

      if (entry.compatibility === "BACKWARD_COMPATIBLE") {
        if (
          entry.schema_version !== predecessor.schema_version ||
          entry.schema_generation <= predecessor.schema_generation
        ) {
          context.addIssue({
            code: "custom",
            path: ["entries", index],
            message:
              "BACKWARD_COMPATIBLE requires the same version and a higher generation",
          });
        }
      } else if (entry.compatibility === "BREAKING") {
        if (entry.schema_version <= predecessor.schema_version) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "schema_version"],
            message: "BREAKING requires a higher schema version",
          });
        }
      } else if (entry.compatibility === "RETIRED") {
        if (
          entry.schema_version !== predecessor.schema_version ||
          entry.schema_generation <= predecessor.schema_generation
        ) {
          context.addIssue({
            code: "custom",
            path: ["entries", index],
            message: "RETIRED requires the same version and a higher generation",
          });
        }
      }
    }
  });
'''
    source = source[:start] + replacement + source[end:]

    source = replace_once(
        source,
        '    fixture_path: z.string().min(1).max(512),\n',
        '''    fixture_path: z
      .string()
      .min(1)
      .max(512)
      .regex(
        /^(?:tests\\/fixtures\\/contracts|docs\\/contracts)\\/[A-Za-z0-9._/-]+$/u,
      )
      .refine((value) => !value.split("/").includes(".."), {
        message: "fixture_path cannot traverse parent directories",
      }),
''',
        "canonical fixture path guard",
    )
    path.write_text(source)


def patch_exports() -> None:
    index_path = Path("packages/contracts/src/index.ts")
    index = index_path.read_text()
    for line in (
        'export * from "./registry-contracts.js";\n',
        'export * from "./schema-registry.js";\n',
        'export * from "./canonical-fixtures.js";\n',
    ):
        index = replace_once(index, line, "", f"main export removal {line.strip()}")
    index_path.write_text(index)

    Path("packages/contracts/src/registry-index.ts").write_text(
        '''/** Tooling-only contract schema and compatibility registry. */
export * from "./registry-contracts.js";
export * from "./schema-registry.js";
export * from "./canonical-fixtures.js";
'''
    )

    package_path = Path("packages/contracts/package.json")
    package = json.loads(package_path.read_text())
    package["exports"] = {
        ".": "./src/index.ts",
        "./registry": "./src/registry-index.ts",
    }
    package_path.write_text(json.dumps(package, indent=2) + "\n")


def patch_generator() -> None:
    path = Path("docs/contracts/generate.mjs")
    source = path.read_text()
    source = replace_once(
        source,
        'from "../../packages/contracts/dist/index.js";',
        'from "../../packages/contracts/dist/registry-index.js";',
        "generator registry import",
    )

    old_function = '''async function writeGeneratedArtifacts(
  corpus,
  index,
  compatibility,
) {
  await Promise.all([
    writeFile(schemaCorpusUrl, documentText(corpus)),
    writeFile(schemaIndexUrl, documentText(index)),
    writeFile(compatibilityRegistryUrl, documentText(compatibility)),
    writeFile(
      canonicalFixtureRegistryUrl,
      documentText(CANONICAL_FIXTURE_REGISTRY),
    ),
  ]);
}
'''
    new_function = '''async function writeDerivedArtifacts(corpus, index) {
  await Promise.all([
    writeFile(schemaCorpusUrl, documentText(corpus)),
    writeFile(schemaIndexUrl, documentText(index)),
    writeFile(
      canonicalFixtureRegistryUrl,
      documentText(CANONICAL_FIXTURE_REGISTRY),
    ),
  ]);
}
'''
    source = replace_once(
        source,
        old_function,
        new_function,
        "generated artifact writer",
    )
    source = replace_once(
        source,
        "  await writeGeneratedArtifacts(corpus, index, compatibility);\n",
        '''  await writeDerivedArtifacts(corpus, index);
  await writeFile(
    compatibilityRegistryUrl,
    documentText(compatibility),
  );
''',
        "bootstrap artifact call",
    )
    source = replace_once(
        source,
        "    await writeGeneratedArtifacts(corpus, index, compatibility);\n",
        "    await writeDerivedArtifacts(corpus, index);\n",
        "write artifact call",
    )
    path.write_text(source)


def patch_tests() -> None:
    path = Path("packages/contracts/src/schema-registry.test.ts")
    source = path.read_text()
    start = source.index('import * as publicContracts from "./index.js";')
    end_marker = '} from "./index.js";\n'
    end = source.index(end_marker, start) + len(end_marker)
    imports = '''import * as publicContracts from "./index.js";
import {
  CompletionDispositionSchema,
  EvidenceContextBlockSchema,
  FederationJobStatusSchema,
  SourceOwnerCutoverReceiptSchema,
} from "./index.js";
import * as registryContracts from "./registry-index.js";
import {
  CANONICAL_FIXTURE_REGISTRY,
  CONTRACT_JSON_SCHEMA_DIALECT,
  CONTRACT_SCHEMA_INDEX_PROTOCOL,
  CONTRACT_SCHEMA_REGISTRY,
  CONTRACT_SCHEMA_REGISTRY_GENERATION,
  ContractCompatibilityRegistrySchema,
  ContractSchemaCorpusDocumentSchema,
  ContractSchemaIndexDocumentSchema,
  generateContractSchemaCorpus,
  getContractSchemaDescriptor,
  requireContractSchemaDescriptor,
  serializeCanonicalContractJson,
} from "./registry-index.js";
'''
    source = source[:start] + imports + source[end:]

    helper = '''function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function hasObjectJsonType(value: unknown): boolean {
  return value === "object" || (Array.isArray(value) && value.includes("object"));
}

'''
    source = replace_once(
        source,
        "function parseJson(raw: string): unknown {\n",
        helper + "function parseJson(raw: string): unknown {\n",
        "test deterministic helpers",
    )
    source = replace_once(
        source,
        '    value.type === "object" &&\n',
        "    hasObjectJsonType(value.type) &&\n",
        "nullable object strictness check",
    )

    old_inventory = '''    const publicSchemaExports = Object.entries(publicContracts)
      .filter(([_name, value]) => value instanceof z.ZodType)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
'''
    new_inventory = '''    const publicSchemaExports = [
      ...Object.entries(publicContracts),
      ...Object.entries(registryContracts),
    ]
      .filter(([_name, value]) => value instanceof z.ZodType)
      .map(([name]) => name)
      .sort(compareCodeUnits);
'''
    source = replace_once(
        source,
        old_inventory,
        new_inventory,
        "public schema inventory",
    )
    path.write_text(source)


def patch_docs() -> None:
    package_path = Path("packages/contracts/README.md")
    package = package_path.read_text()
    package = replace_once(
        package,
        '''Every exported Zod schema is discovered by `schema-registry.ts` and receives a stable family, version,
generation and URN. The committed Draft 2020-12 corpus under `docs/contracts/` is generated from that
runtime registry. Object contracts are closed; open maps must be represented explicitly with a record
schema rather than an omitted strictness decision.
''',
        '''Every public Zod schema is discovered by the tooling-only registry and receives a stable family, version,
generation and URN. Import registry tooling explicitly from `@eliotr/contracts/registry`; the primary
`@eliotr/contracts` entrypoint does not evaluate JSON Schema generation in Worker or PWA product paths.
The committed Draft 2020-12 corpus under `docs/contracts/` is generated from that registry. Object
contracts are closed; open maps must be represented explicitly with a record schema rather than an
omitted strictness decision.
''',
        "package registry boundary documentation",
    )
    package_path.write_text(package)

    docs_path = Path("docs/contracts/README.md")
    docs = docs_path.read_text()
    docs = replace_once(
        docs,
        '''`packages/contracts/src` is the runtime authority for public wire structure and semantic validation.
This directory contains deterministic, reviewable artifacts derived from that authority.
''',
        '''`packages/contracts/src` is the runtime authority for public wire structure and semantic validation.
Registry tooling is exported separately through `@eliotr/contracts/registry`, so normal Worker/PWA imports
do not construct the schema corpus. This directory contains deterministic, reviewable artifacts derived
from that tooling boundary.
''',
        "docs registry boundary documentation",
    )
    docs_path.write_text(docs)

    policy_path = Path("docs/contracts/compatibility.md")
    policy = policy_path.read_text()
    policy = replace_once(
        policy,
        '''- **RETIRED** — the generation is no longer admitted as current. Retirement never deletes history.
''',
        '''- **RETIRED** — the generation is no longer admitted as current. Retirement never deletes history.

Compatibility chains are mechanical: `BACKWARD_COMPATIBLE` and `RETIRED` keep the predecessor version
and advance its generation; `BREAKING` advances the version. Every non-initial entry must reference an
existing predecessor with the same export name and family, and no entry may supersede itself.
''',
        "compatibility chain documentation",
    )
    policy_path.write_text(policy)


def main() -> None:
    patch_schema_registry()
    patch_compatibility_contract()
    patch_exports()
    patch_generator()
    patch_tests()
    patch_docs()


if __name__ == "__main__":
    main()
