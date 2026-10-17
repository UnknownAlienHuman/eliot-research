import {
  RESEARCH_CATALOG_MODEL_USE_RECEIPT_PROTOCOL,
  RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL,
  RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
  ResearchCatalogModelUseRequestSchema,
  type ResearchCatalogModelUseFailureCode,
  type ResearchCatalogModelUsePhase,
  type ResearchCatalogModelUseReceipt,
  type ResearchCatalogModelUseRequest,
  type ResearchCatalogModelUseState,
  type ResearchProviderKeyModelUseReceipt,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalModelGatewayJson, modelGatewaySha256, validateModelGatewayTransportPolicy,
  type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { decodeResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import { ServiceModelProviderOperationError } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { createD1ResearchCatalogModelUseStore, type ResearchCatalogModelUseAuthorizationRow } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-use-store.js";
import type { ResearchProjectModelConfigurationService } from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import { ResearchProviderKeyModelUseServiceError, type ResearchProviderKeyModelUseService } from
  "./research-provider-key-model-use-service.js";
import { installedGatewayIdentity } from "./research-provider-key-configuration-composition.js";
import { createServiceModelSettingsComposition } from "./service-model-settings-composition.js";
import { readInstalledNativeResearchRunConfiguration } from "./research-run-configuration.js";
import type { InstalledNativeResearchConfiguration } from
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import type { ResearchCatalogModelUseV2Driver, ResearchCatalogModelUseV2Receipt, ResearchCatalogModelUseV2Service } from
  "./research-catalog-model-use-v2-driver.js";
import type { ResearchProviderKeyModelUseCatalogSelectionV1 } from
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-plan.js";
import type { Env } from "./env.js";

export type { ResearchCatalogModelUseV2Driver } from "./research-catalog-model-use-v2-driver.js";

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export type ResearchCatalogModelUseServiceErrorCode =
  | "RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID"
  | "RESEARCH_CATALOG_MODEL_USE_NOT_FOUND"
  | "RESEARCH_CATALOG_MODEL_USE_IDEMPOTENCY_CONFLICT"
  | "RESEARCH_CATALOG_MODEL_USE_UNRESOLVED"
  | "RESEARCH_CATALOG_MODEL_USE_PROVIDER_UNAVAILABLE"
  | "RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED"
  | "RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED"
  | "RESEARCH_CATALOG_MODEL_USE_STORAGE_UNAVAILABLE";

export class ResearchCatalogModelUseServiceError extends Error {
  public constructor(
    public readonly code: ResearchCatalogModelUseServiceErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchCatalogModelUseServiceError";
  }
}

export interface ResearchCatalogModelUseService {
  start(request: ResearchCatalogModelUseRequest): Promise<ResearchCatalogModelUseReceipt>;
  readCurrent(): Promise<ResearchCatalogModelUseReceipt | null>;
  read(operationId: string): Promise<ResearchCatalogModelUseReceipt>;
}

function unavailable(cause?: unknown): never {
  throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_STORAGE_UNAVAILABLE", 503,
    "Catalog model-use authority is temporarily unavailable", true, cause);
}

function mapFailure(receipt: ResearchProviderKeyModelUseReceipt): ResearchCatalogModelUseFailureCode | null {
  if (receipt.failure_code === null) return null;
  if (receipt.failure_code === "QUALIFICATION_OUTCOME_UNCERTAIN" ||
      receipt.failure_code === "SELECTION_CAS_CONFLICT" || receipt.failure_code === "AUTHORITY_CHANGED" ||
      receipt.failure_code === "NATIVE_RECEIPT_INVALID" || receipt.failure_code === "PREPARATION_REJECTED" ||
      receipt.failure_code === "QUALIFICATION_NO_EFFECT" || receipt.failure_code === "SERVER_POLICY_UNAVAILABLE") {
    return receipt.failure_code;
  }
  return receipt.failure_code === "FREE_PRICE_NOT_PROVEN" || receipt.failure_code === "FREE_PRICE_NOT_ZERO"
    ? "MODEL_NOT_SUPPORTED" : "SERVER_POLICY_UNAVAILABLE";
}

function mapPhase(phase: ResearchProviderKeyModelUseReceipt["phase"]): ResearchCatalogModelUsePhase {
  switch (phase) {
    case "native_prepare": return "native_prepare";
    case "native_qualify": return "qualification";
    case "configuration_import": return "configuration_import";
    case "selection_readback": return "selection_readback";
    case "complete": return "complete";
    case "intent": return "intent";
    case "free_price_check": return "provider_resolution";
  }
}

function routeProviderFor(binding: { readonly provider_id: string; readonly provider_slug: string }): string {
  const native = (binding.provider_id === "openrouter" || binding.provider_id === "openai" ||
    binding.provider_id === "anthropic") && binding.provider_slug === binding.provider_id;
  const custom = binding.provider_slug === `custom-${binding.provider_id}`;
  if (!native && !custom) {
    throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED", 409,
      "Configured provider slug does not match its catalog adapter");
  }
  return binding.provider_slug;
}

function isExactWorkersAiPolicy(raw: unknown, modelId: string): boolean {
  try {
    const policy = validateModelGatewayTransportPolicy(raw);
    return policy.provider === "workers-ai" && policy.model === modelId &&
      policy.api === "compat-chat-completions" && policy.billing.mode === "unified";
  } catch { return false; }
}

export function createResearchCatalogModelUseService(input: {
  readonly env: Env;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly project_configuration: ResearchProjectModelConfigurationService;
  readonly model_use: (selection: ResearchProviderKeyModelUseCatalogSelectionV1) => ResearchProviderKeyModelUseService;
  readonly provider_native_v2?: ResearchCatalogModelUseV2Driver;
  /** Status-only reconciliation; never prepares, dispatches or retries a model. */
  readonly reconcile_failed_qualification?: (row: ResearchCatalogModelUseAuthorizationRow) =>
    Promise<ResearchCatalogModelUseAuthorizationRow>;
  readonly builtin_native?: Readonly<{
    run(operation: ResearchCatalogModelUseAuthorizationRow): Promise<ResearchCatalogModelUseAuthorizationRow>;
  }>;
  readonly read_installed_native_configuration?: (ownerRef: string, projectId: string) =>
    Promise<InstalledNativeResearchConfiguration>;
  readonly now?: () => string;
}): ResearchCatalogModelUseService {
  if (input.env.CORE_DB === undefined || input.context.client_class !== "owner_pwa" ||
      input.project_id.length === 0 || typeof input.model_use !== "function") {
    throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400,
      "Catalog model-use dependencies are incomplete");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const store = createD1ResearchCatalogModelUseStore(input.env.CORE_DB);
  const providers = createServiceModelSettingsComposition(input.env).service;
  const gateway = installedGatewayIdentity(input.env.AI_GATEWAY_REASONING_URL);
  const readInstalledNative = input.read_installed_native_configuration ?? ((ownerRef: string, projectId: string) =>
    readInstalledNativeResearchRunConfiguration(input.env, ownerRef, projectId));

  function requireCurrentOwner(): void {
    if (input.context.request.signal.aborted || !IDENTIFIER.test(input.context.credential_generation) ||
        input.context.access?.credential_generation !== undefined &&
          input.context.access.credential_generation !== input.context.credential_generation) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409,
        "Owner authority changed during catalog model use");
    }
  }

  async function requireCurrentStatusOwner(row: ResearchCatalogModelUseAuthorizationRow): Promise<void> {
    if (row.owner_id !== input.context.principal_ref || row.project_id !== input.project_id) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409,
        "Current catalog model-use owner changed");
    }
    let project: { readonly generation: number } | null;
    try {
      project = await input.env.CORE_DB.prepare(
        "SELECT p.generation FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
      ).bind(input.project_id, input.context.principal_ref).first<{ readonly generation: number }>();
    } catch (cause) { unavailable(cause); }
    if (project === null || project.generation !== row.project_generation) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409,
        "Current project owner or generation changed");
    }
  }

  async function reconcileStaleIntent(row: ResearchCatalogModelUseAuthorizationRow): Promise<ResearchCatalogModelUseAuthorizationRow> {
    if (row.state !== "ACCEPTED" || row.phase !== "INTENT" ||
        (row.owner_credential_generation === input.context.credential_generation &&
          row.deployment_generation === input.env.DEPLOYMENT_GENERATION)) return row;
    requireCurrentOwner();
    await store.closeStaleIntentIfUnstarted({ row,
      current_owner_credential_generation: input.context.credential_generation,
      current_deployment_generation: input.env.DEPLOYMENT_GENERATION,
      updated_at: now(),
    });
    const current = await store.read(row.owner_id, row.project_id, row.operation_id);
    if (current === null) throw new ResearchCatalogModelUseServiceError(
      "RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409, "Catalog model-use intent changed during reconciliation");
    await requireCurrentStatusOwner(current);
    requireCurrentOwner();
    return current;
  }

  function policyForOpenRouter(modelId: string, alias: string): ModelGatewayTransportPolicyV1 {
    return validateModelGatewayTransportPolicy({
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "openrouter-chat-completions",
      provider: "openrouter",
      model: modelId,
      billing: { mode: "byok", alias, free_only: true },
      capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "medium", "high", "max"],
        response_format_normalization: "json-schema-to-json-object" },
    });
  }

  async function configured(request: ResearchCatalogModelUseRequest) {
    if (request.provider_operation_id === null || request.provider_id === "cloudflare-workers-ai") {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED", 409,
        "Workers AI catalog selection uses the native project-configuration path");
    }
    let binding: Awaited<ReturnType<typeof providers.resolveConfiguredProvider>>;
    try {
      binding = await providers.resolveConfiguredProvider(input.context, request.provider_id, {
        operation_id: request.provider_operation_id,
      });
    } catch (cause) {
      if (cause instanceof ServiceModelProviderOperationError) {
        throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_PROVIDER_UNAVAILABLE", cause.status,
          "Exact global provider operation is unavailable for this model", cause.retryable, cause);
      }
      unavailable(cause);
    }
    if (binding === null || binding.operation_id !== request.provider_operation_id ||
        binding.provider_id !== request.provider_id || binding.alias === "default" || gateway === undefined) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_PROVIDER_UNAVAILABLE", 409,
        "Exact configured global provider operation is unavailable");
    }
    const routeProviderId = routeProviderFor(binding);
    if (request.provider_id === "openrouter" && request.model_id.endsWith(":free")) {
      return Object.freeze({ kind: "openrouter" as const, binding, routeProviderId,
        policy: policyForOpenRouter(request.model_id, binding.alias) });
    }
    if (input.provider_native_v2 === undefined) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED", 409,
        "Trusted provider-native v2 catalog qualification is not configured");
    }
    return Object.freeze({ kind: "provider-native-v2" as const, binding, routeProviderId });
  }

  async function receiptFromAuthorization(row: ResearchCatalogModelUseAuthorizationRow): Promise<ResearchCatalogModelUseReceipt> {
    return Object.freeze({
      protocol: RESEARCH_CATALOG_MODEL_USE_RECEIPT_PROTOCOL,
      project_id: row.project_id,
      operation_id: row.operation_id,
      provider_id: row.provider_id,
      provider_operation_id: row.provider_operation_id,
      model_id: row.model_id,
      state: row.state.toLowerCase() as ResearchCatalogModelUseState,
      phase: row.phase.toLowerCase() as ResearchCatalogModelUsePhase,
      selected_configuration_ref: row.selected_configuration_ref,
      selected_configuration_sha256: row.selected_configuration_sha256,
      selection_revision: row.selection_revision,
      failure_code: row.failure_code,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  }

  async function selectedConfiguration(
    request: ResearchCatalogModelUseRequest,
    receipt: Readonly<{
      selected_configuration_ref: string | null;
      selected_configuration_sha256?: string | null;
      selection_revision: number | null;
    }>,
    routeProviderId: string,
  ): Promise<Readonly<{ ref: string; sha256: string; revision: number }>> {
    const [selected, page] = await Promise.all([
      input.project_configuration.readSelected(input.context, input.project_id),
      input.project_configuration.readPage(input.context, input.project_id, { limit: 1 }),
    ]);
    const summary = page.selected;
    const synthesis = selected?.configuration.model_selections.filter((entry) => entry.stage === "SYNTHESIZE") ?? [];
    if (selected === null || summary === null || page.selection_revision === null ||
        selected.project_id !== input.project_id ||
        selected.configuration_ref !== receipt.selected_configuration_ref ||
        (receipt.selected_configuration_sha256 !== undefined &&
          selected.configuration_sha256 !== receipt.selected_configuration_sha256) ||
        selected.selection_revision !== receipt.selection_revision || page.selection_revision !== receipt.selection_revision ||
        summary.qualification_state !== "qualified" || summary.configuration_ref !== selected.configuration_ref ||
        summary.configuration_sha256 !== selected.configuration_sha256 || synthesis.length !== 1 ||
        synthesis[0]?.transport_policy.provider !== routeProviderId || synthesis[0]?.transport_policy.model !== request.model_id ||
        (request.provider_id !== "openrouter" && synthesis[0]?.candidate_kind !== "provider-native-v2")) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409,
        "Qualified project configuration readback does not match the selected catalog model");
    }
    return Object.freeze({ ref: selected.configuration_ref, sha256: selected.configuration_sha256,
      revision: selected.selection_revision });
  }

  async function persistReceipt(row: ResearchCatalogModelUseAuthorizationRow,
    receipt: ResearchProviderKeyModelUseReceipt,
    request: ResearchCatalogModelUseRequest): Promise<ResearchCatalogModelUseReceipt> {
    const updatedAt = now();
    const step = async (state: ResearchCatalogModelUseAuthorizationRow["state"],
      phase: ResearchCatalogModelUseAuthorizationRow["phase"],
      failure: ResearchCatalogModelUseFailureCode | null = null,
      selection?: Readonly<{ ref: string; sha256: string; revision: number }>) => {
      if (row.state === state && row.phase === phase) return;
      const changed = await store.transition({ owner_id: row.owner_id, project_id: row.project_id,
        operation_id: row.operation_id, expected_state: row.state, expected_phase: row.phase,
        state, phase, updated_at: updatedAt, failure_code: failure,
        ...(selection === undefined ? {} : { selection: { configuration_ref: selection.ref,
          configuration_sha256: selection.sha256, revision: selection.revision } }),
      });
      const readback = await store.read(row.owner_id, row.project_id, row.operation_id);
      if (!changed && (readback === null || readback.state !== state || readback.phase !== phase)) unavailable();
      if (readback === null) unavailable();
      row = readback;
    };
    if (receipt.state === "selected") {
      const selection = await selectedConfiguration(request, receipt, row.route_provider_id);
      if (row.state === "ACCEPTED") await step("PREPARING", "PROVIDER_RESOLUTION");
      if (row.state === "PREPARING") await step("QUALIFYING", "QUALIFICATION");
      if (row.state === "QUALIFYING") await step("IMPORTING", "CONFIGURATION_IMPORT");
      if (row.state === "IMPORTING") await step("SELECTED", "COMPLETE", null, selection);
    } else {
      const state = receipt.state.toUpperCase() as ResearchCatalogModelUseAuthorizationRow["state"];
      const phase = (receipt.state === "uncertain" ? "QUALIFICATION" :
        receipt.state === "conflict" ? "SELECTION_READBACK" : mapPhase(receipt.phase).toUpperCase()) as ResearchCatalogModelUseAuthorizationRow["phase"];
      const failure = mapFailure(receipt);
      if (row.state === "ACCEPTED" && state !== "ACCEPTED") await step("PREPARING", "PROVIDER_RESOLUTION");
      if ((state === "QUALIFYING" || state === "IMPORTING" || state === "UNCERTAIN") && row.state === "PREPARING") {
        await step("QUALIFYING", "QUALIFICATION");
      }
      if (state === "IMPORTING" && row.state === "QUALIFYING") await step("IMPORTING", "CONFIGURATION_IMPORT");
      if (row.state !== state) await step(state, phase, failure);
    }
    return receiptFromAuthorization(row);
  }

  async function persistV2Receipt(row: ResearchCatalogModelUseAuthorizationRow,
    value: ResearchCatalogModelUseV2Receipt,
    request: ResearchCatalogModelUseRequest): Promise<ResearchCatalogModelUseReceipt> {
    const updatedAt = now();
    const step = async (state: ResearchCatalogModelUseAuthorizationRow["state"],
      phase: ResearchCatalogModelUseAuthorizationRow["phase"],
      failure: ResearchCatalogModelUseFailureCode | null = null,
      selection?: Readonly<{ ref: string; sha256: string; revision: number }>) => {
      if (row.state === state && row.phase === phase) return;
      const changed = await store.transition({ owner_id: row.owner_id, project_id: row.project_id,
        operation_id: row.operation_id, expected_state: row.state, expected_phase: row.phase,
        state, phase, updated_at: updatedAt, failure_code: failure,
        ...(selection === undefined ? {} : { selection: { configuration_ref: selection.ref,
          configuration_sha256: selection.sha256, revision: selection.revision } }),
      });
      const readback = await store.read(row.owner_id, row.project_id, row.operation_id);
      if (readback === null || (!changed && (readback.state !== state || readback.phase !== phase))) unavailable();
      row = readback;
    };
    if (value.state === "selected") {
      const selection = await selectedConfiguration(request, value, row.route_provider_id);
      if (row.state === "ACCEPTED") await step("PREPARING", "PROVIDER_RESOLUTION");
      if (row.state === "PREPARING") await step("QUALIFYING", "QUALIFICATION");
      if (row.state === "QUALIFYING") await step("IMPORTING", "CONFIGURATION_IMPORT");
      if (row.state === "IMPORTING") await step("SELECTED", "COMPLETE", null, selection);
    } else {
      const state = value.state.toUpperCase() as ResearchCatalogModelUseAuthorizationRow["state"];
      const phase = (value.state === "uncertain" ? "QUALIFICATION" : value.state === "conflict"
        ? "SELECTION_READBACK" : value.phase.toUpperCase()) as ResearchCatalogModelUseAuthorizationRow["phase"];
      const failure = value.failure_code;
      if (row.state === "ACCEPTED" && state !== "ACCEPTED") await step("PREPARING", "PROVIDER_RESOLUTION");
      if ((state === "QUALIFYING" || state === "IMPORTING" || state === "UNCERTAIN") && row.state === "PREPARING") {
        await step("QUALIFYING", "QUALIFICATION");
      }
      if (state === "IMPORTING" && row.state === "QUALIFYING") await step("IMPORTING", "CONFIGURATION_IMPORT");
      if (state === "PREPARING" && row.state === "PREPARING" && row.phase !== phase) await step("PREPARING", phase);
      if (row.state !== state || row.phase !== phase) await step(state, phase, failure);
    }
    return receiptFromAuthorization(row);
  }

  async function transitionAuthorization(
    row: ResearchCatalogModelUseAuthorizationRow,
    state: ResearchCatalogModelUseAuthorizationRow["state"],
    phase: ResearchCatalogModelUseAuthorizationRow["phase"],
    failure: ResearchCatalogModelUseFailureCode | null = null,
    selection?: Readonly<{ ref: string; sha256: string; revision: number }>,
  ): Promise<ResearchCatalogModelUseAuthorizationRow> {
    if (row.state === state && row.phase === phase) return row;
    const changed = await store.transition({ owner_id: row.owner_id, project_id: row.project_id,
      operation_id: row.operation_id, expected_state: row.state, expected_phase: row.phase,
      state, phase, updated_at: now(), failure_code: failure,
      ...(selection === undefined ? {} : { selection: { configuration_ref: selection.ref,
        configuration_sha256: selection.sha256, revision: selection.revision } }),
    });
    const readback = await store.read(row.owner_id, row.project_id, row.operation_id);
    if (readback === null || (!changed && (readback.state !== state || readback.phase !== phase))) unavailable();
    return readback;
  }

  async function readBuiltinSelection(request: ResearchCatalogModelUseRequest) {
    const [selected, page] = await Promise.all([
      input.project_configuration.readSelected(input.context, input.project_id),
      input.project_configuration.readPage(input.context, input.project_id, { limit: 1 }),
    ]);
    const summary = page.selected;
    const selections = selected?.configuration.model_selections ?? [];
    if (selected === null || summary === null || page.selection_revision === null ||
        selected.project_id !== input.project_id || selected.selection_revision !== page.selection_revision ||
        summary.qualification_state !== "qualified" || summary.configuration_ref !== selected.configuration_ref ||
        summary.configuration_sha256 !== selected.configuration_sha256 || selections.length < 2 ||
        selections.some((selection) => !isExactWorkersAiPolicy(selection.transport_policy, request.model_id))) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409,
        "Qualified native project configuration readback does not match the selected Workers AI catalog model");
    }
    return Object.freeze({ ref: selected.configuration_ref, sha256: selected.configuration_sha256,
      revision: selected.selection_revision });
  }

  async function installedBuiltinConfiguration(request: ResearchCatalogModelUseRequest) {
    const installed = await readInstalledNative(input.context.principal_ref, input.project_id);
    if (installed.model_selections.length < 2 || installed.model_selections.some((selection) =>
      !isExactWorkersAiPolicy(selection.transport_policy, request.model_id))) return null;
    const semanticSha = await modelGatewaySha256(installed.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
    const configuration = Object.freeze({
      protocol: "eliotr.research-project-model-configuration.v1" as const,
      semantic_revision: Object.freeze({ revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha }),
      model_selections: installed.model_selections,
      vars: installed.vars,
    });
    const target = await decodeResearchProjectModelConfigurationBundle(configuration);
    return Object.freeze({ configuration, target });
  }

  async function selectInstalledBuiltinDefault(
    request: ResearchCatalogModelUseRequest,
    initial: ResearchCatalogModelUseAuthorizationRow,
  ): Promise<ResearchCatalogModelUseReceipt> {
    let row = initial;
    if (["SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT"].includes(row.state)) return receiptFromAuthorization(row);
    if (row.state === "ACCEPTED") row = await transitionAuthorization(row, "PREPARING", "PROVIDER_RESOLUTION");

    let installed: Awaited<ReturnType<typeof installedBuiltinConfiguration>>;
    try {
      installed = await installedBuiltinConfiguration(request);
    } catch {
      if (input.builtin_native !== undefined) return receiptFromAuthorization(await input.builtin_native.run(row));
      row = await transitionAuthorization(row, "BLOCKED", "PROVIDER_RESOLUTION", "SERVER_POLICY_UNAVAILABLE");
      return receiptFromAuthorization(row);
    }
    if (installed === null) {
      if (input.builtin_native !== undefined) return receiptFromAuthorization(await input.builtin_native.run(row));
      row = await transitionAuthorization(row, "BLOCKED", "PROVIDER_RESOLUTION", "MODEL_NOT_SUPPORTED");
      return receiptFromAuthorization(row);
    }
    if (row.state === "PREPARING") row = await transitionAuthorization(row, "QUALIFYING", "QUALIFICATION");
    if (row.state === "IMPORTING") {
      const selected = await input.project_configuration.readSelected(input.context, input.project_id).catch(() => null);
      if (selected?.configuration_ref === installed.target.configuration_ref &&
          selected.configuration_sha256 === installed.target.configuration_sha256) {
        const selection = await readBuiltinSelection(request);
        row = await transitionAuthorization(row, "SELECTED", "COMPLETE", null, selection);
        return receiptFromAuthorization(row);
      }
    }
    if (row.state === "QUALIFYING") row = await transitionAuthorization(row, "IMPORTING", "CONFIGURATION_IMPORT");
    try {
      await input.project_configuration.importQualifiedConfiguration(input.context, input.project_id, {
        expected_revision: row.expected_selection_revision,
        configuration: installed.configuration,
      });
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { readonly code: unknown }).code) : "";
      if (/SELECTION.*CONFLICT|REVISION.*CONFLICT/u.test(code)) {
        row = await transitionAuthorization(row, "CONFLICT", "SELECTION_READBACK", "SELECTION_CAS_CONFLICT");
      } else {
        row = await transitionAuthorization(row, "BLOCKED", "CONFIGURATION_IMPORT", "SERVER_POLICY_UNAVAILABLE");
      }
      return receiptFromAuthorization(row);
    }
    const selection = await readBuiltinSelection(request);
    row = await transitionAuthorization(row, "SELECTED", "COMPLETE", null, selection);
    return receiptFromAuthorization(row);
  }

  async function useService(request: ResearchCatalogModelUseRequest, row: ResearchCatalogModelUseAuthorizationRow): Promise<
    Readonly<{ kind: "openrouter"; service: ResearchProviderKeyModelUseService }> |
    Readonly<{ kind: "provider-native-v2"; service: ResearchCatalogModelUseV2Service }>> {
    const selected = await configured(request);
    if (selected.kind === "openrouter") {
      return Object.freeze({ kind: "openrouter" as const, service: input.model_use(Object.freeze({ provider_id: request.provider_id,
        provider_operation_id: request.provider_operation_id as string, route_provider_id: selected.routeProviderId,
        model_id: request.model_id, transport_policy: selected.policy })) });
    }
    if (input.provider_native_v2 === undefined || gateway === undefined) {
      throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED", 409,
        "Trusted provider-native v2 qualification is unavailable");
    }
    if (request.provider_operation_id === null) throw new ResearchCatalogModelUseServiceError(
      "RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED", 409, "Built-in model use does not use a provider connection");
    const v2Request = Object.freeze({ ...request, provider_operation_id: request.provider_operation_id });
    return Object.freeze({ kind: "provider-native-v2" as const, service: input.provider_native_v2.model_use(Object.freeze({
      project_id: input.project_id, request: v2Request, binding: selected.binding,
      route_provider_id: selected.routeProviderId, account_id: gateway.account_id, gateway_id: gateway.gateway_id,
      request_sha256: row.request_sha256,
    })) });
  }

  return Object.freeze({
    async start(rawRequest: ResearchCatalogModelUseRequest): Promise<ResearchCatalogModelUseReceipt> {
      requireCurrentOwner();
      const parsed = ResearchCatalogModelUseRequestSchema.safeParse(rawRequest);
      if (!parsed.success) throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400,
        "Catalog model-use request is invalid");
      const request = parsed.data;
      const active = await store.readUnresolved(input.context.principal_ref, input.project_id);
      if (active !== null && active.operation_id !== request.operation_id) {
        throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_UNRESOLVED", 409,
          "Reconcile the existing catalog model-use operation before starting another");
      }
      const isBuiltin = request.provider_operation_id === null;
      const configuredProvider = isBuiltin ? null : await configured(request);
      const routeProviderId = configuredProvider?.routeProviderId ?? "workers-ai";
      const selected = await input.project_configuration.readSelected(input.context, input.project_id);
      const expectedRevision = selected?.selection_revision ?? null;
      if (expectedRevision !== request.expected_selection_revision) {
        throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 409,
          "Selected project configuration changed; refresh before choosing a catalog model");
      }
      const identity = {
        protocol: RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL,
        operation_id: request.operation_id,
        expected_selection_revision: request.expected_selection_revision,
        provider_id: request.provider_id,
        provider_operation_id: request.provider_operation_id,
        route_provider_id: routeProviderId,
        model_id: request.model_id,
      };
      const requestSha = await modelGatewaySha256(canonicalModelGatewayJson(identity));
      let row = await store.read(input.context.principal_ref, input.project_id, request.operation_id);
      if (row === null) {
        const project = await input.env.CORE_DB.prepare(
          "SELECT generation FROM project WHERE project_id=?1 LIMIT 1",
        ).bind(input.project_id).first<{ readonly generation: number }>();
        if (project === null || !Number.isSafeInteger(project.generation) || project.generation < 1 ||
            (!isBuiltin && gateway === undefined)) unavailable();
        const binding = configuredProvider?.binding;
        const bindingScope = isBuiltin ? undefined : installedGatewayIdentity(input.env.AI_GATEWAY_REASONING_URL);
        if (!isBuiltin && (binding === undefined || bindingScope === undefined)) unavailable();
        const createdAt = now();
        await store.insertIntent({
          owner_id: input.context.principal_ref, project_id: input.project_id, operation_id: request.operation_id,
          provider_id: request.provider_id, provider_operation_id: request.provider_operation_id,
          route_provider_id: routeProviderId, model_id: request.model_id,
          account_id: bindingScope?.account_id ?? null, gateway_id: bindingScope?.gateway_id ?? null,
          alias: binding?.alias ?? null, provider_config_id: binding?.provider_config_id ?? null,
          configuration_metadata_sha256: binding?.metadata_sha256 ?? null,
          request_sha256: requestSha, owner_credential_generation: input.context.credential_generation,
          project_generation: project.generation, deployment_generation: input.env.DEPLOYMENT_GENERATION,
          expected_selection_revision: expectedRevision, source_configuration_ref: selected?.configuration_ref ?? null,
          source_configuration_sha256: selected?.configuration_sha256 ?? null, created_at: createdAt,
        });
        row = await store.read(input.context.principal_ref, input.project_id, request.operation_id);
      }
      if (row === null || row.request_sha256 !== requestSha || row.provider_id !== request.provider_id ||
          row.provider_operation_id !== request.provider_operation_id || row.route_provider_id !== routeProviderId ||
          row.model_id !== request.model_id) {
        throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_IDEMPOTENCY_CONFLICT", 409,
          "Catalog model-use operation ID is bound to another provider/model selection");
      }
      if (row.owner_credential_generation !== input.context.credential_generation ||
          row.deployment_generation !== input.env.DEPLOYMENT_GENERATION) {
        throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_AUTHORITY_CHANGED", 409,
          "Original catalog model-use execution authority changed; use status reconciliation");
      }
      if (["SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT"].includes(row.state)) return receiptFromAuthorization(row);
      if (isBuiltin) return selectInstalledBuiltinDefault(request, row);
      const service = await useService(request, row);
      if (service.kind === "provider-native-v2") return persistV2Receipt(row, await service.service.start(), request);
      let keyReceipt: ResearchProviderKeyModelUseReceipt;
      try {
        keyReceipt = await service.service.start(request.provider_operation_id as string, {
          protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
          operation_id: request.operation_id,
          expected_selection_revision: request.expected_selection_revision,
        });
      } catch (cause) {
        if (!(cause instanceof ResearchProviderKeyModelUseServiceError) ||
            cause.code !== "PROVIDER_KEY_MODEL_USE_OPERATION_UNRESOLVED") throw cause;
        requireCurrentOwner();
        await requireCurrentStatusOwner(row);
        const closed = await store.blockIntentIfLegacyChildAbsent({ row, updated_at: now() });
        const readback = await store.read(row.owner_id, row.project_id, row.operation_id);
        if (readback === null) unavailable();
        await requireCurrentStatusOwner(readback);
        requireCurrentOwner();
        if (!closed || readback.state !== "BLOCKED" || readback.phase !== "PROVIDER_RESOLUTION" ||
            readback.failure_code !== "SERVER_POLICY_UNAVAILABLE") throw cause;
        return receiptFromAuthorization(readback);
      }
      return persistReceipt(row, keyReceipt, request);
    },
    async readCurrent(): Promise<ResearchCatalogModelUseReceipt | null> {
      requireCurrentOwner();
      const row = await store.readUnresolved(input.context.principal_ref, input.project_id);
      if (row === null) return null;
      await requireCurrentStatusOwner(row);
      const current = await reconcileStaleIntent(row);
      const reconciled = current.state === "UNCERTAIN" && input.reconcile_failed_qualification !== undefined
        ? await input.reconcile_failed_qualification(current) : current;
      return receiptFromAuthorization(reconciled);
    },
    async read(operationId: string): Promise<ResearchCatalogModelUseReceipt> {
      requireCurrentOwner();
      if (!OPERATION_ID.test(operationId)) throw new ResearchCatalogModelUseServiceError(
        "RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400, "Catalog model-use operation ID is invalid");
      const row = await store.read(input.context.principal_ref, input.project_id, operationId);
      if (row === null) throw new ResearchCatalogModelUseServiceError("RESEARCH_CATALOG_MODEL_USE_NOT_FOUND", 404,
        "Catalog model-use operation was not found");
      await requireCurrentStatusOwner(row);
      const current = await reconcileStaleIntent(row);
      const request: ResearchCatalogModelUseRequest = {
        protocol: RESEARCH_CATALOG_MODEL_USE_REQUEST_PROTOCOL, operation_id: current.operation_id,
        expected_selection_revision: current.expected_selection_revision, provider_id: current.provider_id,
        model_id: current.model_id, provider_operation_id: current.provider_operation_id,
      };
      if (current.provider_operation_id === null) {
        if (current.state === "IMPORTING") {
          try {
            const installed = await installedBuiltinConfiguration(request);
            if (installed !== null) {
              const selected = await input.project_configuration.readSelected(input.context, input.project_id);
              if (selected?.configuration_ref === installed.target.configuration_ref &&
                  selected.configuration_sha256 === installed.target.configuration_sha256) {
                const readback = await readBuiltinSelection(request);
                return receiptFromAuthorization(await transitionAuthorization(current, "SELECTED", "COMPLETE", null, readback));
              }
            }
          } catch { /* Status reads never retry the configuration import. */ }
        }
        return receiptFromAuthorization(current);
      }
      if (current.state === "UNCERTAIN" && input.reconcile_failed_qualification !== undefined) {
        return receiptFromAuthorization(await input.reconcile_failed_qualification(current));
      }
      if (["SELECTED", "BLOCKED", "UNCERTAIN", "CONFLICT"].includes(current.state)) return receiptFromAuthorization(current);
      // Original credential/deployment generations remain execution provenance.
      // A status read under a fresh context never resumes an old preparation.
      if (current.owner_credential_generation !== input.context.credential_generation ||
          current.deployment_generation !== input.env.DEPLOYMENT_GENERATION) return receiptFromAuthorization(current);
      const service = await useService(request, current);
      if (service.kind === "provider-native-v2") return persistV2Receipt(current, await service.service.read(), request);
      try {
        const keyReceipt = await service.service.read(operationId);
        return persistReceipt(current, keyReceipt, request);
      } catch (error) {
        if (error instanceof ResearchProviderKeyModelUseServiceError && error.status === 404) return receiptFromAuthorization(current);
        throw error;
      }
    },
  });
}
