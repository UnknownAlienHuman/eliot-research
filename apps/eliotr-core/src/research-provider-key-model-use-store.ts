import { APPLICATION_MODEL_ROUTES } from "@eliotr/platform-cloudflare";
import type { ResearchProviderKeyModelUseFailureCode } from "@eliotr/contracts";

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CONFIGURATION_REF = /^rpmc-[a-f0-9]{64}$/u;
const STAGES = ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"] as const;
const ROUTES = new Set<string>(APPLICATION_MODEL_ROUTES);
const STATES = new Set(["ACCEPTED", "PREPARING", "QUALIFYING", "IMPORTING", "SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT"]);
const PHASES = new Set([
  "INTENT", "FREE_PRICE_CHECK", "NATIVE_PREPARE", "NATIVE_QUALIFY",
  "CONFIGURATION_IMPORT", "SELECTION_READBACK", "COMPLETE",
]);
const STAGE_STATES = new Set(["PENDING", "PREPARED", "QUALIFYING", "QUALIFIED", "BLOCKED", "UNCERTAIN"]);
const FAILURE_CODES = new Set([
  "NO_SELECTED_CONFIGURATION", "FREE_PRICE_NOT_PROVEN", "FREE_PRICE_NOT_ZERO",
  "SERVER_POLICY_UNAVAILABLE", "PREPARATION_REJECTED", "QUALIFICATION_NO_EFFECT",
  "QUALIFICATION_OUTCOME_UNCERTAIN", "NATIVE_RECEIPT_INVALID", "SELECTION_CAS_CONFLICT",
  "AUTHORITY_CHANGED", "STORAGE_UNAVAILABLE",
]);

export type ResearchProviderKeyModelUseStage = typeof STAGES[number];
export type ResearchProviderKeyModelUseDbState =
  | "ACCEPTED" | "PREPARING" | "QUALIFYING" | "IMPORTING"
  | "SELECTED" | "BLOCKED" | "UNCERTAIN" | "CONFLICT";
export type ResearchProviderKeyModelUseDbPhase =
  | "INTENT" | "FREE_PRICE_CHECK" | "NATIVE_PREPARE" | "NATIVE_QUALIFY"
  | "CONFIGURATION_IMPORT" | "SELECTION_READBACK" | "COMPLETE";
export type ResearchProviderKeyModelUseStageDbState =
  | "PENDING" | "PREPARED" | "QUALIFYING" | "QUALIFIED" | "BLOCKED" | "UNCERTAIN";

export interface ResearchProviderKeyModelUseStagePlan {
  readonly sequence_number: number;
  readonly stage: ResearchProviderKeyModelUseStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly prompt_sha256: string;
  readonly schema_sha256: string;
  readonly parameters_sha256: string;
  readonly probe_prompt_sha256: string;
  readonly probe_schema_sha256: string;
  readonly probe_parameters_sha256: string;
}

export interface ResearchProviderKeyModelUseStageRow extends ResearchProviderKeyModelUseStagePlan {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly pricing_snapshot_ref: string | null;
  readonly pricing_snapshot_sha256: string | null;
  readonly preparation_ref: string | null;
  readonly preparation_sha256: string | null;
  readonly candidate_ref: string | null;
  readonly candidate_sha256: string | null;
  readonly qualification_ref: string | null;
  readonly qualification_sha256: string | null;
  readonly state: ResearchProviderKeyModelUseStageDbState;
  readonly failure_code: ResearchProviderKeyModelUseFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ResearchProviderKeyModelUseRow {
  readonly owner_id: string;
  readonly project_id: string;
  readonly provider_id: "openrouter";
  readonly operation_id: string;
  readonly key_operation_id: string;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
  readonly request_sha256: string;
  readonly configuration_basis_json: string;
  readonly owner_credential_generation: string;
  readonly project_generation: number;
  readonly deployment_generation: string;
  /** Finite server-owned check/use deadline and free-price snapshot expiry. */
  readonly deadline_at: string;
  readonly expected_selection_revision: number | null;
  readonly source_configuration_ref: string | null;
  readonly source_configuration_sha256: string | null;
  readonly planned_stage_set_sha256: string;
  readonly plan_sha256: string;
  readonly state: ResearchProviderKeyModelUseDbState;
  readonly phase: ResearchProviderKeyModelUseDbPhase;
  readonly active_stage: ResearchProviderKeyModelUseStage | null;
  readonly target_configuration_ref: string | null;
  readonly target_configuration_sha256: string | null;
  readonly target_configuration_json: string | null;
  readonly selected_configuration_ref: string | null;
  readonly selection_revision: number | null;
  readonly failure_code: ResearchProviderKeyModelUseFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ResearchProviderKeyModelUseIntent {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly key_operation_id: string;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
  readonly request_sha256: string;
  readonly configuration_basis_json: string;
  readonly owner_credential_generation: string;
  readonly project_generation: number;
  readonly deployment_generation: string;
  readonly deadline_at: string;
  readonly expected_selection_revision: number | null;
  readonly source_configuration_ref: string | null;
  readonly source_configuration_sha256: string | null;
  readonly planned_stage_set_sha256: string;
  readonly plan_sha256: string;
  readonly stages: readonly ResearchProviderKeyModelUseStagePlan[];
  readonly created_at: string;
}

export class ResearchProviderKeyModelUseStoreError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelUseStoreError";
  }
}

function storage(message: string, cause?: unknown): never {
  throw new ResearchProviderKeyModelUseStoreError(message, cause);
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) storage(`${label} is corrupt`);
  return value;
}

function validInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    storage(`${label} is corrupt`);
  }
  return value;
}

function nullableRevision(value: unknown, label: string): number | null {
  return value === null ? null : validInteger(value, label, 1, 999_999);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) storage(`${label} is corrupt`);
  return value;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) storage(`${label} is corrupt`);
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function decodeFailure(value: unknown): ResearchProviderKeyModelUseFailureCode | null {
  if (value === null) return null;
  if (typeof value !== "string" || !FAILURE_CODES.has(value)) storage("stored model-use failure code is corrupt");
  return value as ResearchProviderKeyModelUseFailureCode;
}

const OPERATION_COLUMNS = [
  "owner_id", "project_id", "provider_id", "operation_id", "key_operation_id", "account_id", "gateway_id",
  "alias", "provider_config_id", "configuration_metadata_sha256", "request_sha256",
  "configuration_basis_json", "owner_credential_generation", "project_generation", "deployment_generation", "expected_selection_revision",
  "deadline_at",
  "source_configuration_ref", "source_configuration_sha256", "planned_stage_set_sha256", "plan_sha256",
  "state", "phase", "active_stage", "target_configuration_ref", "target_configuration_sha256", "target_configuration_json",
  "selected_configuration_ref", "selection_revision", "failure_code", "created_at", "updated_at",
].join(",");

const STAGE_COLUMNS = [
  "owner_id", "project_id", "operation_id", "sequence_number", "stage", "route_ref", "route_version",
  "prompt_sha256", "schema_sha256", "parameters_sha256", "probe_prompt_sha256", "probe_schema_sha256",
  "probe_parameters_sha256", "pricing_snapshot_ref", "pricing_snapshot_sha256",
  "preparation_ref", "preparation_sha256", "candidate_ref", "candidate_sha256", "qualification_ref",
  "qualification_sha256", "state", "failure_code", "created_at", "updated_at",
].join(",");

export function decodeResearchProviderKeyModelUseRow(raw: unknown): ResearchProviderKeyModelUseRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) storage("stored model-use operation is invalid");
  const row = raw as Record<string, unknown>;
  if (typeof row.owner_id !== "string" || !IDENTIFIER.test(row.owner_id) ||
      typeof row.project_id !== "string" || !IDENTIFIER.test(row.project_id) ||
      row.provider_id !== "openrouter" || typeof row.operation_id !== "string" || !OPERATION_ID.test(row.operation_id) ||
      typeof row.key_operation_id !== "string" || !OPERATION_ID.test(row.key_operation_id) ||
      typeof row.account_id !== "string" || !/^[A-Fa-f0-9]{32}$/u.test(row.account_id) ||
      typeof row.gateway_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(row.gateway_id) ||
      typeof row.alias !== "string" || !/^eliotr-[0-9a-f]{48}$/u.test(row.alias) ||
      typeof row.provider_config_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(row.provider_config_id) ||
      typeof row.configuration_metadata_sha256 !== "string" || !SHA256.test(row.configuration_metadata_sha256) ||
      typeof row.request_sha256 !== "string" || !SHA256.test(row.request_sha256) ||
      typeof row.configuration_basis_json !== "string" || new TextEncoder().encode(row.configuration_basis_json).byteLength > 524_288 ||
      typeof row.owner_credential_generation !== "string" || !IDENTIFIER.test(row.owner_credential_generation) ||
      typeof row.deployment_generation !== "string" || !IDENTIFIER.test(row.deployment_generation) ||
      typeof row.deadline_at !== "string" || !Number.isFinite(Date.parse(row.deadline_at)) ||
      new Date(Date.parse(row.deadline_at)).toISOString() !== row.deadline_at ||
      typeof row.planned_stage_set_sha256 !== "string" || !SHA256.test(row.planned_stage_set_sha256) ||
      typeof row.plan_sha256 !== "string" || !SHA256.test(row.plan_sha256) ||
      typeof row.state !== "string" || !STATES.has(row.state) ||
      typeof row.phase !== "string" || !PHASES.has(row.phase)) {
    storage("stored model-use operation identity is corrupt");
  }
  const expectedRevision = nullableRevision(row.expected_selection_revision, "expected selection revision");
  const sourceRef = row.source_configuration_ref === null ? null : row.source_configuration_ref;
  if (sourceRef !== null && (typeof sourceRef !== "string" || !CONFIGURATION_REF.test(sourceRef))) {
    storage("stored source configuration reference is corrupt");
  }
  const sourceSha = nullableDigest(row.source_configuration_sha256, "source configuration digest");
  const activeStage = row.active_stage === null ? null : row.active_stage;
  if (activeStage !== null && (typeof activeStage !== "string" || !(STAGES as readonly string[]).includes(activeStage))) {
    storage("stored active model-use stage is corrupt");
  }
  const targetRef = row.target_configuration_ref === null ? null : row.target_configuration_ref;
  if (targetRef !== null && (typeof targetRef !== "string" || !CONFIGURATION_REF.test(targetRef))) {
    storage("stored target configuration reference is corrupt");
  }
  const targetSha = nullableDigest(row.target_configuration_sha256, "target configuration digest");
  const targetJson = row.target_configuration_json === null ? null : row.target_configuration_json;
  if (targetJson !== null && (typeof targetJson !== "string" || new TextEncoder().encode(targetJson).byteLength > 262_144)) {
    storage("stored target configuration bytes are invalid");
  }
  const selectedRef = row.selected_configuration_ref === null ? null : row.selected_configuration_ref;
  if (selectedRef !== null && (typeof selectedRef !== "string" || !CONFIGURATION_REF.test(selectedRef))) {
    storage("stored selected configuration reference is corrupt");
  }
  const selectionRevision = nullableRevision(row.selection_revision, "selection revision");
  const failureCode = decodeFailure(row.failure_code);
  const state = row.state as ResearchProviderKeyModelUseDbState;
  if ((sourceRef === null) !== (sourceSha === null) || (targetRef === null) !== (targetSha === null) ||
      (targetRef === null) !== (targetJson === null) ||
      (selectedRef === null) !== (selectionRevision === null) ||
      (expectedRevision === null) !== (sourceRef === null) ||
      (state === "SELECTED" && (row.phase !== "COMPLETE" || targetRef === null || selectedRef !== targetRef || failureCode !== null)) ||
      (state !== "SELECTED" && (selectedRef !== null || selectionRevision !== null)) ||
      ((state === "BLOCKED" || state === "UNCERTAIN" || state === "CONFLICT") !== (failureCode !== null)) ||
      (state === "UNCERTAIN" && (failureCode !== "QUALIFICATION_OUTCOME_UNCERTAIN" || row.phase !== "NATIVE_QUALIFY")) ||
      (state === "CONFLICT" && failureCode !== "SELECTION_CAS_CONFLICT")) {
    storage("stored model-use state or configuration binding is inconsistent");
  }
  return Object.freeze({
    owner_id: row.owner_id,
    project_id: row.project_id,
    provider_id: "openrouter",
    operation_id: row.operation_id,
    key_operation_id: row.key_operation_id,
    account_id: row.account_id,
    gateway_id: row.gateway_id,
    alias: row.alias,
    provider_config_id: row.provider_config_id,
    configuration_metadata_sha256: row.configuration_metadata_sha256,
    request_sha256: row.request_sha256,
    configuration_basis_json: row.configuration_basis_json,
    owner_credential_generation: row.owner_credential_generation,
    project_generation: validInteger(row.project_generation, "project generation", 1, 2_147_483_647),
    deployment_generation: row.deployment_generation,
    deadline_at: validTimestamp(row.deadline_at, "deadline_at"),
    expected_selection_revision: expectedRevision,
    source_configuration_ref: sourceRef,
    source_configuration_sha256: sourceSha,
    planned_stage_set_sha256: row.planned_stage_set_sha256,
    plan_sha256: row.plan_sha256,
    state,
    phase: row.phase as ResearchProviderKeyModelUseDbPhase,
    active_stage: activeStage as ResearchProviderKeyModelUseStage | null,
    target_configuration_ref: targetRef,
    target_configuration_sha256: targetSha,
    target_configuration_json: targetJson,
    selected_configuration_ref: selectedRef,
    selection_revision: selectionRevision,
    failure_code: failureCode,
    created_at: validTimestamp(row.created_at, "created_at"),
    updated_at: validTimestamp(row.updated_at, "updated_at"),
  });
}

export function decodeResearchProviderKeyModelUseStageRow(raw: unknown): ResearchProviderKeyModelUseStageRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) storage("stored model-use stage is invalid");
  const row = raw as Record<string, unknown>;
  const stage = row.stage;
  const sequence = validInteger(row.sequence_number, "stage sequence", 0, 3);
  if (typeof row.owner_id !== "string" || !IDENTIFIER.test(row.owner_id) ||
      typeof row.project_id !== "string" || !IDENTIFIER.test(row.project_id) ||
      typeof row.operation_id !== "string" || !OPERATION_ID.test(row.operation_id) ||
      typeof stage !== "string" || !(STAGES as readonly string[]).includes(stage) ||
      typeof row.route_ref !== "string" || !ROUTES.has(row.route_ref) ||
      typeof row.route_version !== "string" || !IDENTIFIER.test(row.route_version) ||
      typeof row.state !== "string" || !STAGE_STATES.has(row.state)) {
    storage("stored model-use stage identity is corrupt");
  }
  const pricingRef = nullableIdentifier(row.pricing_snapshot_ref, "pricing snapshot reference");
  const pricingSha = nullableDigest(row.pricing_snapshot_sha256, "pricing snapshot digest");
  const preparationRef = nullableIdentifier(row.preparation_ref, "native preparation reference");
  const preparationSha = nullableDigest(row.preparation_sha256, "native preparation digest");
  const candidateRef = nullableIdentifier(row.candidate_ref, "native candidate reference");
  const candidateSha = nullableDigest(row.candidate_sha256, "native candidate digest");
  const qualificationRef = nullableIdentifier(row.qualification_ref, "native qualification reference");
  const qualificationSha = nullableDigest(row.qualification_sha256, "native qualification digest");
  const state = row.state as ResearchProviderKeyModelUseStageDbState;
  if ((pricingRef === null) !== (pricingSha === null) || (preparationRef === null) !== (preparationSha === null) ||
      (candidateRef === null) !== (candidateSha === null) || (qualificationRef === null) !== (qualificationSha === null) ||
      (candidateRef === null) !== (qualificationRef === null) ||
      (state !== "PENDING" && pricingRef === null) ||
      ((state === "PREPARED" || state === "QUALIFYING" || state === "QUALIFIED" || state === "UNCERTAIN") && preparationRef === null) ||
      (state === "QUALIFIED" && (candidateRef === null || qualificationRef === null)) ||
      ((state === "BLOCKED" || state === "UNCERTAIN") !== (row.failure_code !== null))) {
    storage("stored model-use stage receipt or state is inconsistent");
  }
  return Object.freeze({
    owner_id: row.owner_id,
    project_id: row.project_id,
    operation_id: row.operation_id,
    sequence_number: sequence,
    stage: stage as ResearchProviderKeyModelUseStage,
    route_ref: row.route_ref,
    route_version: row.route_version,
    prompt_sha256: digest(row.prompt_sha256, "stage prompt digest"),
    schema_sha256: digest(row.schema_sha256, "stage schema digest"),
    parameters_sha256: digest(row.parameters_sha256, "stage parameters digest"),
    probe_prompt_sha256: digest(row.probe_prompt_sha256, "probe prompt digest"),
    probe_schema_sha256: digest(row.probe_schema_sha256, "probe schema digest"),
    probe_parameters_sha256: digest(row.probe_parameters_sha256, "probe parameters digest"),
    pricing_snapshot_ref: pricingRef,
    pricing_snapshot_sha256: pricingSha,
    preparation_ref: preparationRef,
    preparation_sha256: preparationSha,
    candidate_ref: candidateRef,
    candidate_sha256: candidateSha,
    qualification_ref: qualificationRef,
    qualification_sha256: qualificationSha,
    state,
    failure_code: decodeFailure(row.failure_code),
    created_at: validTimestamp(row.created_at, "stage created_at"),
    updated_at: validTimestamp(row.updated_at, "stage updated_at"),
  });
}

export function createResearchProviderKeyModelUseStore(database: D1Database) {
  if (typeof database?.prepare !== "function" || typeof database.batch !== "function") {
    storage("Core D1 binding is unavailable");
  }

  async function read(owner: string, project: string, operationId: string): Promise<ResearchProviderKeyModelUseRow | null> {
    try {
      const row = await database.prepare(
        `SELECT ${OPERATION_COLUMNS} FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 LIMIT 1`,
      ).bind(owner, project, operationId).first<Record<string, unknown>>();
      return row === null ? null : decodeResearchProviderKeyModelUseRow(row);
    } catch (cause) {
      if (cause instanceof ResearchProviderKeyModelUseStoreError) throw cause;
      storage("model-use operation readback is unavailable", cause);
    }
  }

  return Object.freeze({
    read,
    async readStages(owner: string, project: string, operationId: string): Promise<readonly ResearchProviderKeyModelUseStageRow[]> {
      try {
        const result = await database.prepare(
          `SELECT ${STAGE_COLUMNS} FROM research_provider_key_model_use_stage_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 ORDER BY sequence_number ASC`,
        ).bind(owner, project, operationId).all<Record<string, unknown>>();
        if (!Array.isArray(result.results)) storage("model-use stage readback is invalid");
        return Object.freeze(result.results.map(decodeResearchProviderKeyModelUseStageRow));
      } catch (cause) {
        if (cause instanceof ResearchProviderKeyModelUseStoreError) throw cause;
        storage("model-use stage readback is unavailable", cause);
      }
    },
    async readUnresolved(owner: string, project: string): Promise<ResearchProviderKeyModelUseRow | null> {
      try {
        const row = await database.prepare(
          `SELECT ${OPERATION_COLUMNS} FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','UNCERTAIN') LIMIT 1`,
        ).bind(owner, project).first<Record<string, unknown>>();
        return row === null ? null : decodeResearchProviderKeyModelUseRow(row);
      } catch (cause) {
        if (cause instanceof ResearchProviderKeyModelUseStoreError) throw cause;
        storage("unresolved model-use operation readback is unavailable", cause);
      }
    },
    async insertIntent(input: ResearchProviderKeyModelUseIntent): Promise<boolean> {
      if (input.stages.length < 2 || input.stages.length > 4 || input.stages.some((stage, index) =>
        stage.sequence_number !== index || !(STAGES as readonly string[]).includes(stage.stage) ||
        !ROUTES.has(stage.route_ref) || !IDENTIFIER.test(stage.route_version) ||
        !SHA256.test(stage.prompt_sha256) || !SHA256.test(stage.schema_sha256) || !SHA256.test(stage.parameters_sha256) ||
        !SHA256.test(stage.probe_prompt_sha256) || !SHA256.test(stage.probe_schema_sha256) || !SHA256.test(stage.probe_parameters_sha256))) {
        storage("model-use stage plan is invalid");
      }
      const statements = [database.prepare(
        "INSERT INTO research_provider_key_model_use_operation (owner_id,project_id,provider_id,operation_id,key_operation_id," +
        "account_id,gateway_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256," +
        "configuration_basis_json," +
        "owner_credential_generation,project_generation,deployment_generation,expected_selection_revision," +
        "deadline_at," +
        "source_configuration_ref,source_configuration_sha256,planned_stage_set_sha256,plan_sha256,state,phase,created_at,updated_at) " +
        "SELECT ?1,?2,'openrouter',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,'ACCEPTED','INTENT',?21,?21 " +
        "FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "JOIN research_provider_key_configuration_operation k ON k.owner_id=?1 AND k.project_id=?2 " +
        "AND k.provider_id='openrouter' AND k.operation_id=?4 " +
        "WHERE p.project_id=?2 AND o.principal_ref=?1 AND p.generation=?13 AND k.state='CONFIGURED' " +
        "AND k.account_id=?5 AND k.gateway_id=?6 AND k.alias=?7 AND k.provider_config_id=?8 AND k.metadata_sha256=?9 " +
        "ON CONFLICT(owner_id,project_id,operation_id) DO NOTHING",
      ).bind(input.owner_id, input.project_id, input.operation_id, input.key_operation_id,
        input.account_id, input.gateway_id, input.alias, input.provider_config_id, input.configuration_metadata_sha256,
        input.request_sha256, input.configuration_basis_json, input.owner_credential_generation, input.project_generation,
        input.deployment_generation, input.expected_selection_revision, input.deadline_at, input.source_configuration_ref,
        input.source_configuration_sha256, input.planned_stage_set_sha256, input.plan_sha256, input.created_at)];
      for (const stage of input.stages) {
        statements.push(database.prepare(
          "INSERT INTO research_provider_key_model_use_stage_operation (owner_id,project_id,operation_id,sequence_number," +
          "stage,route_ref,route_version,prompt_sha256,schema_sha256,parameters_sha256,probe_prompt_sha256," +
          "probe_schema_sha256,probe_parameters_sha256,state,created_at,updated_at) " +
          "SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'PENDING',?14,?14 WHERE EXISTS (" +
          "SELECT 1 FROM research_provider_key_model_use_operation WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3) " +
          "ON CONFLICT(owner_id,project_id,operation_id,stage) DO NOTHING",
        ).bind(input.owner_id, input.project_id, input.operation_id, stage.sequence_number, stage.stage,
          stage.route_ref, stage.route_version, stage.prompt_sha256, stage.schema_sha256,
          stage.parameters_sha256, stage.probe_prompt_sha256, stage.probe_schema_sha256,
          stage.probe_parameters_sha256, input.created_at));
      }
      try {
        const result = await database.batch(statements);
        return result[0]?.meta.changes === 1;
      } catch (cause) {
        storage("model-use operation intent could not be recorded", cause);
      }
    },
    async transitionOperation(input: {
      readonly owner: string;
      readonly project: string;
      readonly operation_id: string;
      readonly expected_state: ResearchProviderKeyModelUseDbState;
      readonly expected_phase: ResearchProviderKeyModelUseDbPhase;
      readonly expected_active_stage: ResearchProviderKeyModelUseStage | null;
      readonly state: ResearchProviderKeyModelUseDbState;
      readonly phase: ResearchProviderKeyModelUseDbPhase;
      readonly active_stage: ResearchProviderKeyModelUseStage | null;
      readonly updated_at: string;
      readonly failure_code?: ResearchProviderKeyModelUseFailureCode | null;
      readonly target_configuration?: { readonly ref: string; readonly sha256: string; readonly json: string };
      readonly selection?: { readonly ref: string; readonly revision: number };
      readonly project_generation: number;
    }): Promise<boolean> {
      const failure = input.failure_code ?? null;
      const targetRef = input.target_configuration?.ref ?? null;
      const targetSha = input.target_configuration?.sha256 ?? null;
      const targetJson = input.target_configuration?.json ?? null;
      const selectedRef = input.selection?.ref ?? null;
      const selectionRevision = input.selection?.revision ?? null;
      try {
        const result = await database.prepare(
          "UPDATE research_provider_key_model_use_operation SET state=?1,phase=?2,active_stage=?3," +
          "failure_code=?4,target_configuration_ref=COALESCE(target_configuration_ref,?5)," +
          "target_configuration_sha256=COALESCE(target_configuration_sha256,?6)," +
          "target_configuration_json=COALESCE(target_configuration_json,?7)," +
          "selected_configuration_ref=COALESCE(selected_configuration_ref,?8)," +
          "selection_revision=COALESCE(selection_revision,?9),updated_at=?10 " +
          "WHERE owner_id=?11 AND project_id=?12 AND operation_id=?13 AND state=?14 AND phase=?15 " +
          "AND project_generation=?16 AND active_stage IS ?17 AND EXISTS (SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
          "WHERE p.project_id=?12 AND o.principal_ref=?11 AND p.generation=?16)",
        ).bind(input.state, input.phase, input.active_stage, failure, targetRef, targetSha, targetJson,
          selectedRef, selectionRevision, input.updated_at, input.owner, input.project,
          input.operation_id, input.expected_state, input.expected_phase, input.project_generation,
          input.expected_active_stage).run();
        return result.meta.changes === 1;
      } catch (cause) {
        storage("model-use operation transition could not be persisted", cause);
      }
    },
    async transitionStage(input: {
      readonly owner: string;
      readonly project: string;
      readonly operation_id: string;
      readonly stage: ResearchProviderKeyModelUseStage;
      readonly expected_state: ResearchProviderKeyModelUseStageDbState;
      readonly state: ResearchProviderKeyModelUseStageDbState;
      readonly expected_operation_state: ResearchProviderKeyModelUseDbState;
      readonly expected_operation_phase: ResearchProviderKeyModelUseDbPhase;
      readonly updated_at: string;
      readonly failure_code?: ResearchProviderKeyModelUseFailureCode | null;
      readonly pricing?: { readonly ref: string; readonly sha256: string };
      readonly preparation?: { readonly ref: string; readonly sha256: string };
      readonly qualification?: {
        readonly candidate_ref: string;
        readonly candidate_sha256: string;
        readonly qualification_ref: string;
        readonly qualification_sha256: string;
      };
      readonly project_generation: number;
    }): Promise<boolean> {
      const failure = input.failure_code ?? null;
      const pricingRef = input.pricing?.ref ?? null;
      const pricingSha = input.pricing?.sha256 ?? null;
      const preparationRef = input.preparation?.ref ?? null;
      const preparationSha = input.preparation?.sha256 ?? null;
      const qualification = input.qualification;
      try {
        const result = await database.prepare(
          "UPDATE research_provider_key_model_use_stage_operation SET state=?1,failure_code=?2," +
          "pricing_snapshot_ref=COALESCE(pricing_snapshot_ref,?3),pricing_snapshot_sha256=COALESCE(pricing_snapshot_sha256,?4)," +
          "preparation_ref=COALESCE(preparation_ref,?5),preparation_sha256=COALESCE(preparation_sha256,?6)," +
          "candidate_ref=COALESCE(candidate_ref,?7),candidate_sha256=COALESCE(candidate_sha256,?8)," +
          "qualification_ref=COALESCE(qualification_ref,?9),qualification_sha256=COALESCE(qualification_sha256,?10),updated_at=?11 " +
          "WHERE owner_id=?12 AND project_id=?13 AND operation_id=?14 AND stage=?15 AND state=?16 AND EXISTS (" +
          "SELECT 1 FROM research_provider_key_model_use_operation u JOIN project p ON p.project_id=u.project_id " +
          "JOIN project_owner o ON o.project_id=p.project_id WHERE u.owner_id=?12 AND u.project_id=?13 AND u.operation_id=?14 " +
          "AND u.project_generation=?17 AND o.principal_ref=?12 AND p.generation=?17 " +
          "AND u.state=?18 AND u.phase=?19 AND u.active_stage=?15 AND u.failure_code IS NULL)",
        ).bind(input.state, failure, pricingRef, pricingSha, preparationRef, preparationSha,
          qualification?.candidate_ref ?? null, qualification?.candidate_sha256 ?? null,
          qualification?.qualification_ref ?? null, qualification?.qualification_sha256 ?? null,
          input.updated_at, input.owner, input.project, input.operation_id, input.stage,
          input.expected_state, input.project_generation, input.expected_operation_state,
          input.expected_operation_phase).run();
        return result.meta.changes === 1;
      } catch (cause) {
        storage("model-use stage transition could not be persisted", cause);
      }
    },
  });
}
