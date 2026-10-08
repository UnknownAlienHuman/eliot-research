import {
  assertEvidenceIdentifier,
  assertEvidenceSha256,
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
} from "@eliotr/cloudflare-evidence";

/**
 * S29 immutable semantic configuration revision store.
 *
 * Replaces the raw ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0/_1 env blobs with
 * one content-addressed revision. The environment keeps only a short revision
 * reference and the expected SHA-256 digest; the canonical config bytes live
 * here, immutably. A revision row is never updated or deleted (D1 triggers),
 * and a conflicting byte payload under one reference fails closed at write
 * time via the readback check.
 */

export const RESEARCH_SEMANTIC_CONFIG_PROTOCOL = "eliotr.research-semantic-config.v1" as const;
export const RESEARCH_SEMANTIC_CONFIG_MAX_BYTES = 65_536;
const REVISION_REF_PREFIX = "scr-";

export type ResearchSemanticConfigRevisionErrorCode =
  | "SEMANTIC_CONFIG_REVISION_INPUT_INVALID"
  | "SEMANTIC_CONFIG_REVISION_CONFLICT"
  | "SEMANTIC_CONFIG_REVISION_UNRESOLVED"
  | "SEMANTIC_CONFIG_SOURCE_AMBIGUOUS"
  | "SEMANTIC_CONFIG_SOURCE_ABSENT";

export class ResearchSemanticConfigRevisionError extends Error {
  constructor(
    readonly code: ResearchSemanticConfigRevisionErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "ResearchSemanticConfigRevisionError";
  }
}

function failure(code: ResearchSemanticConfigRevisionErrorCode, message: string, cause?: unknown): never {
  throw new ResearchSemanticConfigRevisionError(code, message, cause === undefined ? {} : { cause });
}

export interface ResearchSemanticConfigRevision {
  readonly revision_ref: string;
  readonly config_sha256: string;
  readonly config_json: string;
  readonly byte_length: number;
  readonly protocol: typeof RESEARCH_SEMANTIC_CONFIG_PROTOCOL;
  readonly created_at: string;
  readonly created_by_principal_ref: string;
}

export interface ResearchSemanticConfigRevisionWriteReceipt {
  readonly revision_ref: string;
  readonly config_sha256: string;
  /** false when the identical bytes were already stored (idempotent replay). */
  readonly created: boolean;
}

export interface ResearchSemanticConfigRevisionWriteInput {
  /** Exact canonical config bytes to store; identity is their SHA-256. */
  readonly config_json: string;
  readonly created_by_principal_ref: string;
  readonly created_at?: string;
}

interface ResearchSemanticConfigRevisionRow {
  readonly revision_ref: unknown;
  readonly config_sha256: unknown;
  readonly config_json: unknown;
  readonly byte_length: unknown;
  readonly protocol: unknown;
  readonly created_at: unknown;
  readonly created_by_principal_ref: unknown;
}

const SELECT_COLUMNS =
  "revision_ref,config_sha256,config_json,byte_length,protocol,created_at,created_by_principal_ref";

function assertDatabase(database: unknown): asserts database is D1Database {
  if (database === null || typeof database !== "object" || typeof (database as D1Database).prepare !== "function") {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "Semantic config revision database is invalid");
  }
}

/** Derive the short revision reference from the content digest. */
export function deriveResearchSemanticConfigRevisionRef(configSha256: string): string {
  try {
    assertEvidenceSha256(configSha256, "config_sha256");
  } catch {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "config_sha256 is not a lowercase SHA-256 digest");
  }
  return `${REVISION_REF_PREFIX}${configSha256.slice(0, 12)}`;
}

function assertRevisionRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^scr-[0-9a-f]{12}$/u.test(value)) {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", `${label} is not a semantic config revision reference`);
  }
  return value;
}

function canonicalConfigJson(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "config_json is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "config_json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "config_json must be a JSON object");
  }
  if ((parsed as Record<string, unknown>).protocol !== RESEARCH_SEMANTIC_CONFIG_PROTOCOL) {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "config_json protocol is not eliotr.research-semantic-config.v1");
  }
  if (new TextEncoder().encode(value).byteLength > RESEARCH_SEMANTIC_CONFIG_MAX_BYTES) {
    failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "config_json exceeds its byte bound");
  }
  return value;
}

async function decodeStoredRow(row: ResearchSemanticConfigRevisionRow): Promise<ResearchSemanticConfigRevision> {
  if (
    typeof row.revision_ref !== "string" ||
    typeof row.config_sha256 !== "string" ||
    typeof row.config_json !== "string" ||
    typeof row.byte_length !== "number" ||
    typeof row.created_at !== "string" ||
    typeof row.created_by_principal_ref !== "string"
  ) {
    failure("SEMANTIC_CONFIG_REVISION_CONFLICT", "Stored semantic config revision row is malformed");
  }
  const recomputed = await evidenceSha256Bytes(evidenceUtf8Bytes(row.config_json));
  if (
    row.config_sha256 !== recomputed ||
    row.revision_ref !== deriveResearchSemanticConfigRevisionRef(recomputed) ||
    row.byte_length !== new TextEncoder().encode(row.config_json).byteLength ||
    row.protocol !== RESEARCH_SEMANTIC_CONFIG_PROTOCOL
  ) {
    failure("SEMANTIC_CONFIG_REVISION_CONFLICT", "Stored semantic config revision readback differs from its digest");
  }
  return Object.freeze({
    revision_ref: row.revision_ref,
    config_sha256: row.config_sha256,
    config_json: row.config_json,
    byte_length: row.byte_length,
    protocol: RESEARCH_SEMANTIC_CONFIG_PROTOCOL,
    created_at: row.created_at,
    created_by_principal_ref: row.created_by_principal_ref,
  });
}

export function createResearchSemanticConfigRevisionStore(database: D1Database) {
  assertDatabase(database);

  async function readRow(revisionRef: string): Promise<ResearchSemanticConfigRevisionRow | null> {
    return database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM research_semantic_config_revision WHERE revision_ref=?1 LIMIT 1`)
      .bind(revisionRef)
      .first<ResearchSemanticConfigRevisionRow>();
  }

  return {
    /**
     * Resolve a revision by reference. Returns null when unknown; throws
     * SEMANTIC_CONFIG_REVISION_CONFLICT when the stored bytes fail their
     * digest readback (tamper or corruption fails closed).
     */
    async getRevision(revisionRef: string): Promise<ResearchSemanticConfigRevision | null> {
      assertRevisionRef(revisionRef, "revision_ref");
      const row = await readRow(revisionRef);
      if (row === null) return null;
      return decodeStoredRow(row);
    },

    /**
     * Store one immutable revision. Identical bytes replay idempotently
     * (created: false); different bytes under a derived reference fail
     * closed instead of overwriting.
     */
    async putImmutable(input: ResearchSemanticConfigRevisionWriteInput): Promise<ResearchSemanticConfigRevisionWriteReceipt> {
      if (input === null || typeof input !== "object") {
        failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "Semantic config revision input is invalid");
      }
      const configJson = canonicalConfigJson(input.config_json);
      let createdBy: string;
      try {
        createdBy = assertEvidenceIdentifier(input.created_by_principal_ref, "created_by_principal_ref");
      } catch {
        failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "created_by_principal_ref is not a bounded identifier");
      }
      const createdAt = input.created_at ?? new Date().toISOString();
      if (typeof createdAt !== "string" || createdAt.length === 0 || createdAt.length > 64) {
        failure("SEMANTIC_CONFIG_REVISION_INPUT_INVALID", "created_at is invalid");
      }
      const configSha256 = await evidenceSha256Bytes(evidenceUtf8Bytes(configJson));
      const revisionRef = deriveResearchSemanticConfigRevisionRef(configSha256);
      const byteLength = new TextEncoder().encode(configJson).byteLength;

      await database
        .prepare(
          `INSERT INTO research_semantic_config_revision
             (revision_ref,config_sha256,config_json,byte_length,protocol,created_at,created_by_principal_ref)
           VALUES (?1,?2,?3,?4,?5,?6,?7)
           ON CONFLICT(revision_ref) DO NOTHING`,
        )
        .bind(revisionRef, configSha256, configJson, byteLength, RESEARCH_SEMANTIC_CONFIG_PROTOCOL, createdAt, createdBy)
        .run();

      const stored = await readRow(revisionRef);
      if (stored === null) {
        failure("SEMANTIC_CONFIG_REVISION_CONFLICT", "Semantic config revision write did not persist");
      }
      const revision = await decodeStoredRow(stored);
      const created = revision.created_at === createdAt && revision.created_by_principal_ref === createdBy;
      return Object.freeze({ revision_ref: revision.revision_ref, config_sha256: revision.config_sha256, created });
    },
  };
}

export type ResearchSemanticConfigRevisionStore = ReturnType<typeof createResearchSemanticConfigRevisionStore>;
