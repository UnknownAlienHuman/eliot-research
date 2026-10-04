import {
  CONFIG_REF,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_PAGE,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_REVISIONS,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
  ResearchProjectModelConfigurationError,
  decodeResearchProjectModelConfigurationBundle,
  decodeRevision,
  decodeSelection,
  exactKeys,
  failure,
  plainObject,
  projectGeneration,
  projectIdentifier,
  revisionNumber,
  timestamp,
  type RevisionRow,
  type ResearchProjectModelConfigurationRevision,
  type ResearchProjectModelConfigurationSelection,
  type ResearchProjectModelConfigurationStore,
  type SelectionRow,
} from "./research-project-configuration-codec.js";

const SELECTION_COLUMNS = "selection_revision,configuration_ref,configuration_sha256,selected_at,selected_by_principal_ref";
const REVISION_COLUMNS = "owner_id,project_id,configuration_ref,configuration_sha256,configuration_json,byte_length," +
  "protocol,created_at,created_by_principal_ref";

export {
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_BYTES,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_PAGE,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_REVISIONS,
  RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
  ResearchProjectModelConfigurationError,
  decodeResearchProjectModelConfigurationBundle,
};
export type {
  ResearchProjectModelConfigurationBundle,
  ResearchProjectModelConfigurationErrorCode,
  ResearchProjectModelConfigurationPage,
  ResearchProjectModelConfigurationRevision,
  ResearchProjectModelConfigurationSelection,
  ResearchProjectModelConfigurationStore,
  ResearchProjectModelRuntimeVars,
  ResearchProjectModelSelection,
} from "./research-project-configuration-codec.js";
function cursorEncode(createdAt: string, configurationRef: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ created_at: createdAt, configuration_ref: configurationRef }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function cursorDecode(value: string): { created_at: string; configuration_ref: string } {
  if (value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "configuration history cursor is invalid");
  }
  try {
    const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/"));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const record = plainObject(parsed, "configuration history cursor");
    exactKeys(record, new Set(["created_at", "configuration_ref"]), "configuration history cursor");
    return {
      created_at: timestamp(record.created_at, "history cursor created_at"),
      configuration_ref: projectIdentifier(record.configuration_ref, "history cursor configuration_ref"),
    };
  } catch (cause) {
    if (cause instanceof ResearchProjectModelConfigurationError) throw cause;
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "configuration history cursor is invalid", 400, false, cause);
  }
}

export function createD1ResearchProjectModelConfigurationStore(
  database: D1Database,
  options: { readonly now?: () => string } = {},
): ResearchProjectModelConfigurationStore {
  if (database === null || typeof database !== "object" || typeof database.prepare !== "function") {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "project configuration database is invalid");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "project configuration clock is invalid");
  }
  const now = options.now ?? (() => new Date().toISOString());

  async function readRevisionRow(ownerId: string, projectId: string, configurationRef: string): Promise<RevisionRow | null> {
    return database.prepare(`SELECT ${REVISION_COLUMNS} FROM research_project_model_configuration_revision ` +
      "WHERE owner_id=?1 AND project_id=?2 AND configuration_ref=?3 LIMIT 1")
      .bind(ownerId, projectId, configurationRef).first<RevisionRow>();
  }

  async function readPointerRow(ownerId: string, projectId: string): Promise<SelectionRow | null> {
    return database.prepare(`SELECT ${SELECTION_COLUMNS} FROM research_project_model_configuration_selection ` +
      "WHERE owner_id=?1 AND project_id=?2 LIMIT 1").bind(ownerId, projectId).first<SelectionRow>();
  }

  async function readPointer(ownerId: string, projectId: string): Promise<Omit<ResearchProjectModelConfigurationSelection, "revision"> | null> {
    const raw = await readPointerRow(ownerId, projectId);
    return raw === null ? null : decodeSelection(raw, ownerId, projectId);
  }

  async function readVerifiedRevision(ownerId: string, projectId: string, configurationRef: string): Promise<ResearchProjectModelConfigurationRevision | null> {
    const raw = await readRevisionRow(ownerId, projectId, configurationRef);
    return raw === null ? null : decodeRevision(raw, ownerId, projectId);
  }

  async function readCurrentProjectGeneration(ownerId: string, projectId: string): Promise<number | null> {
    const row = await database.prepare(
      "SELECT p.generation FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
      "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
    ).bind(projectId, ownerId).first<{ readonly generation: unknown }>();
    if (row === null) return null;
    if (!Number.isSafeInteger(row.generation) || (row.generation as number) < 1) {
      failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "current project generation is corrupt", 503, true);
    }
    return row.generation as number;
  }

  async function readIdempotentSelection(input: {
    readonly owner_id: string;
    readonly project_id: string;
    readonly expected_project_generation: number;
    readonly expected_revision: number | null;
    readonly revision: ResearchProjectModelConfigurationRevision;
  }): Promise<ResearchProjectModelConfigurationSelection | null> {
    const expectedGeneration = projectGeneration(input.expected_project_generation);
    const expected = revisionNumber(input.expected_revision);
    if (await readCurrentProjectGeneration(input.owner_id, input.project_id) !== expectedGeneration) return null;
    const pointer = await readPointer(input.owner_id, input.project_id);
    if (pointer === null || pointer.selection_revision !== (expected === null ? 1 : expected + 1) ||
        pointer.configuration_ref !== input.revision.configuration_ref ||
        pointer.configuration_sha256 !== input.revision.configuration_sha256) return null;
    const revision = await readVerifiedRevision(input.owner_id, input.project_id, pointer.configuration_ref);
    if (revision === null || revision.configuration_sha256 !== input.revision.configuration_sha256 ||
        revision.configuration_json !== input.revision.configuration_json || revision.byte_length !== input.revision.byte_length) return null;
    return Object.freeze({ ...pointer, revision });
  }

  async function currentConflict(ownerId: string, projectId: string): Promise<never> {
    const current = await readPointer(ownerId, projectId);
    throw new ResearchProjectModelConfigurationError(
      "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT",
      current === null ? "project model configuration selection changed" :
        `project model configuration selection is now revision ${current.selection_revision}`,
      409,
      false,
    );
  }

  async function movePointer(input: {
    readonly owner_id: string;
    readonly project_id: string;
    readonly expected_project_generation: number;
    readonly expected_revision: number | null;
    readonly revision: ResearchProjectModelConfigurationRevision;
  }): Promise<ResearchProjectModelConfigurationSelection> {
    const ownerId = projectIdentifier(input.owner_id, "owner_id");
    const projectId = projectIdentifier(input.project_id, "project_id");
    const expectedProjectGeneration = projectGeneration(input.expected_project_generation);
    const expected = revisionNumber(input.expected_revision);
    const when = timestamp(now(), "selection clock");
    let applied: SelectionRow | null = null;
    try {
      if (expected === null) {
        applied = await database.prepare(
          `INSERT INTO research_project_model_configuration_selection
            (owner_id,project_id,selection_revision,configuration_ref,configuration_sha256,selected_at,selected_by_principal_ref)
           SELECT ?1,?2,1,?3,?4,?5,?1
           WHERE EXISTS (SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
             WHERE p.project_id=?2 AND p.generation=?6 AND o.principal_ref=?1)
           ON CONFLICT(owner_id,project_id) DO NOTHING RETURNING ${SELECTION_COLUMNS}`,
        ).bind(ownerId, projectId, input.revision.configuration_ref, input.revision.configuration_sha256,
          when, expectedProjectGeneration).first<SelectionRow>();
      } else {
        applied = await database.prepare(
          `UPDATE research_project_model_configuration_selection
             SET selection_revision=selection_revision+1,configuration_ref=?4,configuration_sha256=?5,selected_at=?6,selected_by_principal_ref=?1
           WHERE owner_id=?1 AND project_id=?2 AND selection_revision=?3
             AND EXISTS (SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
               WHERE p.project_id=?2 AND p.generation=?7 AND o.principal_ref=?1)
           RETURNING ${SELECTION_COLUMNS}`,
        ).bind(ownerId, projectId, expected, input.revision.configuration_ref, input.revision.configuration_sha256,
          when, expectedProjectGeneration).first<SelectionRow>();
      }
    } catch (cause) {
      failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "selected configuration pointer write failed", 503, true, cause);
    }
    if (applied === null) {
      const retried = await readIdempotentSelection({ ...input, owner_id: ownerId, project_id: projectId });
      if (retried !== null) return retried;
      return currentConflict(ownerId, projectId);
    }
    const decoded = decodeSelection(applied, ownerId, projectId);
    if (decoded.configuration_ref !== input.revision.configuration_ref ||
        decoded.configuration_sha256 !== input.revision.configuration_sha256 ||
        decoded.selection_revision !== (expected === null ? 1 : expected + 1)) {
      return currentConflict(ownerId, projectId);
    }
    const readback = await readPointer(ownerId, projectId);
    if (readback === null || readback.selection_revision !== decoded.selection_revision ||
        readback.configuration_ref !== decoded.configuration_ref || readback.configuration_sha256 !== decoded.configuration_sha256) {
      return currentConflict(ownerId, projectId);
    }
    return Object.freeze({ ...readback, revision: input.revision });
  }

  return Object.freeze({
    async readSelected(ownerIdRaw: string, projectIdRaw: string): Promise<ResearchProjectModelConfigurationSelection | null> {
      const ownerId = projectIdentifier(ownerIdRaw, "owner_id");
      const projectId = projectIdentifier(projectIdRaw, "project_id");
      const pointer = await readPointer(ownerId, projectId);
      if (pointer === null) return null;
      const revision = await readVerifiedRevision(ownerId, projectId, pointer.configuration_ref);
      if (revision === null || revision.configuration_sha256 !== pointer.configuration_sha256) {
        failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "selected configuration revision is missing or mismatched", 503, true);
      }
      return Object.freeze({ ...pointer, revision });
    },

    async readRevision(ownerIdRaw: string, projectIdRaw: string, configurationRefRaw: string) {
      const ownerId = projectIdentifier(ownerIdRaw, "owner_id");
      const projectId = projectIdentifier(projectIdRaw, "project_id");
      const configurationRef = projectIdentifier(configurationRefRaw, "configuration_ref");
      if (!CONFIG_REF.test(configurationRef)) failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "configuration_ref is invalid");
      return readVerifiedRevision(ownerId, projectId, configurationRef);
    },

    async listRevisions(ownerIdRaw: string, projectIdRaw: string, limitRaw = 20, afterRaw?: string) {
      const ownerId = projectIdentifier(ownerIdRaw, "owner_id");
      const projectId = projectIdentifier(projectIdRaw, "project_id");
      if (!Number.isSafeInteger(limitRaw) || limitRaw < 1 || limitRaw > RESEARCH_PROJECT_MODEL_CONFIGURATION_MAX_PAGE) {
        failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "history page limit must be between 1 and 50");
      }
      const after = afterRaw === undefined ? undefined : cursorDecode(afterRaw);
      const cursorSql = after === undefined ? "" :
        "AND (created_at < ?3 OR (created_at = ?3 AND configuration_ref < ?4)) ";
      const base = "SELECT " + REVISION_COLUMNS + " FROM research_project_model_configuration_revision " +
        "WHERE owner_id=?1 AND project_id=?2 " + cursorSql +
        "ORDER BY created_at DESC,configuration_ref DESC LIMIT ?" + (after === undefined ? "3" : "5");
      const rows = after === undefined
        ? (await database.prepare(base).bind(ownerId, projectId, limitRaw + 1).all<RevisionRow>()).results ?? []
        : (await database.prepare(base).bind(ownerId, projectId, after.created_at, after.configuration_ref, limitRaw + 1).all<RevisionRow>()).results ?? [];
      const hasMore = rows.length > limitRaw;
      const pageRows = rows.slice(0, limitRaw);
      const revisions = await Promise.all(pageRows.map((row) => decodeRevision(row, ownerId, projectId)));
      const last = revisions.at(-1);
      return Object.freeze({ revisions: Object.freeze(revisions),
        next_cursor: hasMore && last ? cursorEncode(last.created_at, last.configuration_ref) : null });
    },

    async saveAndSelect(input: Parameters<ResearchProjectModelConfigurationStore["saveAndSelect"]>[0]) {
      const ownerId = projectIdentifier(input.owner_id, "owner_id");
      const projectId = projectIdentifier(input.project_id, "project_id");
      const expectedProjectGeneration = projectGeneration(input.expected_project_generation);
      const expected = revisionNumber(input.expected_revision);
      const createdAt = timestamp(now(), "revision clock");
      const encoded = await decodeResearchProjectModelConfigurationBundle(input.configuration);
      const revisionWrite = database.prepare(
        `INSERT INTO research_project_model_configuration_revision
          (owner_id,project_id,configuration_ref,configuration_sha256,configuration_json,byte_length,protocol,created_at,created_by_principal_ref)
         SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?1
         WHERE ((?9 IS NULL AND NOT EXISTS (
           SELECT 1 FROM research_project_model_configuration_selection WHERE owner_id=?1 AND project_id=?2
         )) OR (?9 IS NOT NULL AND EXISTS (
           SELECT 1 FROM research_project_model_configuration_selection WHERE owner_id=?1 AND project_id=?2 AND selection_revision=?9
         ))) AND EXISTS (
           SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
           WHERE p.project_id=?2 AND p.generation=?10 AND o.principal_ref=?1
         )
         ON CONFLICT(owner_id,project_id,configuration_ref) DO NOTHING`,
      ).bind(ownerId, projectId, encoded.configuration_ref, encoded.configuration_sha256, encoded.json,
        encoded.byte_length, RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL, createdAt, expected, expectedProjectGeneration);
      const pointerWrite = expected === null
        ? database.prepare(
          `INSERT INTO research_project_model_configuration_selection
             (owner_id,project_id,selection_revision,configuration_ref,configuration_sha256,selected_at,selected_by_principal_ref)
           SELECT ?1,?2,1,?3,?4,?5,?1
           WHERE EXISTS (
             SELECT 1 FROM research_project_model_configuration_revision
             WHERE owner_id=?1 AND project_id=?2 AND configuration_ref=?3 AND configuration_sha256=?4
               AND configuration_json=?6 AND byte_length=?7 AND protocol=?8
           ) AND EXISTS (
             SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
             WHERE p.project_id=?2 AND p.generation=?9 AND o.principal_ref=?1
           )
           ON CONFLICT(owner_id,project_id) DO NOTHING`,
        ).bind(ownerId, projectId, encoded.configuration_ref, encoded.configuration_sha256,
          createdAt, encoded.json, encoded.byte_length, RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL, expectedProjectGeneration)
        : database.prepare(
          `UPDATE research_project_model_configuration_selection
             SET selection_revision=selection_revision+1,configuration_ref=?4,configuration_sha256=?5,
                 selected_at=?6,selected_by_principal_ref=?1
           WHERE owner_id=?1 AND project_id=?2 AND selection_revision=?3
             AND EXISTS (
               SELECT 1 FROM research_project_model_configuration_revision
               WHERE owner_id=?1 AND project_id=?2 AND configuration_ref=?4 AND configuration_sha256=?5
                 AND configuration_json=?7 AND byte_length=?8 AND protocol=?9
             ) AND EXISTS (
               SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
               WHERE p.project_id=?2 AND p.generation=?10 AND o.principal_ref=?1
             )`,
        ).bind(ownerId, projectId, expected, encoded.configuration_ref, encoded.configuration_sha256,
          createdAt, encoded.json, encoded.byte_length, RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL, expectedProjectGeneration);
      try {
        // D1 batches run transactionally. The revision insert is conditional
        // on the same expected head as the selected-pointer CAS, so a stale
        // request neither moves the head nor consumes the bounded history.
        const results = await database.batch([revisionWrite, pointerWrite]);
        if (results.length !== 2) {
          failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "atomic configuration write returned an invalid result", 503, true);
        }
        if (results[1]?.meta.changes !== 1) {
          const stored = await readVerifiedRevision(ownerId, projectId, encoded.configuration_ref);
          if (stored !== null && stored.configuration_sha256 === encoded.configuration_sha256 &&
              stored.configuration_json === encoded.json && stored.byte_length === encoded.byte_length) {
            const retried = await readIdempotentSelection({ owner_id: ownerId, project_id: projectId,
              expected_project_generation: expectedProjectGeneration, expected_revision: expected, revision: stored });
            if (retried !== null) return retried;
          }
          return currentConflict(ownerId, projectId);
        }
      } catch (cause) {
        failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "atomic configuration revision and selection write failed", 503, true, cause);
      }
      const revision = await readVerifiedRevision(ownerId, projectId, encoded.configuration_ref);
      if (revision === null || revision.configuration_sha256 !== encoded.configuration_sha256 || revision.configuration_json !== encoded.json) {
        failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", "immutable configuration revision readback differs", 503, true);
      }
      const pointer = await readPointer(ownerId, projectId);
      if (pointer === null || pointer.configuration_ref !== revision.configuration_ref ||
          pointer.configuration_sha256 !== revision.configuration_sha256 ||
          pointer.selection_revision !== (expected === null ? 1 : expected + 1)) {
        return currentConflict(ownerId, projectId);
      }
      return Object.freeze({ ...pointer, revision });
    },

    async selectExisting(input: Parameters<ResearchProjectModelConfigurationStore["selectExisting"]>[0]) {
      const ownerId = projectIdentifier(input.owner_id, "owner_id");
      const projectId = projectIdentifier(input.project_id, "project_id");
      const expectedProjectGeneration = projectGeneration(input.expected_project_generation);
      const configurationRef = projectIdentifier(input.configuration_ref, "configuration_ref");
      if (!CONFIG_REF.test(configurationRef)) failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", "configuration_ref is invalid");
      const revision = await readVerifiedRevision(ownerId, projectId, configurationRef);
      if (revision === null) failure("RESEARCH_PROJECT_MODEL_CONFIGURATION_NOT_FOUND", "saved project model configuration was not found", 404);
      return movePointer({ owner_id: ownerId, project_id: projectId,
        expected_project_generation: expectedProjectGeneration, expected_revision: input.expected_revision, revision });
    },
  });
}
