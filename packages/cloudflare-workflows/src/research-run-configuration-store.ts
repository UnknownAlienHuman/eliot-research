import {
  evidenceSha256Bytes,
  evidenceUtf8Bytes,
  assertEvidenceSha256,
} from "@eliotr/cloudflare-evidence";
import { canonicalJson } from "@eliotr/platform-cloudflare";

export const RESEARCH_RUN_CONFIGURATION_PROTOCOL = "eliotr.research-run-configuration.v1" as const;
export const RESEARCH_RUN_CONFIGURATION_MAX_BYTES = 524_288;
const REFERENCE_PREFIX = "rrc-";

export type ResearchRunConfigurationMode = "snapshot-v1" | "snapshot-v2";
export type ResearchRunConfigurationStoreErrorCode =
  | "RESEARCH_RUN_CONFIGURATION_INPUT_INVALID"
  | "RESEARCH_RUN_CONFIGURATION_CONFLICT"
  | "RESEARCH_RUN_CONFIGURATION_UNRESOLVED"
  | "RESEARCH_RUN_CONFIGURATION_SELECTION_STALE";

export class ResearchRunConfigurationStoreError extends Error {
  constructor(readonly code: ResearchRunConfigurationStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResearchRunConfigurationStoreError";
  }
}

export interface ResearchRunConfigurationAssociation {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal_ref: string;
  readonly deployment_generation: string;
}

export interface ResearchRunConfigurationWriteInput extends ResearchRunConfigurationAssociation {
  readonly mode: ResearchRunConfigurationMode;
  /** Canonical JSON including protocol, mode and the same association fields. */
  readonly configuration_json: string;
  /**
   * Optional linearization guard for chat runs pinned to a selected project
   * configuration. The immutable snapshot is inserted only while this exact
   * selected pointer is still current.
   */
  readonly selection_guard?: ResearchRunConfigurationSelectionGuard;
  /** Atomic qualification/current-generation guard for the installed native branch. */
  readonly installed_native_model_guard?: ResearchRunInstalledNativeModelGuard;
  readonly created_at?: string;
}

export interface ResearchRunConfigurationSelectionGuard {
  readonly owner_id: string;
  readonly project_id: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly selection_revision: number;
}

export interface ResearchRunInstalledNativeModelGuard {
  readonly expected_model_id: string;
}

export interface ResearchRunConfigurationRecord extends ResearchRunConfigurationAssociation {
  readonly protocol: typeof RESEARCH_RUN_CONFIGURATION_PROTOCOL;
  readonly mode: ResearchRunConfigurationMode;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly configuration_json: string;
  readonly byte_length: number;
  readonly created_at: string;
}

export interface ResearchRunConfigurationWriteReceipt {
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly created: boolean;
}

interface ResearchRunConfigurationRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly principal_ref: unknown;
  readonly deployment_generation: unknown;
  readonly protocol: unknown;
  readonly mode: unknown;
  readonly configuration_ref: unknown;
  readonly configuration_sha256: unknown;
  readonly configuration_json: unknown;
  readonly byte_length: unknown;
  readonly created_at: unknown;
}

const SELECT_COLUMNS = "operation_id,investigation_id,principal_ref,deployment_generation,protocol,mode," +
  "configuration_ref,configuration_sha256,configuration_json,byte_length,created_at";
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SECRET_KEYS = new Set(["accesstoken", "apikey", "clientsecret", "gatewaytoken", "refreshtoken",
  "secretaccesskey", "password", "authorization", "credential", "privatekey"]);

function failure(code: ResearchRunConfigurationStoreErrorCode, message: string, cause?: unknown): never {
  throw new ResearchRunConfigurationStoreError(code, message, cause === undefined ? {} : { cause });
}

function assertDatabase(database: unknown): asserts database is D1Database {
  if (database === null || typeof database !== "object" || typeof (database as D1Database).prepare !== "function") {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "Research run configuration database is invalid");
  }
}

function validateAssociation(value: ResearchRunConfigurationAssociation): ResearchRunConfigurationAssociation {
  const fields = ["operation_id", "investigation_id", "principal_ref", "deployment_generation"] as const;
  for (const name of fields) {
    const input = value[name];
    if (typeof input !== "string" || !IDENTIFIER_RE.test(input) || (name === "operation_id" && !OPERATION_RE.test(input))) {
      failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", `${name} is invalid`);
    }
  }
  return Object.freeze({
    operation_id: value.operation_id,
    investigation_id: value.investigation_id,
    principal_ref: value.principal_ref,
    deployment_generation: value.deployment_generation,
  });
}

function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/gu, "")) || containsSecretKey(child));
}

function validateConfigurationJson(
  raw: unknown,
  association: ResearchRunConfigurationAssociation,
  mode: ResearchRunConfigurationMode,
): { readonly json: string; readonly value: Record<string, unknown>; readonly byte_length: number } {
  if (typeof raw !== "string" || raw.length === 0) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_json is required");
  }
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; }
  catch (error) { failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_json is not valid JSON", error); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_json must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== RESEARCH_RUN_CONFIGURATION_PROTOCOL || record.mode !== mode ||
      typeof record.association !== "object" || record.association === null || Array.isArray(record.association) ||
      canonicalJson(record.association) !== canonicalJson(association)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_json protocol, mode or association is invalid");
  }
  if (containsSecretKey(record)) failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_json must not contain credentials or secrets");
  const canonical = canonicalJson(record);
  const byteLength = new TextEncoder().encode(canonical).byteLength;
  if (canonical !== raw || byteLength > RESEARCH_RUN_CONFIGURATION_MAX_BYTES) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_json is not canonical or exceeds its byte bound");
  }
  return { json: canonical, value: record, byte_length: byteLength };
}

function validateSelectionGuard(value: unknown, configuration: Record<string, unknown>): ResearchRunConfigurationSelectionGuard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "selection_guard is invalid");
  }
  const guard = value as Record<string, unknown>;
  const keys = ["owner_id", "project_id", "configuration_ref", "configuration_sha256", "selection_revision"];
  if (Object.keys(guard).length !== keys.length || Object.keys(guard).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(guard, key)) ||
      typeof guard.owner_id !== "string" || !IDENTIFIER_RE.test(guard.owner_id) ||
      typeof guard.project_id !== "string" || !IDENTIFIER_RE.test(guard.project_id) ||
      typeof guard.configuration_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(guard.configuration_sha256) ||
      guard.configuration_ref !== `rpmc-${guard.configuration_sha256}` ||
      !Number.isSafeInteger(guard.selection_revision) || (guard.selection_revision as number) < 1 ||
      (guard.selection_revision as number) > 1_000_000) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "selection_guard is invalid");
  }
  const projectConfiguration = configuration.project_configuration;
  if (typeof projectConfiguration !== "object" || projectConfiguration === null || Array.isArray(projectConfiguration)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "selection_guard requires a project configuration snapshot");
  }
  const project = projectConfiguration as Record<string, unknown>;
  if (project.owner_ref !== guard.owner_id || project.project_id !== guard.project_id ||
      project.configuration_ref !== guard.configuration_ref ||
      project.configuration_sha256 !== guard.configuration_sha256 ||
      project.selection_revision !== guard.selection_revision) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "selection_guard does not match the frozen project configuration");
  }
  return Object.freeze({ owner_id: guard.owner_id as string, project_id: guard.project_id as string,
    configuration_ref: guard.configuration_ref as string,
    configuration_sha256: guard.configuration_sha256 as string, selection_revision: guard.selection_revision as number });
}

function validateInstalledNativeModelGuard(
  value: unknown,
  configuration: Record<string, unknown>,
): ResearchRunInstalledNativeModelGuard {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "installed_native_model_guard is invalid");
  }
  const guard = value as Record<string, unknown>;
  if (Object.keys(guard).length !== 1 || !Object.hasOwn(guard, "expected_model_id") ||
      typeof guard.expected_model_id !== "string" ||
      !/^@cf\/[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/u.test(guard.expected_model_id) ||
      configuration.project_configuration !== null || !Array.isArray(configuration.model_selections)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "installed_native_model_guard is invalid");
  }
  const syntheses = configuration.model_selections.filter((selection) =>
    typeof selection === "object" && selection !== null && !Array.isArray(selection) &&
    (selection as Record<string, unknown>).stage === "SYNTHESIZE");
  const policy = syntheses.length === 1 && typeof (syntheses[0] as Record<string, unknown>).transport_policy === "object"
    ? (syntheses[0] as Record<string, unknown>).transport_policy as Record<string, unknown> : null;
  if (policy === null || policy.model !== guard.expected_model_id) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "installed native model guard does not match the synthesis selection");
  }
  return Object.freeze({ expected_model_id: guard.expected_model_id });
}

export function deriveResearchRunConfigurationRef(configurationSha256: string): string {
  try { assertEvidenceSha256(configurationSha256, "configuration_sha256"); }
  catch { failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_sha256 is not a lowercase SHA-256 digest"); }
  return `${REFERENCE_PREFIX}${configurationSha256.slice(0, 24)}`;
}

function assertRef(value: unknown): string {
  if (typeof value !== "string" || !/^rrc-[0-9a-f]{24}$/u.test(value)) {
    failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "configuration_ref is malformed");
  }
  return value;
}

async function decodeRow(row: ResearchRunConfigurationRow): Promise<ResearchRunConfigurationRecord> {
  if (typeof row.operation_id !== "string" || typeof row.investigation_id !== "string" ||
      typeof row.principal_ref !== "string" || typeof row.deployment_generation !== "string" ||
      row.protocol !== RESEARCH_RUN_CONFIGURATION_PROTOCOL ||
      (row.mode !== "snapshot-v1" && row.mode !== "snapshot-v2") ||
      typeof row.configuration_ref !== "string" || typeof row.configuration_sha256 !== "string" ||
      typeof row.configuration_json !== "string" || typeof row.byte_length !== "number" ||
      typeof row.created_at !== "string") {
    failure("RESEARCH_RUN_CONFIGURATION_CONFLICT", "Stored research run configuration row is malformed");
  }
  const association = validateAssociation({ operation_id: row.operation_id, investigation_id: row.investigation_id,
    principal_ref: row.principal_ref, deployment_generation: row.deployment_generation });
  let validated;
  try { validated = validateConfigurationJson(row.configuration_json, association, row.mode); }
  catch (error) { failure("RESEARCH_RUN_CONFIGURATION_CONFLICT", "Stored research run configuration is malformed", error); }
  const sha256 = await evidenceSha256Bytes(evidenceUtf8Bytes(validated.json));
  let ref: string;
  try { ref = deriveResearchRunConfigurationRef(sha256); }
  catch (error) { failure("RESEARCH_RUN_CONFIGURATION_CONFLICT", "Stored research run configuration digest is malformed", error); }
  if (row.configuration_sha256 !== sha256 || row.configuration_ref !== ref || row.byte_length !== validated.byte_length ||
      !ISO_UTC_RE.test(row.created_at) || Number.isNaN(Date.parse(row.created_at))) {
    failure("RESEARCH_RUN_CONFIGURATION_CONFLICT", "Stored research run configuration failed canonical digest readback");
  }
  return Object.freeze({ ...association, protocol: RESEARCH_RUN_CONFIGURATION_PROTOCOL, mode: row.mode,
    configuration_ref: ref, configuration_sha256: sha256, configuration_json: validated.json,
    byte_length: validated.byte_length, created_at: row.created_at });
}

export function createD1ResearchRunConfigurationStore(database: D1Database) {
  assertDatabase(database);

  async function readRowByOperation(operationId: string): Promise<ResearchRunConfigurationRow | null> {
    return database.prepare(`SELECT ${SELECT_COLUMNS} FROM research_run_configuration WHERE operation_id=?1 LIMIT 1`)
      .bind(operationId).first<ResearchRunConfigurationRow>();
  }

  async function readRowByReference(configurationRef: string): Promise<ResearchRunConfigurationRow | null> {
    return database.prepare(`SELECT ${SELECT_COLUMNS} FROM research_run_configuration WHERE configuration_ref=?1 LIMIT 1`)
      .bind(configurationRef).first<ResearchRunConfigurationRow>();
  }

  return {
    async getByOperation(operationId: string): Promise<ResearchRunConfigurationRecord | null> {
      if (typeof operationId !== "string" || !OPERATION_RE.test(operationId)) {
        failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "operation_id is invalid");
      }
      const row = await readRowByOperation(operationId);
      return row === null ? null : decodeRow(row);
    },

    async getByReference(configurationRef: string): Promise<ResearchRunConfigurationRecord | null> {
      assertRef(configurationRef);
      const row = await readRowByReference(configurationRef);
      return row === null ? null : decodeRow(row);
    },

    async putImmutable(input: ResearchRunConfigurationWriteInput): Promise<ResearchRunConfigurationWriteReceipt> {
      if (input === null || typeof input !== "object" || (input.mode !== "snapshot-v1" && input.mode !== "snapshot-v2")) {
        failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "Research run configuration input is invalid");
      }
      const association = validateAssociation(input);
      const validated = validateConfigurationJson(input.configuration_json, association, input.mode);
      const selectionGuard = input.selection_guard === undefined
        ? undefined : validateSelectionGuard(input.selection_guard, validated.value);
      const installedNativeModelGuard = input.installed_native_model_guard === undefined
        ? undefined : validateInstalledNativeModelGuard(input.installed_native_model_guard, validated.value);
      if (selectionGuard !== undefined && installedNativeModelGuard !== undefined) {
        failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "run configuration cannot use two selection guards");
      }
      const configurationSha256 = await evidenceSha256Bytes(evidenceUtf8Bytes(validated.json));
      const configurationRef = deriveResearchRunConfigurationRef(configurationSha256);
      const createdAt = input.created_at ?? new Date().toISOString();
      if (typeof createdAt !== "string" || !ISO_UTC_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
        failure("RESEARCH_RUN_CONFIGURATION_INPUT_INVALID", "created_at is invalid");
      }
      const write = selectionGuard === undefined && installedNativeModelGuard === undefined
        ? await database.prepare(
          `INSERT INTO research_run_configuration
            (operation_id,investigation_id,principal_ref,deployment_generation,protocol,mode,configuration_ref,
             configuration_sha256,configuration_json,byte_length,created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
           ON CONFLICT(operation_id) DO NOTHING`,
        ).bind(association.operation_id, association.investigation_id, association.principal_ref,
          association.deployment_generation, RESEARCH_RUN_CONFIGURATION_PROTOCOL, input.mode, configurationRef,
          configurationSha256, validated.json, validated.byte_length, createdAt).run()
        : selectionGuard !== undefined
          ? await database.prepare(
          `INSERT INTO research_run_configuration
            (operation_id,investigation_id,principal_ref,deployment_generation,protocol,mode,configuration_ref,
             configuration_sha256,configuration_json,byte_length,created_at)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
           WHERE EXISTS (
             SELECT 1 FROM research_project_model_configuration_selection s
             JOIN project_owner o ON o.project_id=s.project_id AND o.principal_ref=s.owner_id
             JOIN project p ON p.project_id=s.project_id
             WHERE s.owner_id=?12 AND s.project_id=?13 AND s.selection_revision=?14
               AND s.configuration_ref=?15 AND s.configuration_sha256=?16
           )
           ON CONFLICT(operation_id) DO NOTHING`,
          ).bind(association.operation_id, association.investigation_id, association.principal_ref,
          association.deployment_generation, RESEARCH_RUN_CONFIGURATION_PROTOCOL, input.mode, configurationRef,
          configurationSha256, validated.json, validated.byte_length, createdAt,
          selectionGuard.owner_id, selectionGuard.project_id, selectionGuard.selection_revision,
            selectionGuard.configuration_ref, selectionGuard.configuration_sha256).run()
          : await database.prepare(
            `INSERT INTO research_run_configuration
              (operation_id,investigation_id,principal_ref,deployment_generation,protocol,mode,configuration_ref,
               configuration_sha256,configuration_json,byte_length,created_at)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
             WHERE EXISTS (
               SELECT 1 FROM json_each(?9,'$.model_selections') synthesis
               WHERE json_extract(synthesis.value,'$.stage')='SYNTHESIZE'
                 AND json_extract(synthesis.value,'$.transport_policy.model')=?12
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?9,'$.model_selections') selected
               WHERE NOT EXISTS (
                 SELECT 1 FROM dynamic_route_active_generation a
                 JOIN dynamic_route_active_qualification q
                   ON q.route_ref=a.route_ref AND q.route_version=a.route_version
                   AND q.candidate_ref=a.candidate_ref AND q.candidate_sha256=a.candidate_sha256
                 JOIN dynamic_route_qualification_proof p
                   ON p.qualification_ref=q.qualification_ref AND p.proof_sha256=q.qualification_sha256
                 WHERE a.route_ref=json_extract(selected.value,'$.route_ref')
                   AND a.route_version=json_extract(selected.value,'$.route_version')
                   AND a.candidate_ref=json_extract(selected.value,'$.candidate_ref')
                   AND a.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
                   AND q.qualification_ref=json_extract(selected.value,'$.qualification_ref')
                   AND q.qualification_sha256=json_extract(selected.value,'$.qualification_sha256')
                   AND json_extract(p.qualification_json,'$.qualification.tier')='LIVE'
                   AND NOT EXISTS (
                     SELECT 1 FROM dynamic_route_qualification_revocation rev
                     WHERE rev.qualification_ref=q.qualification_ref
                       AND rev.qualification_sha256=q.qualification_sha256
                   )
               )
             )
             ON CONFLICT(operation_id) DO NOTHING`,
          ).bind(association.operation_id, association.investigation_id, association.principal_ref,
            association.deployment_generation, RESEARCH_RUN_CONFIGURATION_PROTOCOL, input.mode, configurationRef,
            configurationSha256, validated.json, validated.byte_length, createdAt,
            installedNativeModelGuard?.expected_model_id ?? "").run();
      const stored = await readRowByOperation(association.operation_id);
      if (stored === null) failure(selectionGuard === undefined && installedNativeModelGuard === undefined
        ? "RESEARCH_RUN_CONFIGURATION_UNRESOLVED" : "RESEARCH_RUN_CONFIGURATION_SELECTION_STALE",
      selectionGuard === undefined && installedNativeModelGuard === undefined
        ? "Research run configuration write did not persist"
        : "Selected model qualification changed before the run snapshot was frozen");
      const record = await decodeRow(stored);
      if (record.investigation_id !== association.investigation_id || record.principal_ref !== association.principal_ref ||
          record.deployment_generation !== association.deployment_generation || record.mode !== input.mode ||
          record.configuration_ref !== configurationRef || record.configuration_sha256 !== configurationSha256 ||
          record.configuration_json !== validated.json) {
        failure("RESEARCH_RUN_CONFIGURATION_CONFLICT", "Research run configuration replay differs from its immutable snapshot");
      }
      const created = write.meta?.changes === 1;
      return Object.freeze({ configuration_ref: record.configuration_ref, configuration_sha256: record.configuration_sha256, created });
    },
  };
}

export type ResearchRunConfigurationStore = ReturnType<typeof createD1ResearchRunConfigurationStore>;
