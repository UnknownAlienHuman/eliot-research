import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { decodeProviderNativeModelPreparation } from "@eliotr/cloudflare-native-models";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { CatalogQualificationGatewayLogReader } from "./research-catalog-model-v2-failure-reconciliation.js";
import {
  createResearchProviderKeyModelUseStore,
  type ResearchProviderKeyModelUseRow,
} from "./research-provider-key-model-use-store.js";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const LOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export type ResearchProviderKeyModelUseUnverifiedExecutionReconciler =
  (row: ResearchProviderKeyModelUseRow) => Promise<void>;

/**
 * Appends a server-authenticated successful-execution receipt without treating
 * HTTP success as semantic qualification. The injected reader must be the
 * existing bounded Gateway metadata reader, backed by the server control token.
 */
export function createResearchProviderKeyModelUseUnverifiedExecutionReconciler(input: Readonly<{
  database: D1Database;
  context: AuthenticatedRequestContext;
  deployment_generation?: string;
  read_logs: CatalogQualificationGatewayLogReader;
  now?: () => string;
}>): ResearchProviderKeyModelUseUnverifiedExecutionReconciler {
  const store = createResearchProviderKeyModelUseStore(input.database);
  return async (supplied: ResearchProviderKeyModelUseRow): Promise<void> => {
      if (input.context.client_class !== "owner_pwa" || input.context.principal_ref !== supplied.owner_id ||
          input.context.request === undefined || input.context.request.signal.aborted ||
            input.context.credential_generation.length === 0 ||
          (input.context.access?.credential_generation !== undefined &&
            input.context.access.credential_generation !== input.context.credential_generation)) return;
      const row = await store.read(supplied.owner_id, supplied.project_id, supplied.operation_id);
      if (row === null || row.state !== "UNCERTAIN" || row.phase !== "NATIVE_QUALIFY" ||
          row.failure_code !== "QUALIFICATION_OUTCOME_UNCERTAIN" || row.active_stage === null ||
          row.owner_id !== input.context.principal_ref || row.operation_id !== supplied.operation_id ||
          row.project_id !== supplied.project_id) return;

      const owner = await input.database.prepare(
        "SELECT p.generation,o.principal_ref FROM project p JOIN project_owner o ON o.project_id=p.project_id WHERE p.project_id=?1 LIMIT 1",
      ).bind(row.project_id).first<{ generation: number; principal_ref: string }>();
      if (owner?.generation !== row.project_generation || owner.principal_ref !== row.owner_id) return;
      const [keyAuthority, stages, preparationRow, attempt] = await Promise.all([
        input.database.prepare(
          "SELECT account_id,gateway_id,alias,provider_config_id,metadata_sha256,state,model_registration_mode,model_ids_json " +
          "FROM research_provider_key_model_use_key_authority WHERE owner_id=?1 AND project_id=?2 AND provider_id='openrouter' AND operation_id=?3 LIMIT 1",
        ).bind(row.owner_id, row.project_id, row.key_operation_id)
          .first<{ account_id: string; gateway_id: string; alias: string; provider_config_id: string; metadata_sha256: string;
            state: string; model_registration_mode: string | null; model_ids_json: string | null }>(),
        store.readStages(row.owner_id, row.project_id, row.operation_id),
        input.database.prepare(
          "SELECT preparation_ref,preparation_sha256,preparation_json FROM provider_native_model_preparation " +
          "WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 AND stage=?4 LIMIT 1",
        ).bind(row.owner_id, row.project_id, row.operation_id, row.active_stage)
          .first<{ preparation_ref: string; preparation_sha256: string; preparation_json: string }>(),
        input.database.prepare(
          "SELECT preparation_ref,preparation_sha256,state,observation_ref,candidate_ref,qualification_ref,started_at,completed_at " +
          "FROM provider_native_model_qualification_attempt WHERE owner_ref=?1 AND project_id=?2 AND owner_operation_id=?3 AND stage=?4 LIMIT 1",
        ).bind(row.owner_id, row.project_id, row.operation_id, row.active_stage)
          .first<{ preparation_ref: string; preparation_sha256: string; state: string; observation_ref: string | null; candidate_ref: string | null; qualification_ref: string | null; started_at: string; completed_at: string | null }>(),
      ]);
      const stage = stages.find((item) => item.stage === row.active_stage);
      if (keyAuthority === null || keyAuthority.state !== "CONFIGURED" || keyAuthority.account_id !== row.account_id ||
          keyAuthority.gateway_id !== row.gateway_id || keyAuthority.alias !== row.alias ||
          keyAuthority.provider_config_id !== row.provider_config_id ||
          keyAuthority.metadata_sha256 !== row.configuration_metadata_sha256 || stage === undefined ||
          stage.state !== "UNCERTAIN" || stage.failure_code !== "QUALIFICATION_OUTCOME_UNCERTAIN" ||
          stage.preparation_ref === null || stage.preparation_sha256 === null || stage.candidate_ref !== null ||
          stage.qualification_ref !== null || preparationRow === null || attempt === null ||
          attempt.state !== "STARTED" || attempt.observation_ref !== null || attempt.candidate_ref !== null ||
          attempt.qualification_ref !== null || attempt.completed_at !== null ||
          attempt.preparation_ref !== preparationRow.preparation_ref || attempt.preparation_sha256 !== preparationRow.preparation_sha256 ||
          stage.preparation_ref !== preparationRow.preparation_ref || stage.preparation_sha256 !== preparationRow.preparation_sha256 ||
          preparationRow.preparation_ref !== `provider-native-model-preparation-${preparationRow.preparation_sha256}` ||
          !/^[a-f0-9]{64}$/u.test(preparationRow.preparation_sha256)) return;

      const preparation = decodeProviderNativeModelPreparation(JSON.parse(preparationRow.preparation_json) as unknown);
      if (canonicalModelGatewayJson(preparation) !== preparationRow.preparation_json ||
          await modelGatewaySha256(preparationRow.preparation_json) !== preparationRow.preparation_sha256 ||
          preparation.owner_ref !== row.owner_id || preparation.project_id !== row.project_id ||
          preparation.owner_operation_id !== row.operation_id || preparation.stage !== row.active_stage ||
          preparation.key_binding.operation_id !== row.key_operation_id || preparation.key_binding.account_id !== row.account_id ||
          preparation.key_binding.gateway_id !== row.gateway_id || preparation.key_binding.alias !== row.alias ||
          preparation.key_binding.provider_config_id !== row.provider_config_id ||
          preparation.key_binding.configuration_metadata_sha256 !== row.configuration_metadata_sha256 ||
          preparation.transport_policy.provider !== "openrouter" ||
          stage.pricing_snapshot_ref !== preparation.pricing_snapshot_ref ||
          stage.pricing_snapshot_sha256 !== preparation.pricing_snapshot_sha256 ||
          preparation.probe_deployment.route_ref !== stage.route_ref ||
          preparation.probe_deployment.route_version !== stage.route_version ||
          preparation.probe_parameters_sha256 !== stage.probe_parameters_sha256) return;

      const read = await input.read_logs({ account_id: row.account_id, gateway_id: row.gateway_id,
        operation_id: row.operation_id, stage: stage.stage, prepared_at: preparation.prepared_at,
        expires_at: preparation.preparation_expires_at });
      if (read === null || read.account_id !== row.account_id || read.gateway_id !== row.gateway_id ||
          read.logs.length < 1 || read.logs.length > 50) return;
      const expectedMetadata = Object.freeze({ operation_id: row.operation_id,
        parameters_digest: preparation.probe_parameters_sha256, pricing_snapshot_ref: preparation.pricing_snapshot_ref,
        prompt_generation: preparation.probe_deployment.prompt_generation, route_ref: preparation.probe_deployment.route_ref });
      const matching: RecordValue[] = [];
      for (const item of read.logs) {
        if (!record(item)) return;
        let metadata: unknown = item.metadata;
        if (typeof metadata === "string") {
          try { metadata = JSON.parse(metadata) as unknown; } catch { return; }
        }
        if (!record(metadata) || metadata.operation_id !== row.operation_id || typeof metadata.pricing_snapshot_ref !== "string") return;
        if (metadata.pricing_snapshot_ref === preparation.pricing_snapshot_ref) matching.push({ ...item, metadata });
        else if (item.success !== true) return;
      }
      if (matching.length !== 1) return;
      const log = matching[0];
      if (log === undefined || typeof log.id !== "string" || !LOG_ID.test(log.id) || log.status_code !== 200 ||
          log.success !== true || log.cached !== false || log.provider !== "openrouter" ||
          log.model !== preparation.transport_policy.model || typeof log.created_at !== "string") return;
      const metadata = log.metadata;
      if (!record(metadata) || canonicalModelGatewayJson(metadata) !== canonicalModelGatewayJson(expectedMetadata)) return;
      const loggedMs = Date.parse(log.created_at);
      const startedMs = Date.parse(attempt.started_at);
      const preparedMs = Date.parse(preparation.prepared_at);
      const expiresMs = Date.parse(preparation.preparation_expires_at);
      const observedAt = (input.now ?? (() => new Date().toISOString()))();
      const observedMs = Date.parse(observedAt);
      if (![loggedMs, startedMs, preparedMs, expiresMs, observedMs].every(Number.isFinite) ||
          new Date(loggedMs).toISOString() !== log.created_at || new Date(observedMs).toISOString() !== observedAt ||
          loggedMs < startedMs || loggedMs < preparedMs || loggedMs >= expiresMs || loggedMs > observedMs) return;

      const receipt = Object.freeze({
        protocol: "eliotr.provider-key-model-use-unverified-execution.v1",
        owner_id: row.owner_id, project_id: row.project_id, operation_id: row.operation_id, stage: stage.stage,
        key_operation_id: row.key_operation_id, provider_operation_id: row.key_operation_id,
        provider_id: "openrouter", provider_slug: "openrouter",
        model_id: preparation.transport_policy.model, request_sha256: row.request_sha256,
        account_id: row.account_id, gateway_id: row.gateway_id, alias: row.alias,
        provider_config_id: row.provider_config_id, configuration_metadata_sha256: row.configuration_metadata_sha256,
        owner_credential_generation: row.owner_credential_generation, project_generation: row.project_generation,
        deployment_generation: row.deployment_generation,
        reader_credential_generation: input.context.credential_generation,
        ...(input.deployment_generation === undefined ? {} : { reader_deployment_generation: input.deployment_generation }),
        preparation_ref: preparationRow.preparation_ref, preparation_sha256: preparationRow.preparation_sha256,
        pricing_snapshot_ref: preparation.pricing_snapshot_ref, pricing_snapshot_sha256: preparation.pricing_snapshot_sha256,
        route_ref: preparation.probe_deployment.route_ref, route_version: preparation.probe_deployment.route_version,
        prompt_generation: preparation.probe_deployment.prompt_generation,
        schema_generation: preparation.probe_deployment.schema_generation,
        parameters_digest: preparation.probe_deployment.parameters_digest,
        gateway_metadata: expectedMetadata,
        gateway_log_id: log.id,
        gateway_log: Object.freeze({ id: log.id, created_at: log.created_at, provider: log.provider,
          model: log.model, status_code: log.status_code, success: true, cached: false }),
        gateway_authenticated: true,
        gateway_page: Object.freeze({ complete: true, page: 1, per_page: 50,
          result_count: read.logs.length, total_count: read.logs.length, matched_stage_log_count: 1 }),
        http_status: 200, success: true, gateway_success: true, cached: false,
        qualification: "UNVERIFIED", native_observation_retained: false,
        provider_effects: "UNKNOWN", classification: "EXECUTION_COMPLETED_QUALIFICATION_UNVERIFIED",
        original_state: row.state, original_phase: row.phase, original_active_stage: row.active_stage,
        original_failure_code: row.failure_code, original_updated_at: row.updated_at,
        logged_at: new Date(loggedMs).toISOString(), observed_at: observedAt,
      });
      const receiptJson = canonicalModelGatewayJson(receipt);
      const receiptSha = await modelGatewaySha256(receiptJson);
      await store.appendUnverifiedExecution({ owner_id: row.owner_id, project_id: row.project_id,
        operation_id: row.operation_id, stage: stage.stage, preparation_ref: preparationRow.preparation_ref,
        preparation_sha256: preparationRow.preparation_sha256, account_id: row.account_id, gateway_id: row.gateway_id,
        gateway_log_id: log.id, http_status: 200, logged_at: receipt.logged_at, observed_at: observedAt,
        receipt_json: receiptJson, receipt_sha256: receiptSha, project_generation: row.project_generation });
  };
}
