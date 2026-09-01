import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  CANONICAL_FIXTURE_REGISTRY,
  CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
  CONTRACT_JSON_SCHEMA_DIALECT,
  CONTRACT_SCHEMA_INDEX_PROTOCOL,
  CONTRACT_SCHEMA_REGISTRY_GENERATION,
  ContractCompatibilityRegistrySchema,
  ContractSchemaIndexDocumentSchema,
  generateContractSchemaCorpus,
  serializeCanonicalContractJson,
} from "../../packages/contracts/dist/index.js";

const mode = globalThis.process.argv[2] ?? "--check";
const supportedModes = new Set(["--bootstrap", "--check", "--write"]);
if (!supportedModes.has(mode)) {
  throw new Error(`unsupported contract artifact mode ${mode}`);
}

const schemaCorpusUrl = new globalThis.URL(
  "./schema-corpus.v1.json",
  import.meta.url,
);
const schemaIndexUrl = new globalThis.URL(
  "./schema-index.v1.json",
  import.meta.url,
);
const compatibilityRegistryUrl = new globalThis.URL(
  "./compatibility-registry.v1.json",
  import.meta.url,
);
const canonicalFixtureRegistryUrl = new globalThis.URL(
  "./canonical-fixtures.v1.json",
  import.meta.url,
);

function documentText(value) {
  return `${serializeCanonicalContractJson(value, true)}\n`;
}

function schemaDigest(value) {
  return createHash("sha256")
    .update(serializeCanonicalContractJson(value))
    .digest("hex");
}

function buildSchemaIndex(corpus) {
  const entries = corpus.schemas.map((entry) => {
    const { json_schema: jsonSchema, ...identity } = entry;
    return {
      ...identity,
      json_schema_sha256: schemaDigest(jsonSchema),
    };
  });

  return ContractSchemaIndexDocumentSchema.parse({
    protocol: CONTRACT_SCHEMA_INDEX_PROTOCOL,
    registry_generation: CONTRACT_SCHEMA_REGISTRY_GENERATION,
    json_schema_dialect: CONTRACT_JSON_SCHEMA_DIALECT,
    schema_count: entries.length,
    entries,
  });
}

function buildInitialCompatibilityRegistry(index) {
  return ContractCompatibilityRegistrySchema.parse({
    protocol: CONTRACT_COMPATIBILITY_REGISTRY_PROTOCOL,
    registry_generation: CONTRACT_SCHEMA_REGISTRY_GENERATION,
    entries: index.entries.map((entry) => ({
      ...entry,
      compatibility: "INITIAL",
      note: "Initial ER-01 publication; no prior generated schema generation exists.",
    })),
  });
}

async function readOptional(url) {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function assertCurrentCompatibility(index, rawCompatibility) {
  const parsed = ContractCompatibilityRegistrySchema.parse(
    JSON.parse(rawCompatibility),
  );
  if (parsed.registry_generation !== CONTRACT_SCHEMA_REGISTRY_GENERATION) {
    throw new Error(
      `compatibility registry generation ${parsed.registry_generation} does not match ${CONTRACT_SCHEMA_REGISTRY_GENERATION}`,
    );
  }

  const exactFields = [
    "schema_id",
    "export_name",
    "family",
    "schema_version",
    "schema_generation",
    "kind",
    "structural_strictness",
    "json_schema_sha256",
  ];

  for (const current of index.entries) {
    const matches = parsed.entries.filter(
      (entry) =>
        entry.export_name === current.export_name &&
        entry.schema_version === current.schema_version &&
        entry.schema_generation === current.schema_generation,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${current.export_name} requires exactly one current compatibility entry; received ${matches.length}`,
      );
    }

    const [match] = matches;
    if (match === undefined || match.compatibility === "RETIRED") {
      throw new Error(`${current.export_name} current generation is retired`);
    }
    for (const field of exactFields) {
      if (match[field] !== current[field]) {
        throw new Error(
          `${current.export_name} compatibility ${field} drift: ${String(match[field])} != ${String(current[field])}`,
        );
      }
    }
  }

  return parsed;
}

async function writeGeneratedArtifacts(
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

async function assertExactArtifact(url, expected) {
  const actual = await readFile(url, "utf8");
  if (actual !== expected) {
    throw new Error(
      `${url.pathname} is stale; regenerate the committed contract artifacts`,
    );
  }
}

const corpus = generateContractSchemaCorpus();
const index = buildSchemaIndex(corpus);
const existingCompatibility = await readOptional(compatibilityRegistryUrl);

if (mode === "--bootstrap") {
  if (existingCompatibility !== undefined) {
    throw new Error(
      "compatibility-registry.v1.json already exists; bootstrap is single-use",
    );
  }
  const compatibility = buildInitialCompatibilityRegistry(index);
  await writeGeneratedArtifacts(corpus, index, compatibility);
} else {
  if (existingCompatibility === undefined) {
    throw new Error(
      "compatibility-registry.v1.json is missing; use --bootstrap once",
    );
  }
  const compatibility = assertCurrentCompatibility(
    index,
    existingCompatibility,
  );

  if (mode === "--write") {
    await writeGeneratedArtifacts(corpus, index, compatibility);
  } else {
    await Promise.all([
      assertExactArtifact(schemaCorpusUrl, documentText(corpus)),
      assertExactArtifact(schemaIndexUrl, documentText(index)),
      assertExactArtifact(
        compatibilityRegistryUrl,
        documentText(compatibility),
      ),
      assertExactArtifact(
        canonicalFixtureRegistryUrl,
        documentText(CANONICAL_FIXTURE_REGISTRY),
      ),
    ]);
  }
}

globalThis.console.warn(
  `Contract artifacts: ${mode.slice(2).toUpperCase()} (${index.schema_count} schemas, generation ${CONTRACT_SCHEMA_REGISTRY_GENERATION}).`,
);
