import {
  type ResearchProviderKeyModelUseFailureCode,
  type ResearchProviderKeyModelUseReceipt,
  type ResearchProviderKeyModelUseRequest,
} from "@eliotr/contracts";
import {
  ProviderNativeModelAuthorityError,
  type ProviderNativeModelSelectionV1,
} from "@eliotr/cloudflare-native-models";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "@eliotr/cloudflare-ai";
import {
  decodeResearchProjectModelConfigurationBundle,
  type ResearchProjectModelSelection,
} from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import {
  ResearchProviderKeyConfigurationError,
  type ResearchProviderKeyConfigurationService,
} from "./research-provider-key-configuration-service.js";
import {
  ResearchProjectModelConfigurationAuthorityError,
  type ResearchProjectModelConfigurationService,
  type SelectedResearchProjectConfiguration,
} from "./research-project-configuration.js";
import {
  createResearchProviderNativeModelAuthority,
} from "./research-provider-native-model-authority.js";
import {
  createResearchProviderKeyModelPricingObserver,
  ResearchProviderKeyModelPricingError,
} from "./research-provider-key-model-pricing.js";
import {
  createD1ResearchProviderKeyModelPriceObservationStore,
  ResearchProviderKeyModelPriceObservationStoreError,
} from "./research-provider-key-model-price-observation-store.js";
import {
  buildResearchProviderKeyModelUseTarget,
  createResearchProviderKeyModelUseBasis,
  deploymentForStage,
  parseResearchProviderKeyModelUseBasis,
  probeDeploymentForStage,
  ResearchProviderKeyModelUsePlanError,
  type ResearchProviderKeyModelUseBasisV1,
} from "./research-provider-key-model-use-plan.js";
import {
  createResearchProviderKeyModelNativeProbeExecutor,
  ResearchProviderKeyModelProbeExecutorError,
} from "./research-provider-key-model-use-executor.js";
import {
  createResearchProviderKeyModelUseStore,
  type ResearchProviderKeyModelUseRow,
  type ResearchProviderKeyModelUseStage,
} from "./research-provider-key-model-use-store.js";
import { readResearchProviderKeyModelUseNativeScope } from "./research-provider-key-model-use-current-scope.js";
import {
  createResearchProviderKeyModelUseProgress,
  ResearchProviderKeyModelUseServiceError,
  readResearchProviderKeyModelUseProjectGeneration,
  readResearchProviderKeyModelUseOperation,
  requireResearchProviderKeyModelUseOwner,
  sameResearchProviderKeyModelUseSourceSelection,
} from "./research-provider-key-model-use-progress.js";
export { ResearchProviderKeyModelUseServiceError };

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_USE_WINDOW_MS = 10 * 60 * 1000;

function unavailable(cause?: unknown): never {
  throw new ResearchProviderKeyModelUseServiceError(
    "PROVIDER_KEY_MODEL_USE_UNAVAILABLE", 503, "Model-key check/use is temporarily unavailable", true, cause,
  );
}

export interface ResearchProviderKeyModelUseService {
  start(keyOperationId: string, request: ResearchProviderKeyModelUseRequest): Promise<ResearchProviderKeyModelUseReceipt>;
  read(operationId: string): Promise<ResearchProviderKeyModelUseReceipt>;
}

export function createResearchProviderKeyModelUseService(input: {
  readonly env: Env;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly key_configuration: ResearchProviderKeyConfigurationService;
  readonly project_configuration: ResearchProjectModelConfigurationService;
  readonly now?: () => number;
  readonly fetcher?: typeof fetch;
}): ResearchProviderKeyModelUseService {
  if (input.env.CORE_DB === undefined || input.project_id.length === 0 ||
      typeof input.key_configuration?.readConfiguredOperation !== "function" ||
      typeof input.project_configuration?.readSelected !== "function") unavailable();
  const now = input.now ?? (() => Date.now());
  const store = createResearchProviderKeyModelUseStore(input.env.CORE_DB);
  const progress = createResearchProviderKeyModelUseProgress(store, now);
  const { mapReceipt, transitionOperation, transitionStage, markFailure } = progress;
  const observations = createD1ResearchProviderKeyModelPriceObservationStore(input.env.CORE_DB);
  const pricing = createResearchProviderKeyModelPricingObserver({
    database: input.env.CORE_DB,
    observation_store: observations,
    readCurrentOperation: async (operationId) => {
      const current = await store.read(input.context.principal_ref, input.project_id, operationId);
      if (current === null || current.state !== "PREPARING" || current.phase !== "FREE_PRICE_CHECK" ||
          current.active_stage === null) return null;
      const basis = parseResearchProviderKeyModelUseBasis(current.configuration_basis_json);
      const planned = basis.stages.find((stage) => stage.stage === current.active_stage);
      if (planned === undefined) return null;
      const live = await assertCurrent(current, planned.stage);
      if (live === null) return null;
      return Object.freeze({
        operation: live,
        route: Object.freeze({ stage: planned.stage, route_ref: planned.route_ref,
          route_version: planned.route_version, provider: "openrouter" as const,
          exact_model_id: "stealth/space-bunny-alpha" as const }),
      });
    },
  });
  const native = createResearchProviderNativeModelAuthority({
    env: input.env,
    current_scope: async (request) => {
      if (request.owner_ref !== input.context.principal_ref || request.project_id !== input.project_id) return null;
      const scope = await readResearchProviderKeyModelUseNativeScope(input.env.CORE_DB, request);
      if (scope === null) return null;
      const operation = await store.read(request.owner_ref, request.project_id, request.owner_operation_id);
      if (operation === null || operation.owner_credential_generation !== input.context.credential_generation ||
          operation.deployment_generation !== input.env.DEPLOYMENT_GENERATION || input.context.request.signal.aborted) return null;
      return scope;
    },
    readConfiguredOperation: async (request) => {
      if (request.owner_ref !== input.context.principal_ref || request.project_id !== input.project_id) return null;
      return input.key_configuration.readConfiguredOperation(input.context, input.project_id, request.operation_id);
    },
  });

  async function assertCurrent(
    row: ResearchProviderKeyModelUseRow,
    stage?: ResearchProviderKeyModelUseStage,
  ): Promise<ResearchProviderKeyModelUseRow | null> {
    requireResearchProviderKeyModelUseOwner(input.context);
    if (row.owner_id !== input.context.principal_ref || row.project_id !== input.project_id ||
        row.owner_credential_generation !== input.context.credential_generation ||
        row.deployment_generation !== input.env.DEPLOYMENT_GENERATION ||
        (stage !== undefined && row.active_stage !== stage) || Date.parse(row.deadline_at) <= now()) return null;
    const projectGeneration = await readResearchProviderKeyModelUseProjectGeneration(input.env.CORE_DB, row.owner_id, row.project_id);
    if (projectGeneration !== row.project_generation) return null;
    let key: Awaited<ReturnType<ResearchProviderKeyConfigurationService["readConfiguredOperation"]>>;
    try { key = await input.key_configuration.readConfiguredOperation(input.context, input.project_id, row.key_operation_id); }
    catch { return null; }
    if (key.owner_id !== row.owner_id || key.project_id !== row.project_id || key.operation_id !== row.key_operation_id ||
        key.provider_id !== "openrouter" || key.account_id !== row.account_id || key.gateway_id !== row.gateway_id ||
        key.alias !== row.alias || key.provider_config_id !== row.provider_config_id ||
        key.metadata_sha256 !== row.configuration_metadata_sha256) return null;
    let selected: SelectedResearchProjectConfiguration | null;
    try { selected = await input.project_configuration.readSelected(input.context, input.project_id); }
    catch { return null; }
    if (row.state === "SELECTED") return row;
    if (row.state === "IMPORTING" && row.target_configuration_ref !== null &&
        selected?.configuration_ref === row.target_configuration_ref) return row;
    if (!sameResearchProviderKeyModelUseSourceSelection(selected, row)) return null;
    return row;
  }

  async function createIntent(keyOperationId: string, request: ResearchProviderKeyModelUseRequest): Promise<ResearchProviderKeyModelUseRow> {
    requireResearchProviderKeyModelUseOwner(input.context);
    if (!OPERATION_ID.test(keyOperationId)) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_INPUT_INVALID", 400,
        "Provider-key operation ID is invalid");
    }
    const unresolved = await store.readUnresolved(input.context.principal_ref, input.project_id);
    if (unresolved !== null && unresolved.operation_id !== request.operation_id) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_OPERATION_UNRESOLVED", 409,
        "Another model-key use operation is unresolved; reconcile that operation before starting another");
    }
    let key: Awaited<ReturnType<ResearchProviderKeyConfigurationService["readConfiguredOperation"]>>;
    try { key = await input.key_configuration.readConfiguredOperation(input.context, input.project_id, keyOperationId); }
    catch (cause) {
      if (cause instanceof ResearchProviderKeyConfigurationError) {
        throw new ResearchProviderKeyModelUseServiceError(cause.code, cause.status, cause.message, cause.retryable, cause);
      }
      unavailable(cause);
    }
    const selected = await input.project_configuration.readSelected(input.context, input.project_id);
    if ((selected?.selection_revision ?? null) !== request.expected_selection_revision) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_SELECTION_CAS_CONFLICT", 409,
        "Selected model configuration changed; refresh it before checking and using this key");
    }
    const generation = await readResearchProviderKeyModelUseProjectGeneration(input.env.CORE_DB, key.owner_id, input.project_id);
    let basis: ResearchProviderKeyModelUseBasisV1;
    try {
      basis = await createResearchProviderKeyModelUseBasis({ env: input.env, selected, key,
        operation_id: request.operation_id, database: input.env.CORE_DB });
    } catch (cause) {
      if (cause instanceof ResearchProviderKeyModelUsePlanError) {
        throw new ResearchProviderKeyModelUseServiceError(`PROVIDER_KEY_MODEL_USE_${cause.code}`, 409, cause.message, false, cause);
      }
      unavailable(cause);
    }
    const basisJson = canonicalModelGatewayJson(basis);
    if (new TextEncoder().encode(basisJson).byteLength > 524_288) {
      throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_SERVER_POLICY_UNAVAILABLE", 409,
        "The installed model configuration exceeds the immutable check/use bound");
    }
    const requestSha = await modelGatewaySha256(canonicalModelGatewayJson({
      protocol: request.protocol,
      operation_id: request.operation_id,
      key_operation_id: keyOperationId,
      expected_selection_revision: request.expected_selection_revision,
    }));
    const stageSetSha = await modelGatewaySha256(canonicalModelGatewayJson(basis.stages.map((stage) => ({
      sequence_number: stage.sequence_number, stage: stage.stage, route_ref: stage.route_ref, route_version: stage.route_version,
      prompt_sha256: stage.prompt_sha256, schema_sha256: stage.schema_sha256, parameters_sha256: stage.parameters_sha256,
      probe_prompt_sha256: stage.probe_prompt_sha256, probe_schema_sha256: stage.probe_schema_sha256,
      probe_parameters_sha256: stage.probe_parameters_sha256,
    }))));
    const createdAt = new Date(now()).toISOString();
    const deadlineAt = new Date(Date.parse(createdAt) + MAX_USE_WINDOW_MS).toISOString();
    const planSha = await modelGatewaySha256(canonicalModelGatewayJson({
      protocol: "eliotr.research.provider-key-model-use-plan.v1",
      operation_id: request.operation_id,
      key_operation_id: keyOperationId,
      account_id: key.account_id,
      gateway_id: key.gateway_id,
      alias: key.alias,
      provider_config_id: key.provider_config_id,
      configuration_metadata_sha256: key.metadata_sha256,
      request_sha256: requestSha,
      basis_sha256: await modelGatewaySha256(basisJson),
      planned_stage_set_sha256: stageSetSha,
      owner_credential_generation: input.context.credential_generation,
      project_generation: generation,
      deployment_generation: input.env.DEPLOYMENT_GENERATION,
      deadline_at: deadlineAt,
    }));
    const inserted = await store.insertIntent({
      owner_id: key.owner_id, project_id: input.project_id, operation_id: request.operation_id,
      key_operation_id: key.operation_id, account_id: key.account_id, gateway_id: key.gateway_id,
      alias: key.alias, provider_config_id: key.provider_config_id, configuration_metadata_sha256: key.metadata_sha256,
      request_sha256: requestSha, configuration_basis_json: basisJson,
      owner_credential_generation: input.context.credential_generation, project_generation: generation,
      deployment_generation: input.env.DEPLOYMENT_GENERATION, deadline_at: deadlineAt,
      expected_selection_revision: request.expected_selection_revision,
      source_configuration_ref: selected?.configuration_ref ?? null,
      source_configuration_sha256: selected?.configuration_sha256 ?? null,
      planned_stage_set_sha256: stageSetSha, plan_sha256: planSha,
      stages: basis.stages, created_at: createdAt,
    });
    if (!inserted) {
      const existing = await store.read(key.owner_id, input.project_id, request.operation_id);
      if (existing === null || existing.request_sha256 !== requestSha || existing.key_operation_id !== keyOperationId) {
        throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_IDEMPOTENCY_CONFLICT", 409,
          "This model-key use operation ID is already bound to a different request");
      }
      return existing;
    }
    const created = await store.read(key.owner_id, input.project_id, request.operation_id);
    if (created === null) unavailable();
    return created;
  }

  async function priceAndPrepare(rowRaw: ResearchProviderKeyModelUseRow): Promise<ResearchProviderKeyModelUseRow> {
    let row = rowRaw;
    const basis = parseResearchProviderKeyModelUseBasis(row.configuration_basis_json);
    let stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    for (const planned of basis.stages) {
      let stage = stages.find((entry) => entry.stage === planned.stage);
      if (stage === undefined) unavailable();
      if (stage.state === "PREPARED" || stage.state === "QUALIFYING" || stage.state === "QUALIFIED") continue;
      if (stage.state !== "PENDING") return row;
      if (row.state !== "PREPARING" || row.active_stage !== planned.stage || row.phase !== "FREE_PRICE_CHECK") {
        row = await transitionOperation(row, "PREPARING", "FREE_PRICE_CHECK", planned.stage);
      }
      const current = await assertCurrent(row, planned.stage);
      if (current === null) return markFailure(row, "AUTHORITY_CHANGED", "BLOCKED");
      let quote;
      try {
        quote = await pricing.observeAndPersistFreePrice({ operation_id: row.operation_id,
          route_ref: planned.route_ref, route_version: planned.route_version });
      } catch (cause) {
        if (cause instanceof ResearchProviderKeyModelPricingError) {
          const code = cause.code as ResearchProviderKeyModelUseFailureCode;
          return markFailure(row, code, "BLOCKED");
        }
        if (cause instanceof ResearchProviderKeyModelPriceObservationStoreError) return markFailure(row, "STORAGE_UNAVAILABLE", "BLOCKED");
        unavailable(cause);
      }
      if (quote.provider !== "openrouter" || quote.exact_model_id !== "stealth/space-bunny-alpha" ||
          quote.route_ref !== planned.route_ref || quote.route_version !== planned.route_version ||
          quote.expires_at !== row.deadline_at) return markFailure(row, "FREE_PRICE_NOT_PROVEN", "BLOCKED");
      stages = await transitionStage(row, planned.stage, "PENDING", "PENDING",
        { pricing: { ref: quote.pricing_snapshot_ref, sha256: quote.snapshot_sha256 } });
      stage = stages.find((entry) => entry.stage === planned.stage);
      if (stage === undefined) unavailable();
      if (row.phase !== "NATIVE_PREPARE") row = await transitionOperation(row, "PREPARING", "NATIVE_PREPARE", planned.stage);
      const stillCurrent = await assertCurrent(row, planned.stage);
      if (stillCurrent === null) return markFailure(row, "AUTHORITY_CHANGED", "BLOCKED");
      let preparation;
      try {
        preparation = await native.prepare({
          owner_operation_id: row.operation_id,
          owner_ref: row.owner_id,
          project_id: row.project_id,
          stage: planned.stage,
          deployment: deploymentForStage(planned, quote.pricing_snapshot_ref),
          probe_deployment: probeDeploymentForStage(planned, quote.pricing_snapshot_ref),
          transport_policy: planned.transport_policy,
          key_configuration_operation_id: row.key_operation_id,
          pricing_snapshot_ref: quote.pricing_snapshot_ref,
          pricing_snapshot_sha256: quote.snapshot_sha256,
          prompt_sha256: planned.prompt_sha256,
          schema_sha256: planned.schema_sha256,
          parameters_sha256: planned.parameters_sha256,
          probe_prompt_sha256: planned.probe_prompt_sha256,
          probe_schema_sha256: planned.probe_schema_sha256,
          probe_parameters_sha256: planned.probe_parameters_sha256,
        });
      } catch (cause) {
        if (cause instanceof ProviderNativeModelAuthorityError) {
          return markFailure(row, cause.code === "PROVIDER_NATIVE_MODEL_AUTHORITY_STALE" ? "AUTHORITY_CHANGED" : "PREPARATION_REJECTED", "BLOCKED");
        }
        return markFailure(row, "PREPARATION_REJECTED", "BLOCKED");
      }
      if (preparation.owner_operation_id !== row.operation_id || preparation.stage !== planned.stage ||
          preparation.route_ref !== planned.route_ref || preparation.route_version !== planned.route_version ||
          preparation.exact_model_id !== planned.transport_policy.model) return markFailure(row, "NATIVE_RECEIPT_INVALID", "BLOCKED");
      stages = await transitionStage(row, planned.stage, "PENDING", "PREPARED", {
        pricing: { ref: quote.pricing_snapshot_ref, sha256: quote.snapshot_sha256 },
        preparation: { ref: preparation.preparation_ref, sha256: preparation.preparation_sha256 },
      });
      row = (await store.read(row.owner_id, row.project_id, row.operation_id)) ?? row;
      if (!stages.some((entry) => entry.stage === planned.stage && entry.state === "PREPARED")) unavailable();
    }
    stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    if (stages.some((stage) => stage.state !== "PREPARED" && stage.state !== "QUALIFYING" && stage.state !== "QUALIFIED")) return row;
    const first = basis.stages[0];
    if (first === undefined) unavailable();
    if (row.state === "PREPARING") row = await transitionOperation(row, "QUALIFYING", "NATIVE_QUALIFY", first.stage);
    return row;
  }

  async function qualifyStages(rowRaw: ResearchProviderKeyModelUseRow): Promise<ResearchProviderKeyModelUseRow> {
    let row = rowRaw;
    const basis = parseResearchProviderKeyModelUseBasis(row.configuration_basis_json);
    for (const planned of basis.stages) {
      let stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
      let stage = stages.find((entry) => entry.stage === planned.stage);
      if (stage === undefined) unavailable();
      if (stage.state === "QUALIFIED") continue;
      if (stage.state !== "PREPARED" && stage.state !== "QUALIFYING") return row;
      if (row.state !== "QUALIFYING" || row.phase !== "NATIVE_QUALIFY" || row.active_stage !== planned.stage) {
        row = await transitionOperation(row, "QUALIFYING", "NATIVE_QUALIFY", planned.stage);
      }
      if (stage.state === "PREPARED") {
        stages = await transitionStage(row, planned.stage, "PREPARED", "QUALIFYING");
        stage = stages.find((entry) => entry.stage === planned.stage);
        if (stage === undefined) unavailable();
      }
      if (stage.preparation_ref === null || stage.preparation_sha256 === null) return markFailure(row, "NATIVE_RECEIPT_INVALID", "BLOCKED");
      const live = await assertCurrent(row, planned.stage);
      if (live === null) return markFailure(row, "AUTHORITY_CHANGED", "BLOCKED");
      const executor = createResearchProviderKeyModelNativeProbeExecutor({
        gateway_base_url: input.env.AI_GATEWAY_REASONING_URL,
        gateway_token: input.env.ELIOTR_MODEL_GATEWAY_TOKEN,
        signal: input.context.request.signal,
        maximum_input_bytes: planned.max_input_bytes,
        maximum_output_bytes: planned.max_output_bytes,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
        readCurrentAuthority: async () => {
          const current = await store.read(row.owner_id, row.project_id, row.operation_id);
          if (current === null || current.state !== "QUALIFYING" || current.phase !== "NATIVE_QUALIFY" ||
              current.active_stage !== planned.stage) return null;
          const currentStages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
          const currentStage = currentStages.find((entry) => entry.stage === planned.stage);
          if (currentStage === undefined || currentStage.state !== "QUALIFYING" ||
              currentStage.preparation_ref !== stage.preparation_ref || currentStage.preparation_sha256 !== stage.preparation_sha256) return null;
          if (await assertCurrent(current, planned.stage) === null) return null;
          return Object.freeze({ operation: current, stage: currentStage });
        },
      });
      let selection: ProviderNativeModelSelectionV1;
      try {
        selection = await native.qualify({
          owner_ref: row.owner_id,
          project_id: row.project_id,
          owner_operation_id: row.operation_id,
          stage: planned.stage,
          preparation_ref: stage.preparation_ref,
          preparation_sha256: stage.preparation_sha256,
          executor,
        });
      } catch (cause) {
        let attempt;
        try {
          attempt = await native.readQualificationOperation({ owner_ref: row.owner_id, project_id: row.project_id,
            owner_operation_id: row.operation_id, stage: planned.stage,
            preparation_ref: stage.preparation_ref, preparation_sha256: stage.preparation_sha256 });
        } catch {
          return markFailure(row, "QUALIFICATION_OUTCOME_UNCERTAIN", "UNCERTAIN");
        }
        if (attempt.status === "STARTED") return markFailure(row, "QUALIFICATION_OUTCOME_UNCERTAIN", "UNCERTAIN");
        if (attempt.status === "NOT_STARTED") {
          return markFailure(row, cause instanceof ResearchProviderKeyModelProbeExecutorError ? "QUALIFICATION_NO_EFFECT" : "PREPARATION_REJECTED", "BLOCKED");
        }
        // OBSERVED/COMPLETED can only be finalized by a later explicit POST for
        // this operation. This request never repeats the provider call.
        return row;
      }
      if (selection.candidate_kind !== "provider-native-v1" || selection.stage !== planned.stage ||
          selection.route_ref !== planned.route_ref || selection.route_version !== planned.route_version ||
          canonicalModelGatewayJson(selection.transport_policy) !== canonicalModelGatewayJson(planned.transport_policy)) {
        return markFailure(row, "NATIVE_RECEIPT_INVALID", "BLOCKED");
      }
      await native.resolvePinned({ selection, owner_ref: row.owner_id, project_id: row.project_id, allow_expired_snapshot_v2: false });
      stages = await transitionStage(row, planned.stage, "QUALIFYING", "QUALIFIED", {
        qualification: { candidate_ref: selection.candidate_ref, candidate_sha256: selection.candidate_sha256,
          qualification_ref: selection.qualification_ref, qualification_sha256: selection.qualification_sha256 },
      });
      if (!stages.some((entry) => entry.stage === planned.stage && entry.state === "QUALIFIED")) unavailable();
      row = (await store.read(row.owner_id, row.project_id, row.operation_id)) ?? row;
    }
    const stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    if (!stages.every((stage) => stage.state === "QUALIFIED")) return row;
    return transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null);
  }

  async function importAndSelect(rowRaw: ResearchProviderKeyModelUseRow): Promise<ResearchProviderKeyModelUseRow> {
    let row = rowRaw;
    const basis = parseResearchProviderKeyModelUseBasis(row.configuration_basis_json);
    const stages = await store.readStages(row.owner_id, row.project_id, row.operation_id);
    if (!stages.every((stage) => stage.state === "QUALIFIED" && stage.pricing_snapshot_ref !== null &&
        stage.candidate_ref !== null && stage.candidate_sha256 !== null && stage.qualification_ref !== null &&
        stage.qualification_sha256 !== null)) return row;
    const selections: ResearchProjectModelSelection[] = basis.stages.map((planned) => {
      const stage = stages.find((entry) => entry.stage === planned.stage);
      if (stage === undefined || stage.candidate_ref === null || stage.candidate_sha256 === null ||
          stage.qualification_ref === null || stage.qualification_sha256 === null) unavailable();
      return Object.freeze({
        candidate_kind: "provider-native-v1" as const,
        stage: planned.stage,
        route_ref: planned.route_ref,
        route_version: planned.route_version,
        candidate_ref: stage.candidate_ref,
        candidate_sha256: stage.candidate_sha256,
        qualification_ref: stage.qualification_ref,
        qualification_sha256: stage.qualification_sha256,
        transport_policy: planned.transport_policy,
      });
    });
    const pricingRefs = new Map(stages.map((stage) => [stage.stage, stage.pricing_snapshot_ref as string]));
    const target = await buildResearchProviderKeyModelUseTarget({ basis, selections, pricing_snapshot_refs: pricingRefs });
    const decoded = await decodeResearchProjectModelConfigurationBundle(target);
    if (row.target_configuration_ref !== null && (row.target_configuration_ref !== decoded.configuration_ref ||
        row.target_configuration_sha256 !== decoded.configuration_sha256 || row.target_configuration_json !== decoded.json)) {
      return markFailure(row, "NATIVE_RECEIPT_INVALID", "BLOCKED");
    }
    if (row.state === "QUALIFYING") {
      row = await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null, {
        target_configuration: { ref: decoded.configuration_ref, sha256: decoded.configuration_sha256, json: decoded.json },
      });
    } else if (row.state === "IMPORTING" && row.target_configuration_ref === null) {
      row = await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null, {
        target_configuration: { ref: decoded.configuration_ref, sha256: decoded.configuration_sha256, json: decoded.json },
      });
    }
    if (row.state !== "IMPORTING" || row.target_configuration_ref !== decoded.configuration_ref) return row;
    const current = await assertCurrent(row);
    if (current === null) {
      let selectedNow: SelectedResearchProjectConfiguration | null;
      try { selectedNow = await input.project_configuration.readSelected(input.context, input.project_id); }
      catch {
        const failureRow = row.phase === "SELECTION_READBACK"
          ? await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null) : row;
        return markFailure(failureRow, "AUTHORITY_CHANGED", "BLOCKED");
      }
      if (selectedNow?.configuration_ref === row.target_configuration_ref &&
          selectedNow.configuration_sha256 === row.target_configuration_sha256) {
        return transitionOperation(row, "SELECTED", "COMPLETE", null, {
          selection: { ref: selectedNow.configuration_ref, revision: selectedNow.selection_revision },
        });
      }
      if (sameResearchProviderKeyModelUseSourceSelection(selectedNow, row)) {
        const failureRow = row.phase === "SELECTION_READBACK"
          ? await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null) : row;
        return markFailure(failureRow, "AUTHORITY_CHANGED", "BLOCKED");
      }
      const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
      return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
    }
    const selected = await input.project_configuration.readSelected(input.context, input.project_id);
    if (selected?.configuration_ref === row.target_configuration_ref &&
        selected.configuration_sha256 === row.target_configuration_sha256) {
      const result = await transitionOperation(row, "SELECTED", "COMPLETE", null, {
        selection: { ref: selected.configuration_ref, revision: selected.selection_revision },
      });
      return result;
    }
    if (!sameResearchProviderKeyModelUseSourceSelection(selected, row)) {
      const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
      return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
    }
    if (row.phase === "SELECTION_READBACK") row = await transitionOperation(row, "IMPORTING", "CONFIGURATION_IMPORT", null);
    try {
      const result = await input.project_configuration.importQualifiedConfiguration(input.context, input.project_id, {
        expected_revision: row.expected_selection_revision,
        configuration: decoded.bundle,
      });
      if (result.selected.configuration_ref !== row.target_configuration_ref ||
          result.selected.configuration_sha256 !== row.target_configuration_sha256) {
        const phaseRow = await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
        return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
      }
      return transitionOperation(row, "SELECTED", "COMPLETE", null, {
        selection: { ref: result.selected.configuration_ref, revision: result.selection_revision },
      });
    } catch (cause) {
      const after = await input.project_configuration.readSelected(input.context, input.project_id).catch(() => null);
      if (after?.configuration_ref === row.target_configuration_ref &&
          after.configuration_sha256 === row.target_configuration_sha256) {
        return transitionOperation(row, "SELECTED", "COMPLETE", null, {
          selection: { ref: after.configuration_ref, revision: after.selection_revision },
        });
      }
      if (!sameResearchProviderKeyModelUseSourceSelection(after, row)) {
        const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
        return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
      }
      if (cause instanceof ResearchProjectModelConfigurationAuthorityError) {
        if (cause.status === 409) {
          const phaseRow = row.phase === "SELECTION_READBACK" ? row : await transitionOperation(row, "IMPORTING", "SELECTION_READBACK", null);
          return markFailure(phaseRow, "SELECTION_CAS_CONFLICT", "CONFLICT");
        }
        throw cause;
      }
      unavailable(cause);
    }
  }

  async function advance(rowRaw: ResearchProviderKeyModelUseRow): Promise<ResearchProviderKeyModelUseReceipt> {
    let row = rowRaw;
    if (["SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT"].includes(row.state)) return mapReceipt(row);
    if (row.state === "ACCEPTED") {
      const basis = parseResearchProviderKeyModelUseBasis(row.configuration_basis_json);
      const first = basis.stages[0];
      if (first === undefined) unavailable();
      row = await transitionOperation(row, "PREPARING", "FREE_PRICE_CHECK", first.stage);
    }
    if (row.state === "PREPARING") row = await priceAndPrepare(row);
    if (row.state === "QUALIFYING") row = await qualifyStages(row);
    if (row.state === "QUALIFYING" || row.state === "IMPORTING") row = await importAndSelect(row);
    const final = await store.read(row.owner_id, row.project_id, row.operation_id);
    return mapReceipt(final ?? row);
  }

  return Object.freeze({
    async start(keyOperationId: string, request: ResearchProviderKeyModelUseRequest) {
      requireResearchProviderKeyModelUseOwner(input.context);
      let row = await store.read(input.context.principal_ref, input.project_id, request.operation_id);
      if (row === null) row = await createIntent(keyOperationId, request);
      else {
        const digest = await modelGatewaySha256(canonicalModelGatewayJson({
          protocol: request.protocol, operation_id: request.operation_id,
          key_operation_id: keyOperationId, expected_selection_revision: request.expected_selection_revision,
        }));
        if (row.request_sha256 !== digest || row.key_operation_id !== keyOperationId) {
          throw new ResearchProviderKeyModelUseServiceError("PROVIDER_KEY_MODEL_USE_IDEMPOTENCY_CONFLICT", 409,
            "This model-key use operation ID is already bound to a different request");
        }
      }
      if (["SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT"].includes(row.state)) return mapReceipt(row);
      if (row.state === "IMPORTING") {
        const selected = await input.project_configuration.readSelected(input.context, input.project_id).catch(() => null);
        if (selected?.configuration_ref === row.target_configuration_ref &&
            selected.configuration_sha256 === row.target_configuration_sha256) {
          row = await transitionOperation(row, "SELECTED", "COMPLETE", null, {
            selection: { ref: selected.configuration_ref, revision: selected.selection_revision },
          });
          return mapReceipt(row);
        }
      }
      const current = await assertCurrent(row);
      if (current === null) return mapReceipt(await markFailure(row, "AUTHORITY_CHANGED", "BLOCKED"));
      return advance(row);
    },
    async read(operationId: string) {
      return mapReceipt(await readResearchProviderKeyModelUseOperation({
        store, database: input.env.CORE_DB, context: input.context, project_id: input.project_id, operation_id: operationId,
      }));
    },
  });
}
