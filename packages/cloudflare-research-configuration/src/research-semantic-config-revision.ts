import {
  createResearchSemanticConfigRevisionStore,
  ResearchSemanticConfigRevisionError,
  type ResearchSemanticConfigRevisionWriteReceipt,
} from "@eliotr/cloudflare-research";
import { evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import { WorkflowCheckpointError, type WorkflowErrorCode } from "@eliotr/cloudflare-workflows";

/**
 * S29 semantic configuration source resolution (composition root).
 *
 * The Worker environment carries either the immutable revision identity
 * (ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF + ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256)
 * or, during the migration window, the legacy split JSON vars. Mixing both,
 * or a partial revision identity, fails closed. Every consumption of the
 * semantic configuration resolves through this module, so the revision
 * reference travels with the config bytes wherever they are used.
 */

export type ResearchSemanticConfigSourceKind = "revision" | "legacy" | "absent";

/** Explicit environment projection supplied by the Worker composition root. */
export interface ResearchSemanticConfigInput {
  readonly revision_ref?: string;
  readonly config_sha256?: string;
  readonly legacy_config_json?: string;
}

export interface ResearchSemanticConfigSource {
  readonly kind: ResearchSemanticConfigSourceKind;
  /** Present only for kind "revision". */
  readonly revision_ref?: string;
  /** Present only for kind "revision". */
  readonly config_sha256?: string;
}

export interface ResolvedResearchSemanticConfig {
  /** Verified config bytes: immutable D1 bytes for a revision, assembled env for legacy. */
  readonly config_json: string;
  /** Null only for the legacy env source during the migration window. */
  readonly revision_ref: string | null;
  readonly config_sha256: string;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function ambiguous(reason: string): never {
  throw new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_AMBIGUOUS", reason);
}

function validRevisionRef(value: string): boolean {
  return /^scr-[0-9a-f]{12}$/u.test(value);
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Classify the configured semantic configuration source without touching D1.
 * Throws SEMANTIC_CONFIG_SOURCE_AMBIGUOUS when revision and legacy sources
 * are mixed or the revision identity is partial.
 */
export function readResearchSemanticConfigSource(input: ResearchSemanticConfigInput): ResearchSemanticConfigSource {
  const revisionRef = hasText(input.revision_ref)
    ? input.revision_ref.trim()
    : undefined;
  const configSha256 = hasText(input.config_sha256)
    ? input.config_sha256.trim()
    : undefined;
  const legacy = input.legacy_config_json !== undefined;

  if (revisionRef !== undefined && configSha256 === undefined) {
    ambiguous("ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF is set without ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256");
  }
  if (configSha256 !== undefined && revisionRef === undefined) {
    ambiguous("ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256 is set without ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF");
  }
  if (revisionRef !== undefined && legacy) {
    ambiguous("semantic configuration revision and legacy split JSON are both configured");
  }
  if (revisionRef !== undefined && configSha256 !== undefined) {
    if (!validRevisionRef(revisionRef) || !validSha256(configSha256)) {
      throw new ResearchSemanticConfigRevisionError(
        "SEMANTIC_CONFIG_REVISION_INPUT_INVALID",
        "semantic configuration revision identity is malformed",
      );
    }
    return Object.freeze({ kind: "revision", revision_ref: revisionRef, config_sha256: configSha256 });
  }
  if (legacy) return Object.freeze({ kind: "legacy" });
  return Object.freeze({ kind: "absent" });
}

function sourceError(error: unknown): never {
  if (error instanceof ResearchSemanticConfigRevisionError) throw error;
  throw new ResearchSemanticConfigRevisionError(
    "SEMANTIC_CONFIG_REVISION_CONFLICT",
    "semantic configuration revision resolution failed",
    { cause: error },
  );
}

/**
 * Resolve the configured semantic configuration to verified bytes plus its
 * revision identity. Fails closed before any model dispatch when the source
 * is absent, ambiguous, unknown, or digest-mismatched.
 */
export async function resolveResearchSemanticConfig(input: {
  readonly source: ResearchSemanticConfigInput;
  readonly database: D1Database;
}): Promise<ResolvedResearchSemanticConfig> {
  const source = readResearchSemanticConfigSource(input.source);
  if (source.kind === "absent") {
    throw new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_ABSENT", "semantic configuration is not configured");
  }
  if (source.kind === "legacy") {
    const configJson = input.source.legacy_config_json;
    if (configJson === undefined) {
      throw new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_ABSENT", "semantic configuration is not configured");
    }
    const configSha256 = await evidenceSha256Bytes(evidenceUtf8Bytes(configJson));
    return Object.freeze({ config_json: configJson, revision_ref: null, config_sha256: configSha256 });
  }
  const revisionRef = source.revision_ref as string;
  const expectedSha256 = source.config_sha256 as string;
  const store = createResearchSemanticConfigRevisionStore(input.database);
  let revision;
  try {
    revision = await store.getRevision(revisionRef);
  } catch (error) {
    sourceError(error);
  }
  if (revision === null) {
    throw new ResearchSemanticConfigRevisionError(
      "SEMANTIC_CONFIG_REVISION_UNRESOLVED",
      `semantic configuration revision ${revisionRef} is not installed`,
    );
  }
  if (revision.config_sha256 !== expectedSha256) {
    throw new ResearchSemanticConfigRevisionError(
      "SEMANTIC_CONFIG_REVISION_CONFLICT",
      "semantic configuration revision digest does not match the environment digest",
    );
  }
  return Object.freeze({
    config_json: revision.config_json,
    revision_ref: revision.revision_ref,
    config_sha256: revision.config_sha256,
  });
}

/**
 * Map a resolution failure to the safe worker-facing checkpoint code. Absent
 * configuration is MISSING; every other failure (ambiguous, malformed,
 * unknown revision, digest mismatch, tamper) is INVALID. The specific
 * ResearchSemanticConfigRevisionError code remains on the thrown cause for
 * operator diagnosis.
 */
export function semanticConfigCheckpointError(error: unknown): WorkflowCheckpointError {
  if (error instanceof WorkflowCheckpointError) return error;
  const code: WorkflowErrorCode =
    error instanceof ResearchSemanticConfigRevisionError && error.code === "SEMANTIC_CONFIG_SOURCE_ABSENT"
      ? "WORKFLOW_CONFIGURATION_MISSING"
      : "WORKFLOW_CONFIGURATION_INVALID";
  return new WorkflowCheckpointError(code);
}

/**
 * Explicit, operator-driven migration: install the legacy split JSON as one
 * immutable revision and return its identity for the environment. The read
 * path never installs; this is the only write path, run deliberately.
 */
export async function migrateLegacySemanticConfigToRevision(input: {
  readonly source: ResearchSemanticConfigInput;
  readonly database: D1Database;
  readonly created_by_principal_ref: string;
}): Promise<ResearchSemanticConfigRevisionWriteReceipt> {
  const source = readResearchSemanticConfigSource(input.source);
  if (source.kind === "absent") {
    throw new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_ABSENT", "semantic configuration is not configured");
  }
  if (source.kind === "revision") {
    const resolved = await resolveResearchSemanticConfig({ source: input.source, database: input.database });
    return Object.freeze({
      revision_ref: resolved.revision_ref as string,
      config_sha256: resolved.config_sha256,
      created: false,
    });
  }
  const configJson = input.source.legacy_config_json;
  if (configJson === undefined) {
    throw new ResearchSemanticConfigRevisionError("SEMANTIC_CONFIG_SOURCE_ABSENT", "semantic configuration is not configured");
  }
  const store = createResearchSemanticConfigRevisionStore(input.database);
  try {
    return await store.putImmutable({
      config_json: configJson,
      created_by_principal_ref: input.created_by_principal_ref,
    });
  } catch (error) {
    sourceError(error);
  }
}
