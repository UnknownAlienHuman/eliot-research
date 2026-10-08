import type { ResearchSemanticConfigInput } from "@eliotr/cloudflare-research-configuration/research-semantic-config-revision.js";
import {
  migrateLegacySemanticConfigToRevision as migrateSemanticConfig,
  readResearchSemanticConfigSource as readSemanticConfigSource,
  resolveResearchSemanticConfig as resolveSemanticConfig,
  semanticConfigCheckpointError,
} from "@eliotr/cloudflare-research-configuration/research-semantic-config-revision.js";
import type { Env } from "./env.js";
import { readResearchSemanticConfiguration } from "./env.js";

export type {
  ResearchSemanticConfigSourceKind,
  ResearchSemanticConfigSource,
  ResearchSemanticConfigInput,
  ResolvedResearchSemanticConfig,
} from "@eliotr/cloudflare-research-configuration/research-semantic-config-revision.js";
export { semanticConfigCheckpointError };

function semanticConfigInput(env: Env): ResearchSemanticConfigInput {
  const revisionRef = env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF;
  const configSha256 = env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256;
  const legacyConfigJson = readResearchSemanticConfiguration(env);
  return {
    ...(revisionRef === undefined ? {} : { revision_ref: revisionRef }),
    ...(configSha256 === undefined ? {} : { config_sha256: configSha256 }),
    ...(legacyConfigJson === undefined ? {} : { legacy_config_json: legacyConfigJson }),
  };
}

/** Core Env adapter; the configuration package receives only explicit source identity and bytes. */
export function readResearchSemanticConfigSource(env: Env) {
  return readSemanticConfigSource(semanticConfigInput(env));
}

export async function resolveResearchSemanticConfig(input: {
  readonly env: Env;
  readonly database: D1Database;
}) {
  return resolveSemanticConfig({ source: semanticConfigInput(input.env), database: input.database });
}

export async function migrateLegacySemanticConfigToRevision(input: {
  readonly env: Env;
  readonly database: D1Database;
  readonly created_by_principal_ref: string;
}) {
  return migrateSemanticConfig({ source: semanticConfigInput(input.env), database: input.database,
    created_by_principal_ref: input.created_by_principal_ref });
}
