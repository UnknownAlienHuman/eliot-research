/** Worker environment fields owned by the installed semantic configuration capability. */
export interface InstalledSemanticConfigurationEnvironment {
  /** Immutable semantic config revision reference (S29); replaces the split JSON chunks. */
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF?: string;
  /** Expected SHA-256 of the canonical semantic config bytes for the revision above. */
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256?: string;
  /** Research semantic configuration as one JSON value (legacy; migration window). */
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON?: string;
  /** Wrangler-safe chunks for the installed semantic configuration; provide both or neither. */
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0?: string;
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1?: string;
}

type SemanticConfigurationJsonEnvironment = Pick<InstalledSemanticConfigurationEnvironment,
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON" | "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0" |
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1">;

const SEMANTIC_CONFIGURATION_CHUNK_BYTES = 4_096;
const SEMANTIC_CONFIGURATION_MAX_BYTES = 65_536;

/** Assemble the optional Wrangler chunks before the strict semantic parser sees the JSON. */
export function readResearchSemanticConfiguration(
  env: SemanticConfigurationJsonEnvironment,
): string | undefined {
  const whole = env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON;
  const first = env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0;
  const second = env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1;
  const hasChunks = first !== undefined || second !== undefined;
  if (whole !== undefined && typeof whole !== "string") return undefined;
  if (!hasChunks) return whole;
  if (whole !== undefined || typeof first !== "string" || typeof second !== "string") return undefined;
  const encoder = new TextEncoder();
  if (encoder.encode(first).byteLength > SEMANTIC_CONFIGURATION_CHUNK_BYTES ||
      encoder.encode(second).byteLength > SEMANTIC_CONFIGURATION_CHUNK_BYTES) return undefined;
  const combined = first + second;
  if (encoder.encode(combined).byteLength > SEMANTIC_CONFIGURATION_MAX_BYTES) return undefined;
  return combined;
}
