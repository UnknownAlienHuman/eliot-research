import {
  CONTRACT_JSON_SCHEMA_DIALECT,
  CONTRACT_SCHEMA_INDEX_PROTOCOL,
  CONTRACT_SCHEMA_REGISTRY_GENERATION,
  ContractSchemaIndexDocumentSchema,
  generateContractSchemaCorpus,
  serializeCanonicalContractJson,
} from "./registry-index.js";

export async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(
    serializeCanonicalContractJson(value),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildExpectedIndex() {
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
