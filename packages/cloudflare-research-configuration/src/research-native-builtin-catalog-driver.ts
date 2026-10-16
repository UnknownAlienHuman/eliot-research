import { canonicalModelGatewayJson, parseDynamicRouteQualificationProbeInput,
  validateModelGatewayTransportPolicy, type DynamicRouteQualificationProbeInput,
  type ModelGatewayTransportPolicyV1, type ModelGatewayPromptCompilerPort } from "@eliotr/cloudflare-ai";
import { createResearchModelQualification, createD1ResearchModelPricingSnapshotStore,
  type ResearchModelGatewayRuntimeConfig, type ResearchModelCatalogEntry,
  type ResearchModelQualificationDependencies, type ResearchQualificationPromptConfig } from "@eliotr/cloudflare-model-control";
import { createResearchModelCandidateStagingService, decodeResearchProjectModelConfigurationBundle,
  readResearchOwnerSpendPolicyTemplate, type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { createD1ResearchCatalogModelUseStore, type ResearchCatalogModelUseAuthorizationRow } from "./research-catalog-model-use-store.js";
import type { ResearchProjectModelConfigurationService } from "./research-project-configuration.js";
import { buildNativeBuiltinCatalogTarget, type NativeBuiltinCatalogQualifiedStage } from "./research-native-builtin-catalog-target.js";

type Operation = ResearchCatalogModelUseAuthorizationRow;
type Stage = NativeBuiltinCatalogQualifiedStage["stage"];

export interface NativeBuiltinCatalogPreparedStage {
  readonly stage: Stage;
  /** Real prepared route receipt and exact one-shot input; never a default candidate relabeled as another model. */
  readonly probe: DynamicRouteQualificationProbeInput;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
  readonly prompt: ResearchQualificationPromptConfig;
}

export interface NativeBuiltinCatalogPreparation {
  /** Current server-validated template; its owner limits and non-model settings are retained. */
  readonly source_configuration: ResearchProjectModelConfigurationBundle;
  readonly stages: readonly NativeBuiltinCatalogPreparedStage[];
}

export interface NativeBuiltinCatalogDriverDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly deployment_generation: string;
  /** Existing Workers AI binding, not an HTTP token or BYOK provider. */
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly control_plane: ResearchModelQualificationDependencies["control_plane"];
  readonly project_configuration: ResearchProjectModelConfigurationService;
  /** Recheck actual owner/project/credential/deployment generations, not just the saved intent. */
  readonly read_current_authority: (operation: Operation) => Promise<Operation | null>;
  readonly read_advertised_model: (modelId: string) => Promise<ResearchModelCatalogEntry | null>;
  readonly prepare: (operation: Operation) => Promise<NativeBuiltinCatalogPreparation>;
  readonly prompt_compiler: (stage: NativeBuiltinCatalogPreparedStage) => Promise<ModelGatewayPromptCompilerPort>;
  readonly now?: () => string;
}

export class NativeBuiltinCatalogModelUseError extends Error {
  public constructor(public readonly code: "AUTHORITY_CHANGED" | "PREPARATION_REJECTED" | "PRICING_NOT_PROVEN" |
    "QUALIFICATION_OUTCOME_UNCERTAIN" | "SELECTION_READBACK_INVALID", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "NativeBuiltinCatalogModelUseError";
  }
}

export function nativeBuiltinCatalogProbeKey(operationId: string, stage: Stage): string {
  return `native-catalog-${operationId}-${stage.toLowerCase()}`;
}

const same = (a: unknown, b: unknown) => canonicalModelGatewayJson(a) === canonicalModelGatewayJson(b);
const detach = <T>(value: T): T => JSON.parse(canonicalModelGatewayJson(value)) as T;

/** Native-only operator flow. Uses existing durable qualification/staging/CAS; never promotes a global route. */
export function createResearchNativeBuiltinCatalogDriver(input: NativeBuiltinCatalogDriverDependencies) {
  const now = input.now ?? (() => new Date().toISOString());
  const store = createD1ResearchCatalogModelUseStore(input.database);
  const prices = createD1ResearchModelPricingSnapshotStore(input.database, { now });
  const candidates = createResearchModelCandidateStagingService({ database: input.database, now });

  function assertNative(row: Operation): void {
    if (input.context.client_class !== "owner_pwa" || row.owner_id !== input.context.principal_ref ||
        row.owner_credential_generation !== input.context.credential_generation || row.project_id !== input.project_id ||
        row.deployment_generation !== input.deployment_generation || row.provider_id !== "cloudflare-workers-ai" ||
        row.route_provider_id !== "workers-ai" || !/^@cf\/[A-Za-z0-9._-]+\/[A-Za-z0-9._:@-]+$/u.test(row.model_id) ||
        [row.provider_operation_id, row.account_id, row.gateway_id, row.alias, row.provider_config_id,
          row.configuration_metadata_sha256].some(value => value !== null) ||
        !("ai_gateway_binding" in input.gateway) || input.gateway.ai_gateway_binding === undefined) {
      throw new NativeBuiltinCatalogModelUseError("AUTHORITY_CHANGED", "Native selection requires the current owner and existing Workers AI binding, without BYOK");
    }
  }

  async function current(row: Operation): Promise<Operation> {
    assertNative(row);
    const fresh = await input.read_current_authority(row);
    if (fresh === null) throw new NativeBuiltinCatalogModelUseError("AUTHORITY_CHANGED", "Native owner authority changed");
    assertNative(fresh);
    // Phase/updated_at may advance; every authority, request and source-selection field must remain exact.
    const identity = (value: Operation) => {
      const { state: _state, phase: _phase, updated_at: _updated, failure_code: _failure,
        selected_configuration_ref: _selected, selected_configuration_sha256: _sha, selection_revision: _revision, ...fields } = value;
      return fields;
    };
    if (!same(identity(row), identity(fresh))) throw new NativeBuiltinCatalogModelUseError("AUTHORITY_CHANGED", "Native preparation authority differs from the owner intent");
    return fresh;
  }

  async function transition(row: Operation, state: Operation["state"], phase: Operation["phase"],
    failure_code: Operation["failure_code"] = null, selection?: { configuration_ref: string; configuration_sha256: string; revision: number }) {
    await store.transition({ owner_id: row.owner_id, project_id: row.project_id, operation_id: row.operation_id,
      expected_state: row.state, expected_phase: row.phase, state, phase, failure_code, updated_at: now(),
      ...(selection === undefined ? {} : { selection }) });
    const found = await store.read(row.owner_id, row.project_id, row.operation_id);
    if (found === null || found.state !== state || found.phase !== phase) {
      throw new NativeBuiltinCatalogModelUseError("AUTHORITY_CHANGED", "Native operation transition was not acknowledged");
    }
    return found;
  }

  async function verifySelection(row: Operation, targetRef?: string, targetSha?: string) {
    const [selected, page] = await Promise.all([
      input.project_configuration.readSelected(input.context, row.project_id),
      input.project_configuration.readPage(input.context, row.project_id, { limit: 1 }),
    ]);
    if (selected === null || page.selected === null || page.selected.qualification_state !== "qualified" ||
        selected.project_id !== row.project_id || selected.selection_revision !== page.selection_revision ||
        selected.configuration_ref !== page.selected.configuration_ref || selected.configuration_sha256 !== page.selected.configuration_sha256 ||
        (targetRef !== undefined && selected.configuration_ref !== targetRef) ||
        (targetSha !== undefined && selected.configuration_sha256 !== targetSha) ||
        selected.configuration.model_selections.length < 2 || selected.configuration.model_selections.some(selection => {
          const policy = selection.transport_policy;
          return policy.provider !== "workers-ai" || policy.model !== row.model_id || policy.billing.mode !== "unified";
        })) throw new NativeBuiltinCatalogModelUseError("SELECTION_READBACK_INVALID", "Exact requested native model is not qualified and selected");
    return { configuration_ref: selected.configuration_ref, configuration_sha256: selected.configuration_sha256,
      revision: selected.selection_revision };
  }

  return Object.freeze({
    /** Call from the normal authorized catalogModelUse start/resume operation only. */
    async run(operation: Operation): Promise<Operation> {
      let row = await current(detach(operation));
      if (row.state === "SELECTED") {
        await verifySelection(row, row.selected_configuration_ref ?? undefined, row.selected_configuration_sha256 ?? undefined);
        return row;
      }
      if (["BLOCKED", "UNCERTAIN", "CONFLICT"].includes(row.state)) return row;
      if (row.state === "ACCEPTED") row = await transition(row, "PREPARING", "NATIVE_PREPARE");
      let probeStarted = false;
      try {
        const model = await input.read_advertised_model(row.model_id);
        if (model?.provider_id !== "cloudflare-workers-ai" || model.model_id !== row.model_id ||
            model.capabilities.text_generation !== "supported" || model.catalog_availability !== "listed") {
          throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Exact requested native text model is not advertised");
        }
        const prepared = detach(await input.prepare(row));
        const spend = readResearchOwnerSpendPolicyTemplate(prepared.source_configuration.vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
          prepared.source_configuration.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
        if (prepared.stages.length !== spend.rules.length || new Set(prepared.stages.map(stage => stage.stage)).size !== spend.rules.length ||
            spend.rules.some(rule => !prepared.stages.some(stage => stage.stage === rule.stage))) {
          throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Every owner spend stage needs its own native preparation");
        }
        // Preflight ALL stages/prices before the first paid qualification, in owner stage order.
        const plans = [];
        for (const rule of spend.rules) {
          const stage = prepared.stages.find(stage => stage.stage === rule.stage);
          if (stage === undefined) throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Missing native stage");
          const probe = parseDynamicRouteQualificationProbeInput(stage.probe);
          const policy = validateModelGatewayTransportPolicy(stage.transport_policy);
          if (policy.provider !== "workers-ai" || policy.model !== row.model_id || policy.api !== "compat-chat-completions" ||
              policy.billing.mode !== "unified" || probe.expected_provider !== "workers-ai" || probe.expected_model !== row.model_id ||
              probe.probe_idempotency_key !== nativeBuiltinCatalogProbeKey(row.operation_id, stage.stage) ||
              Date.parse(probe.expires_at) <= Date.parse(now())) {
            throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Native exact model, durable probe identity or expiry differs");
          }
          const deployment = probe.provisioning.deployment;
          if (probe.model_call.max_input_bytes > rule.max_input_bytes || probe.model_call.max_output_bytes > rule.max_output_bytes) {
            throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Native probe exceeds existing owner byte limits");
          }
          const identity = { pricing_snapshot_ref: deployment.pricing_snapshot_ref, route_ref: deployment.route_ref,
            route_version: deployment.route_version, provider: "workers-ai", exact_model_id: row.model_id };
          const price = await prices.read(identity);
          if (price === null || price.pricing_basis !== "EXACT_TOKEN_RATES_V1" || price.approval_receipt_ref.length === 0 ||
              Date.parse(price.effective_at) > Date.parse(now()) || Date.parse(price.expires_at) < Date.parse(probe.expires_at)) {
            throw new NativeBuiltinCatalogModelUseError("PRICING_NOT_PROVEN", "Native qualification needs an existing approved exact-model token-price snapshot");
          }
          if (Date.parse(probe.verified_at) !== Math.max(Date.parse(row.created_at), Date.parse(price.effective_at))) {
            throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Native probe clock differs from its immutable operation/price observation");
          }
          plans.push({ stage, probe, policy, price, identity });
        }
        row = await current(row);
        if (row.state === "PREPARING") row = await transition(row, "QUALIFYING", "QUALIFICATION");
        const stages: NativeBuiltinCatalogQualifiedStage[] = [];
        for (const plan of plans) {
          row = await current(row);
          if (!same(plan.price, await prices.read(plan.identity))) throw new NativeBuiltinCatalogModelUseError("AUTHORITY_CHANGED", "Native pricing changed before dispatch");
          const compiler = await input.prompt_compiler(plan.stage);
          row = await current(row);
          const qualifier = createResearchModelQualification({ database: input.database, work_bucket: input.work_bucket,
            control_plane: input.control_plane, gateway: { ...input.gateway, transport_policy: plan.policy },
            prompt_compiler: compiler, now });
          // Existing D1 observation claim makes replay/concurrent calls read the same execution, never dispatch twice.
          probeStarted = true;
          const qualification = await qualifier.qualify(plan.probe);
          if (qualification.tier !== "LIVE") throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Native import requires a real LIVE qualification");
          row = await current(row);
          const staged = await candidates.stage({ protocol: "eliotr.research-model-candidate-stage-request.v1",
            preparation: { protocol: "eliotr.research-model-preparation.v1", deployment: plan.probe.provisioning.deployment,
              pricing_snapshot: plan.price, provisioning: plan.probe.provisioning }, qualification });
          if (!same(staged.deployment, plan.probe.provisioning.deployment)) throw new NativeBuiltinCatalogModelUseError("PREPARATION_REJECTED", "Native staged deployment differs");
          stages.push({ stage: plan.stage.stage, deployment: staged.deployment,
            selection: { stage: plan.stage.stage, route_ref: staged.deployment.route_ref, route_version: staged.deployment.route_version,
              candidate_ref: staged.candidate_ref, candidate_sha256: staged.candidate_sha256,
              qualification_ref: staged.qualification_ref, qualification_sha256: staged.qualification_sha256, transport_policy: plan.policy } });
        }
        const target = await buildNativeBuiltinCatalogTarget(prepared.source_configuration, row.model_id, stages);
        const decoded = await decodeResearchProjectModelConfigurationBundle(target);
        row = await current(row);
        if (row.state === "QUALIFYING") row = await transition(row, "IMPORTING", "CONFIGURATION_IMPORT");
        try {
          await input.project_configuration.importQualifiedConfiguration(input.context, row.project_id,
            { expected_revision: row.expected_selection_revision, configuration: target });
        } catch (cause) {
          // Reconcile lost import acknowledgement only by exact validated selection readback.
          try { await verifySelection(row, decoded.configuration_ref, decoded.configuration_sha256); }
          catch { throw cause; }
        }
        row = await current(row);
        const selected = await verifySelection(row, decoded.configuration_ref, decoded.configuration_sha256);
        return transition(row, "SELECTED", "COMPLETE", null, selected);
      } catch (cause) {
        const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
        if (/SELECTION.*CONFLICT|REVISION.*CONFLICT/u.test(code)) return transition(row, "CONFLICT", "SELECTION_READBACK", "SELECTION_CAS_CONFLICT");
        if (code === "AUTHORITY_CHANGED") return transition(row, "BLOCKED", row.phase, "AUTHORITY_CHANGED");
        // The probes are already committed at this point. Preserve the import
        // for readback instead of inventing an uncertain qualification or a
        // backwards state transition that would hide the original failure.
        if (row.state === "IMPORTING") throw cause;
        return transition(row, probeStarted ? "UNCERTAIN" : "BLOCKED", row.phase,
          probeStarted ? "QUALIFICATION_OUTCOME_UNCERTAIN" : "PREPARATION_REJECTED");
      }
    },
  });
}
