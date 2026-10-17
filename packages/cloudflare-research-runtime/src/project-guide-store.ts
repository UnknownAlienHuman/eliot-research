import { IdentifierSchema, Sha256Schema } from "@eliotr/contracts";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
function corrupt(): never { throw new CatalogInputError("PROJECT_GUIDE_STORAGE_CORRUPT", "Project guide binding is inconsistent", 503); }

export type ProjectGuideStoredState = "HELD" | "UNKNOWN" | "RUNNING" | "READY" | "PARTIAL" | "FAILED" | "STALE" | "INVALID";
export interface ProjectGuideRecord {
  readonly identity_digest: string; readonly owner_principal_ref: string; readonly project_id: string;
  readonly language: "en" | "ru"; readonly prompt_revision: string; readonly corpus_digest: string;
  readonly corpus_json: string; readonly selection_json: string; readonly idempotency_key: string;
  readonly request_body: string; readonly workflow_instance_id: string; readonly state: ProjectGuideStoredState;
  readonly artifact_id: string | null; readonly artifact_revision: number | null;
  readonly created_at: string; readonly updated_at: string;
}
export interface ProjectGuideStore {
  read(identity: string, owner: string): Promise<ProjectGuideRecord | null>;
  held(owner: string, project: string, excludedIdentity?: string): Promise<ProjectGuideRecord | null>;
  reserve(record: ProjectGuideRecord): Promise<boolean>;
  update(record: ProjectGuideRecord, state: ProjectGuideStoredState, artifact?: { id: string; revision: number }): Promise<void>;
}
function decode(raw: ProjectGuideRecord | null): ProjectGuideRecord | null {
  if (raw === null) return null;
  if (!Sha256Schema.safeParse(raw.identity_digest).success || !Sha256Schema.safeParse(raw.corpus_digest).success ||
      !["HELD", "UNKNOWN", "RUNNING", "READY", "PARTIAL", "FAILED", "STALE", "INVALID"].includes(raw.state) ||
      !IdentifierSchema.safeParse(raw.owner_principal_ref).success || !IdentifierSchema.safeParse(raw.project_id).success ||
      !IdentifierSchema.safeParse(raw.workflow_instance_id).success || !["en", "ru"].includes(raw.language) ||
      !Number.isFinite(Date.parse(raw.created_at)) || !Number.isFinite(Date.parse(raw.updated_at))) {
    corrupt();
  }
  try { JSON.parse(raw.corpus_json); JSON.parse(raw.selection_json); JSON.parse(raw.request_body); } catch { corrupt(); }
  return raw;
}
export function createProjectGuideStore(database: D1Database, now = () => new Date().toISOString()): ProjectGuideStore {
  return {
    async read(identity, owner) {
      return decode(await database.prepare("SELECT * FROM project_guide_binding WHERE identity_digest=?1 AND owner_principal_ref=?2")
        .bind(identity, owner).first<ProjectGuideRecord>());
    },
    async held(owner, project, excludedIdentity) {
      return decode(await database.prepare("SELECT * FROM project_guide_binding WHERE owner_principal_ref=?1 AND project_id=?2 " +
        "AND state IN ('HELD','UNKNOWN') AND (?3 IS NULL OR identity_digest<>?3) ORDER BY created_at,identity_digest LIMIT 1")
        .bind(owner, project, excludedIdentity ?? null).first<ProjectGuideRecord>());
    },
    async reserve(record) {
      const row = await database.prepare("INSERT INTO project_guide_binding " +
        "(identity_digest,owner_principal_ref,project_id,language,prompt_revision,corpus_digest,corpus_json,selection_json," +
        "idempotency_key,request_body,workflow_instance_id,state,created_at,updated_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'HELD',?12,?12) ON CONFLICT(identity_digest) DO NOTHING RETURNING identity_digest")
        .bind(record.identity_digest, record.owner_principal_ref, record.project_id, record.language, record.prompt_revision,
          record.corpus_digest, record.corpus_json, record.selection_json, record.idempotency_key, record.request_body,
          record.workflow_instance_id, record.created_at).first<{ identity_digest: string }>();
      if (row !== null && row.identity_digest !== record.identity_digest) corrupt();
      return row !== null;
    },
    async update(record, state, artifact) {
      const result = await database.prepare("UPDATE project_guide_binding SET state=?3,artifact_id=?4,artifact_revision=?5,updated_at=?6 " +
        "WHERE identity_digest=?1 AND owner_principal_ref=?2")
        .bind(record.identity_digest, record.owner_principal_ref, state, artifact?.id ?? record.artifact_id,
          artifact?.revision ?? record.artifact_revision, now()).run();
      if (!result.success || result.meta.changes !== 1) throw new CatalogInputError("PROJECT_GUIDE_STORAGE_UNAVAILABLE", "Project guide binding could not be confirmed", 503, true);
    },
  };
}
