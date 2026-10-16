import type {
  ResearchCatalogModelUseFailureCode,
  ResearchCatalogModelUsePhase,
  ResearchCatalogModelUseState,
} from "@eliotr/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MODEL_ID = /^(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}|[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255})$/u;
const CONFIG_REF = /^rpmc-[a-f0-9]{64}$/u;

export type ResearchCatalogModelUseDbState = Uppercase<ResearchCatalogModelUseState>;
export type ResearchCatalogModelUseDbPhase = Uppercase<ResearchCatalogModelUsePhase>;

export interface ResearchCatalogModelUseAuthorizationRow {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly provider_id: string;
  readonly provider_operation_id: string | null;
  readonly route_provider_id: string;
  readonly model_id: string;
  readonly account_id: string | null;
  readonly gateway_id: string | null;
  readonly alias: string | null;
  readonly provider_config_id: string | null;
  readonly configuration_metadata_sha256: string | null;
  readonly request_sha256: string;
  readonly owner_credential_generation: string;
  readonly project_generation: number;
  readonly deployment_generation: string;
  readonly expected_selection_revision: number | null;
  readonly source_configuration_ref: string | null;
  readonly source_configuration_sha256: string | null;
  readonly state: ResearchCatalogModelUseDbState;
  readonly phase: ResearchCatalogModelUseDbPhase;
  readonly selected_configuration_ref: string | null;
  readonly selected_configuration_sha256: string | null;
  readonly selection_revision: number | null;
  readonly failure_code: ResearchCatalogModelUseFailureCode | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ResearchCatalogModelUseIntent {
  readonly owner_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly provider_id: string;
  readonly provider_operation_id: string | null;
  readonly route_provider_id: string;
  readonly model_id: string;
  readonly account_id: string | null;
  readonly gateway_id: string | null;
  readonly alias: string | null;
  readonly provider_config_id: string | null;
  readonly configuration_metadata_sha256: string | null;
  readonly request_sha256: string;
  readonly owner_credential_generation: string;
  readonly project_generation: number;
  readonly deployment_generation: string;
  readonly expected_selection_revision: number | null;
  readonly source_configuration_ref: string | null;
  readonly source_configuration_sha256: string | null;
  readonly created_at: string;
}

export class ResearchCatalogModelUseStoreError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchCatalogModelUseStoreError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ResearchCatalogModelUseStoreError(message, cause);
}

function record(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("catalog model-use row is invalid");
  return raw as Record<string, unknown>;
}

function string(value: unknown, label: string, pattern = IDENTIFIER): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail(`${label} is corrupt`);
  return value;
}

function nullableString(value: unknown, label: string, pattern = IDENTIFIER): string | null {
  return value === null ? null : string(value, label, pattern);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) return fail(`${label} is corrupt`);
  return value;
}

const STATES = new Set<ResearchCatalogModelUseDbState>([
  "ACCEPTED", "PREPARING", "QUALIFYING", "IMPORTING", "SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT",
]);
const PHASES = new Set<ResearchCatalogModelUseDbPhase>([
  "INTENT", "PROVIDER_RESOLUTION", "NATIVE_PREPARE", "QUALIFICATION", "CONFIGURATION_IMPORT", "SELECTION_READBACK", "COMPLETE",
]);
const FAILURES = new Set<ResearchCatalogModelUseFailureCode>([
  "PROVIDER_NOT_CONFIGURED", "MODEL_NOT_SUPPORTED", "SERVER_POLICY_UNAVAILABLE", "PREPARATION_REJECTED",
  "QUALIFICATION_NO_EFFECT", "QUALIFICATION_OUTCOME_UNCERTAIN", "NATIVE_RECEIPT_INVALID",
  "SELECTION_CAS_CONFLICT", "AUTHORITY_CHANGED", "STORAGE_UNAVAILABLE",
]);

export function decodeResearchCatalogModelUseAuthorizationRow(raw: unknown): ResearchCatalogModelUseAuthorizationRow {
  const row = record(raw);
  const state = row.state;
  const phase = row.phase;
  const failure = row.failure_code;
  const projectGeneration = row.project_generation;
  const expectedRevision = row.expected_selection_revision;
  const selectionRevision = row.selection_revision;
  if (typeof state !== "string" || !STATES.has(state as ResearchCatalogModelUseDbState) ||
      typeof phase !== "string" || !PHASES.has(phase as ResearchCatalogModelUseDbPhase) ||
      typeof projectGeneration !== "number" || !Number.isSafeInteger(projectGeneration) || projectGeneration < 1 ||
      !(expectedRevision === null || (typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) ||
      !(selectionRevision === null || (typeof selectionRevision === "number" && Number.isSafeInteger(selectionRevision) && selectionRevision >= 1)) ||
      !(failure === null || (typeof failure === "string" && FAILURES.has(failure as ResearchCatalogModelUseFailureCode)))) {
    return fail("catalog model-use state is corrupt");
  }
  const selectedRef = nullableString(row.selected_configuration_ref, "selected configuration ref", CONFIG_REF);
  const selectedSha = nullableString(row.selected_configuration_sha256, "selected configuration digest", DIGEST);
  const sourceRef = nullableString(row.source_configuration_ref, "source configuration ref", CONFIG_REF);
  const sourceSha = nullableString(row.source_configuration_sha256, "source configuration digest", DIGEST);
  if ((sourceRef === null) !== (sourceSha === null) || (sourceRef === null) !== (expectedRevision === null) ||
      (selectedRef === null) !== (selectedSha === null) || (selectedRef === null) !== (selectionRevision === null) ||
      (selectedRef !== null && selectedRef !== `rpmc-${selectedSha}`) ||
      (state === "SELECTED" && (phase !== "COMPLETE" || selectedRef === null || failure !== null)) ||
      (state !== "SELECTED" && selectedRef !== null) ||
      ((state === "BLOCKED" || state === "UNCERTAIN" || state === "CONFLICT") !== (failure !== null)) ||
      (state === "UNCERTAIN" && failure !== "QUALIFICATION_OUTCOME_UNCERTAIN") ||
      (state === "CONFLICT" && failure !== "SELECTION_CAS_CONFLICT")) {
    return fail("catalog model-use configuration binding is corrupt");
  }
  const providerOperationId = nullableString(row.provider_operation_id, "provider operation id", UUID);
  const accountId = nullableString(row.account_id, "provider account id", /^[A-Fa-f0-9]{32}$/u);
  const gatewayId = nullableString(row.gateway_id, "gateway id", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
  const alias = nullableString(row.alias, "provider alias", /^eliotr-[0-9a-f]{48}$/u);
  const providerConfigId = nullableString(row.provider_config_id, "provider config id", /^[A-Za-z0-9._:@/-]{1,256}$/u);
  const metadataSha = nullableString(row.configuration_metadata_sha256, "provider metadata digest", DIGEST);
  if ((providerOperationId === null) !== (accountId === null) || (providerOperationId === null) !== (gatewayId === null) ||
      (providerOperationId === null) !== (alias === null) || (providerOperationId === null) !== (providerConfigId === null) ||
      (providerOperationId === null) !== (metadataSha === null)) return fail("catalog model-use provider binding is corrupt");
  return Object.freeze({
    owner_id: string(row.owner_id, "owner id"), project_id: string(row.project_id, "project id"),
    operation_id: string(row.operation_id, "operation id", UUID), provider_id: string(row.provider_id, "provider id"),
    provider_operation_id: providerOperationId, route_provider_id: string(row.route_provider_id, "route provider id"),
    model_id: string(row.model_id, "model id", MODEL_ID), account_id: accountId, gateway_id: gatewayId, alias,
    provider_config_id: providerConfigId, configuration_metadata_sha256: metadataSha,
    request_sha256: string(row.request_sha256, "request digest", DIGEST),
    owner_credential_generation: string(row.owner_credential_generation, "owner credential generation"),
    project_generation: projectGeneration, deployment_generation: string(row.deployment_generation, "deployment generation"),
    expected_selection_revision: expectedRevision as number | null, source_configuration_ref: sourceRef,
    source_configuration_sha256: sourceSha, state: state as ResearchCatalogModelUseDbState,
    phase: phase as ResearchCatalogModelUseDbPhase, selected_configuration_ref: selectedRef,
    selected_configuration_sha256: selectedSha, selection_revision: selectionRevision as number | null,
    failure_code: failure as ResearchCatalogModelUseFailureCode | null,
    created_at: timestamp(row.created_at, "created_at"), updated_at: timestamp(row.updated_at, "updated_at"),
  });
}

export function createD1ResearchCatalogModelUseStore(database: D1Database) {
  if (database === undefined || typeof database.prepare !== "function") fail("Core database is unavailable");
  return Object.freeze({
    async read(ownerId: string, projectId: string, operationId: string): Promise<ResearchCatalogModelUseAuthorizationRow | null> {
      try {
        const row = await database.prepare(
          "SELECT owner_id,project_id,operation_id,provider_id,provider_operation_id,route_provider_id,model_id,account_id," +
          "gateway_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256,owner_credential_generation," +
          "project_generation,deployment_generation,expected_selection_revision,source_configuration_ref,source_configuration_sha256," +
          "state,phase,selected_configuration_ref,selected_configuration_sha256,selection_revision,failure_code,created_at,updated_at " +
          "FROM research_catalog_model_use_authorization WHERE owner_id=?1 AND project_id=?2 AND operation_id=?3 LIMIT 1",
        ).bind(ownerId, projectId, operationId).first<Record<string, unknown>>();
        return row === null ? null : decodeResearchCatalogModelUseAuthorizationRow(row);
      } catch (cause) {
        if (cause instanceof ResearchCatalogModelUseStoreError) throw cause;
        fail("catalog model-use authorization readback is unavailable", cause);
      }
    },
    async readUnresolved(ownerId: string, projectId: string): Promise<ResearchCatalogModelUseAuthorizationRow | null> {
      try {
        const row = await database.prepare(
          "SELECT owner_id,project_id,operation_id,provider_id,provider_operation_id,route_provider_id,model_id,account_id," +
          "gateway_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256,owner_credential_generation," +
          "project_generation,deployment_generation,expected_selection_revision,source_configuration_ref,source_configuration_sha256," +
          "state,phase,selected_configuration_ref,selected_configuration_sha256,selection_revision,failure_code,created_at,updated_at " +
          "FROM research_catalog_model_use_authorization WHERE owner_id=?1 AND project_id=?2 AND " +
          "state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','UNCERTAIN') LIMIT 1",
        ).bind(ownerId, projectId).first<Record<string, unknown>>();
        return row === null ? null : decodeResearchCatalogModelUseAuthorizationRow(row);
      } catch (cause) {
        if (cause instanceof ResearchCatalogModelUseStoreError) throw cause;
        fail("unresolved catalog model-use authorization is unavailable", cause);
      }
    },
    async insertIntent(input: ResearchCatalogModelUseIntent): Promise<boolean> {
      try {
        const result = await database.prepare(
          "INSERT INTO research_catalog_model_use_authorization (owner_id,project_id,operation_id,provider_id,provider_operation_id," +
          "route_provider_id,model_id,account_id,gateway_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256," +
          "owner_credential_generation,project_generation,deployment_generation,expected_selection_revision,source_configuration_ref," +
          "source_configuration_sha256,state,phase,created_at,updated_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,'ACCEPTED','INTENT',?20,?20) " +
          "ON CONFLICT(owner_id,project_id,operation_id) DO NOTHING",
        ).bind(input.owner_id, input.project_id, input.operation_id, input.provider_id, input.provider_operation_id,
          input.route_provider_id, input.model_id, input.account_id, input.gateway_id, input.alias, input.provider_config_id,
          input.configuration_metadata_sha256, input.request_sha256, input.owner_credential_generation, input.project_generation,
          input.deployment_generation, input.expected_selection_revision, input.source_configuration_ref,
          input.source_configuration_sha256, input.created_at).run();
        return result.meta.changes === 1;
      } catch (cause) {
        fail("catalog model-use intent could not be persisted", cause);
      }
    },
    async transition(input: {
      readonly owner_id: string; readonly project_id: string; readonly operation_id: string;
      readonly expected_state: ResearchCatalogModelUseDbState; readonly expected_phase: ResearchCatalogModelUseDbPhase;
      readonly state: ResearchCatalogModelUseDbState; readonly phase: ResearchCatalogModelUseDbPhase;
      readonly updated_at: string; readonly failure_code?: ResearchCatalogModelUseFailureCode | null;
      readonly selection?: Readonly<{ configuration_ref: string; configuration_sha256: string; revision: number }>;
    }): Promise<boolean> {
      const failure = input.failure_code ?? null;
      const selection = input.selection;
      try {
        const result = await database.prepare(
          "UPDATE research_catalog_model_use_authorization SET state=?1,phase=?2,failure_code=?3," +
          "selected_configuration_ref=COALESCE(selected_configuration_ref,?4)," +
          "selected_configuration_sha256=COALESCE(selected_configuration_sha256,?5)," +
          "selection_revision=COALESCE(selection_revision,?6),updated_at=?7 " +
          "WHERE owner_id=?8 AND project_id=?9 AND operation_id=?10 AND state=?11 AND phase=?12",
        ).bind(input.state, input.phase, failure, selection?.configuration_ref ?? null,
          selection?.configuration_sha256 ?? null, selection?.revision ?? null, input.updated_at,
          input.owner_id, input.project_id, input.operation_id, input.expected_state, input.expected_phase).run();
        return result.meta.changes === 1;
      } catch (cause) {
        fail("catalog model-use state transition could not be persisted", cause);
      }
    },
  });
}
