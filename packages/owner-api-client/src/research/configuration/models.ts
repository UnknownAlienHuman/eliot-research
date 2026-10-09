/**
 * C3-RC research model catalog, saved project configuration and model selection.
 *
 * Mechanically moved from packages/pwa-research-workspace/src/research-model-configuration-api.ts.
 * Every strict decoder rule, the bounded JSON reader, each size bound, each error code, the
 * compare-and-swap expected_revision and the receipt identity check are preserved unchanged.
 *
 * One deliberate change, required by the client rule that no caller mints ambient randomness: the
 * selection operation no longer builds its idempotency key from crypto.randomUUID. The key is now a
 * required caller-supplied argument, which keeps operation identity outside this module.
 */

import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http';
import type { EpochPort } from '../../transport/client';
import { createTransportPolicyDecoder } from './transport-policy';
import type { ResearchModelEffectiveReasoningEffort, ResearchModelTransportPolicy } from './transport-policy';

export type { ResearchModelEffectiveReasoningEffort, ResearchModelTransportPolicy };
export {
  researchModelSelectionApiLabel,
  researchModelSelectionBillingLabel,
  researchModelSelectionEffortLabel,
} from './transport-policy';

export const RESEARCH_MODEL_CATALOG_PROTOCOL = 'eliotr.research-model-catalog.v1' as const;
export const RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL =
  'eliotr.research-project-model-configuration.v1' as const;
export const WORKERS_AI_ROUTE_PROVIDER_ID = 'workers-ai' as const;
export const WORKERS_AI_CATALOG_ADAPTER_ID = 'cloudflare-workers-ai' as const;

const MODEL_CATALOG_PATH = '/api/v1/system/research-models';
const CONFIGURATION_PATH = '/api/v1/research/projects';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODEL_IDENTIFIER = /^(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}|[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255})$/u;
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/u;
const MAX_CATALOG_STRING_BYTES = 8_192;
const MAX_PROPERTY_DEPTH = 8;
const MAX_PROPERTY_NODES = 1_024;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonRecord = Record<string, unknown>;
/** Maps the known Workers AI route identity to its separate catalog adapter ID. */
export function researchModelCatalogAdapterForRouteProvider(routeProviderId: string): string {
  return routeProviderId === WORKERS_AI_ROUTE_PROVIDER_ID ? WORKERS_AI_CATALOG_ADAPTER_ID : routeProviderId;
}

export type ResearchModelCapability = 'supported' | 'unsupported' | 'unknown';

export type ResearchModelCatalogEntry = Readonly<{
  provider_id: string;
  model_id: string;
  name: string;
  description: string;
  catalog_availability: 'listed';
  account_availability: 'unverified' | 'unknown';
  capabilities: Readonly<{
    text_generation: ResearchModelCapability;
    input_output_schema: 'available_from_transport' | 'not_exposed_by_workers_ai_binding' | 'unknown';
    schema_requirement: string | null;
  }>;
  source_id: number | null;
  source_task: Readonly<{ id: string; name: string; description: string }> | null;
  billing: Readonly<{
    selected_path: 'workers_ai_binding' | 'provider_catalog';
    support: 'byok' | 'unified_billing' | 'unknown';
    account_entitlement: 'not_established_by_catalog';
  }>;
  properties: readonly Readonly<{ property_id: string; value: JsonValue }> [];
  tags: readonly string[];
}>;

export type ResearchModelCatalogPage = Readonly<{
  protocol: typeof RESEARCH_MODEL_CATALOG_PROTOCOL;
  project_id: string;
  task: 'text-generation';
  catalog_scope: 'workers_ai' | 'external_provider';
  provider_id: string;
  models: readonly ResearchModelCatalogEntry[];
  pagination: Readonly<{
    page: number;
    per_page: number;
    has_more: boolean | null;
    next_page: number | null;
    coverage: 'complete' | 'partial' | 'unknown';
    probe: 'next_page_empty' | 'next_page_non_empty' | 'next_page_unavailable' | 'provider_reported';
  }>;
}>;

export type ResearchModelSelectionSummary = Readonly<{
  candidate_kind?: 'provider-native-v1';
  stage: 'ANALYZE_BRANCHES' | 'COUNTER_SEARCH' | 'SYNTHESIZE' | 'AUDIT_CLAIMS';
  route_ref: string;
  route_version: string;
  candidate_ref: string;
  candidate_sha256: string;
  qualification_ref: string;
  qualification_sha256: string;
  provider_id: string;
  model_id: string;
  effective_reasoning_effort: ResearchModelEffectiveReasoningEffort | null;
  transport_policy: ResearchModelTransportPolicy;
}>;

export type ResearchModelConfigurationRevision = Readonly<{
  configuration_ref: string;
  configuration_sha256: string;
  created_at: string;
  qualification_state: 'qualified' | 'qualification_required';
  semantic_revision: Readonly<{ revision_ref: string; config_sha256: string }>;
  model_selections: readonly ResearchModelSelectionSummary[];
}>;

export type ResearchProjectModelConfiguration = Readonly<{
  protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  project_id: string;
  selection_revision: number | null;
  selected: ResearchModelConfigurationRevision | null;
  revisions: readonly ResearchModelConfigurationRevision[];
  next_cursor: string | null;
}>;

export type ResearchProjectModelConfigurationSelection = Readonly<{
  protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  project_id: string;
  selection_revision: number;
  selected: ResearchModelConfigurationRevision;
}>;

export interface ResearchModelCatalogRequest {
  readonly search?: string;
  readonly page?: number;
  readonly perPage?: number;
  readonly providerId?: string;
}

export interface ResearchProjectModelConfigurationRequest {
  readonly limit?: number;
  readonly after?: string;
}

export type ModelsHttp = Pick<LegacyHttpAdapter, 'requestApiWithStatuses'>;

export function createResearchModelConfigurationApi(
  http: ModelsHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
) {
  const transportPolicy = createTransportPolicyDecoder(errors);

  function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function schemaMismatch(message: string): never {
    throw errors({
      status: 502,
      code: 'API_RESPONSE_SCHEMA_MISMATCH',
      message,
      traceId: null,
      retryable: false,
    });
  }

  function stale(): never {
    throw errors({
      code: 'API_SESSION_CLOSED',
      status: 503,
      message: 'Response belongs to a closed owner session',
      traceId: null,
      retryable: false,
    });
  }

  function generationMismatch(message: string): never {
    throw errors({
      status: 409,
      code: 'API_GENERATION_MISMATCH',
      message,
      traceId: null,
      retryable: true,
    });
  }

  function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
    if (!isRecord(value) || Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !keys.includes(key))) {
      schemaMismatch(`${label} has missing or unknown fields`);
    }
    return value;
  }

  function boundedText(value: unknown, label: string, maxBytes = MAX_CATALOG_STRING_BYTES, allowEmpty = false): string {
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
        new TextEncoder().encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
      schemaMismatch(`${label} is invalid`);
    }
    return value;
  }

  function readIdentifier(value: unknown, label: string): string {
    const text = boundedText(value, label, 256);
    if (!IDENTIFIER.test(text)) schemaMismatch(`${label} is invalid`);
    return text;
  }

  function generation(value: unknown): string {
    return readIdentifier(value, 'deployment_generation');
  }

  function readJsonValue(value: unknown, depth: number, budget: { nodes: number; bytes: number }): JsonValue {
    if (depth > MAX_PROPERTY_DEPTH || --budget.nodes < 0) schemaMismatch('catalog property exceeds its structure bound');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      budget.bytes -= new TextEncoder().encode(value).byteLength;
      if (budget.bytes < 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
        schemaMismatch('catalog property exceeds its string bound');
      }
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) schemaMismatch('catalog property contains an invalid number');
      return value;
    }
    if (Array.isArray(value)) return Object.freeze(value.map((item) => readJsonValue(item, depth + 1, budget)));
    if (isRecord(value)) {
      if (Object.keys(value).length > 128) schemaMismatch('catalog property has too many members');
      const output = Object.create(null) as Record<string, JsonValue>;
      for (const [key, item] of Object.entries(value)) {
        budget.bytes -= new TextEncoder().encode(key).byteLength;
        if (budget.bytes < 0 || /[\u0000-\u001f\u007f]/u.test(key)) schemaMismatch('catalog property exceeds its object bound');
        output[key] = readJsonValue(item, depth + 1, budget);
      }
      return Object.freeze(output);
    }
    return schemaMismatch('catalog property is not JSON data');
  }

  function isCapability(value: unknown): value is ResearchModelCapability {
    return value === 'supported' || value === 'unsupported' || value === 'unknown';
  }

  function assertId(value: string, label: string): string {
    if (typeof value !== 'string' || !IDENTIFIER.test(value) || /[\u0000-\u0020\u007f]/u.test(value)) {
      throw errors({
        status: 400,
        code: 'MODEL_CONFIGURATION_INPUT_INVALID',
        message: `${label} is invalid.`,
        traceId: null,
        retryable: false,
      });
    }
    return value;
  }

  function sha256(value: unknown, label: string): string {
    const text = boundedText(value, label, 64);
    if (!/^[a-f0-9]{64}$/u.test(text)) schemaMismatch(`${label} must be a lowercase SHA-256 digest`);
    return text;
  }

  function timestamp(value: unknown, label: string): string {
    const text = boundedText(value, label, 64);
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) schemaMismatch(`${label} is not a canonical timestamp`);
    return text;
  }

  /** Preflight fence: an already-closed session never starts a request. */
  function currentOrStale(): ReturnType<EpochPort['capture']> {
    const captured = epoch.capture();
    if (!epoch.isCurrent(captured)) stale();
    return captured;
  }

  function decodeEntry(value: unknown): ResearchModelCatalogEntry {
    const raw = exactRecord(value, [
      'provider_id', 'model_id', 'name', 'description', 'catalog_availability', 'account_availability',
      'capabilities', 'source_id', 'source_task', 'billing', 'properties', 'tags',
    ], 'catalog model');
    const providerId = boundedText(raw.provider_id, 'provider_id', 64);
    if (!PROVIDER_IDENTIFIER.test(providerId)) schemaMismatch('provider_id is invalid');
    const modelId = boundedText(raw.model_id, 'model_id', 256);
    if (!MODEL_IDENTIFIER.test(modelId)) schemaMismatch('model_id is invalid');
    if (raw.catalog_availability !== 'listed' ||
        (raw.account_availability !== 'unverified' && raw.account_availability !== 'unknown')) {
      schemaMismatch('catalog availability state is invalid');
    }
    const capabilities = exactRecord(raw.capabilities, ['text_generation', 'input_output_schema', 'schema_requirement'], 'catalog capabilities');
    if (!isCapability(capabilities.text_generation) ||
        (capabilities.input_output_schema !== 'available_from_transport' &&
         capabilities.input_output_schema !== 'not_exposed_by_workers_ai_binding' && capabilities.input_output_schema !== 'unknown')) {
      schemaMismatch('catalog capabilities are invalid');
    }
    const schemaRequirement = capabilities.schema_requirement === null ? null :
      boundedText(capabilities.schema_requirement, 'schema_requirement', 512);
    if ((capabilities.input_output_schema === 'not_exposed_by_workers_ai_binding' &&
        schemaRequirement !== 'GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}') ||
        (capabilities.input_output_schema !== 'not_exposed_by_workers_ai_binding' && schemaRequirement !== null)) {
      schemaMismatch('catalog schema requirement does not match its capability');
    }
    if (raw.source_id !== null && (!Number.isSafeInteger(raw.source_id) || (raw.source_id as number) < 0)) {
      schemaMismatch('source_id is invalid');
    }
    let sourceTask: ResearchModelCatalogEntry['source_task'] = null;
    if (raw.source_task !== null) {
      const task = exactRecord(raw.source_task, ['id', 'name', 'description'], 'catalog source task');
      sourceTask = Object.freeze({ id: boundedText(task.id, 'task id', 256),
        name: boundedText(task.name, 'task name', 256), description: boundedText(task.description, 'task description', 2_048, true) });
    }
    const billing = exactRecord(raw.billing, ['selected_path', 'support', 'account_entitlement'], 'catalog billing');
    if ((billing.selected_path !== 'workers_ai_binding' && billing.selected_path !== 'provider_catalog') ||
        (billing.support !== 'byok' && billing.support !== 'unified_billing' && billing.support !== 'unknown') ||
        billing.account_entitlement !== 'not_established_by_catalog') schemaMismatch('catalog billing is invalid');
    if (!Array.isArray(raw.properties) || raw.properties.length > 128) schemaMismatch('catalog properties are invalid');
    const properties = raw.properties.map((item, index) => {
      const property = exactRecord(item, ['property_id', 'value'], `catalog property ${index}`);
      return Object.freeze({ property_id: boundedText(property.property_id, 'property_id', 256),
        value: readJsonValue(property.value, 0, { nodes: MAX_PROPERTY_NODES, bytes: 16_384 }) });
    });
    if (!Array.isArray(raw.tags) || raw.tags.length > 64) schemaMismatch('catalog tags are invalid');
    const tags = raw.tags.map((tag, index) => boundedText(tag, `catalog tag ${index}`, 256));
    if (new Set(tags).size !== tags.length ||
        new Set(properties.map((property) => property.property_id)).size !== properties.length) {
      schemaMismatch('catalog contains duplicate properties or tags');
    }
    return Object.freeze({
      provider_id: providerId,
      model_id: modelId,
      name: boundedText(raw.name, 'model name', 512),
      description: boundedText(raw.description, 'model description', 8_192, true),
      catalog_availability: 'listed',
      account_availability: raw.account_availability,
      capabilities: Object.freeze({ text_generation: capabilities.text_generation,
        input_output_schema: capabilities.input_output_schema, schema_requirement: schemaRequirement }),
      source_id: raw.source_id as number | null,
      source_task: sourceTask,
      billing: Object.freeze({ selected_path: billing.selected_path, support: billing.support,
        account_entitlement: 'not_established_by_catalog' }),
      properties: Object.freeze(properties),
      tags: Object.freeze(tags),
    });
  }

  /** Preflight for the catalog request is the caller's epoch check; decode stays pure. */
  function decodeCatalog(value: unknown, expectedGeneration: string, expectedProject: string,
    request: ResearchModelCatalogRequest): ResearchModelCatalogPage {
    const envelope = exactRecord(value, ['data', 'trace_id', 'deployment_generation'], 'catalog envelope');
    if (typeof envelope.trace_id !== 'string' || !TRACE_ID.test(envelope.trace_id)) schemaMismatch('catalog trace_id is invalid');
    if (generation(envelope.deployment_generation) !== expectedGeneration) {
      generationMismatch('Deployment changed. Refresh the model catalog.');
    }
    const data = exactRecord(envelope.data, ['protocol', 'project_id', 'task', 'catalog_scope', 'provider_id', 'models', 'pagination'], 'catalog response');
    const projectId = readIdentifier(data.project_id, 'project_id');
    const providerId = boundedText(data.provider_id, 'provider_id', 64);
    if (data.protocol !== RESEARCH_MODEL_CATALOG_PROTOCOL || projectId !== expectedProject ||
        data.task !== 'text-generation' || !PROVIDER_IDENTIFIER.test(providerId) ||
        (data.catalog_scope !== 'workers_ai' && data.catalog_scope !== 'external_provider') ||
        (request.providerId !== undefined && request.providerId !== providerId) ||
        ((providerId === WORKERS_AI_CATALOG_ADAPTER_ID) !== (data.catalog_scope === 'workers_ai'))) {
      schemaMismatch('catalog response identity is inconsistent');
    }
    if (!Array.isArray(data.models) || data.models.length > (request.perPage ?? 20)) schemaMismatch('catalog model page is invalid');
    const models = data.models.map(decodeEntry);
    if (models.some((model) => model.provider_id !== providerId ||
        (data.catalog_scope === 'workers_ai') !== (model.billing.selected_path === 'workers_ai_binding') ||
        ((data.catalog_scope === 'workers_ai') !== (model.source_id !== null && model.source_task !== null)) ||
        (data.catalog_scope === 'workers_ai' && model.capabilities.text_generation !== 'supported')) ||
        new Set(models.map((model) => model.model_id)).size !== models.length) {
      schemaMismatch('catalog model identities are inconsistent');
    }
    const pagination = exactRecord(data.pagination, ['page', 'per_page', 'has_more', 'next_page', 'coverage', 'probe'], 'catalog pagination');
    if (!Number.isSafeInteger(pagination.page) || (pagination.page as number) < 1 ||
        !Number.isSafeInteger(pagination.per_page) || (pagination.per_page as number) < 1 || (pagination.per_page as number) > 50 ||
        (pagination.has_more !== true && pagination.has_more !== false && pagination.has_more !== null) ||
        (pagination.next_page !== null && (!Number.isSafeInteger(pagination.next_page) || (pagination.next_page as number) < 1)) ||
        (pagination.coverage !== 'complete' && pagination.coverage !== 'partial' && pagination.coverage !== 'unknown') ||
        (pagination.probe !== 'next_page_empty' && pagination.probe !== 'next_page_non_empty' &&
         pagination.probe !== 'next_page_unavailable' && pagination.probe !== 'provider_reported')) {
      schemaMismatch('catalog pagination fields are invalid');
    }
    const page = pagination.page as number;
    const perPage = pagination.per_page as number;
    const expectedPage = request.page ?? 1;
    const expectedPerPage = request.perPage ?? 20;
    const expectedCoverage = pagination.has_more === null ? 'unknown' : pagination.has_more || page !== 1 ? 'partial' : 'complete';
    const expectedProbe = pagination.has_more === null ? 'next_page_unavailable' : data.catalog_scope === 'external_provider'
      ? 'provider_reported' : pagination.has_more ? 'next_page_non_empty' : 'next_page_empty';
    if (page !== expectedPage || perPage !== expectedPerPage || pagination.coverage !== expectedCoverage ||
        pagination.next_page !== (pagination.has_more === true ? page + 1 : null) || pagination.probe !== expectedProbe) {
      schemaMismatch('catalog pagination is inconsistent with the requested page');
    }
    return Object.freeze({ protocol: RESEARCH_MODEL_CATALOG_PROTOCOL, project_id: projectId, task: 'text-generation',
      catalog_scope: data.catalog_scope, provider_id: providerId, models: Object.freeze(models),
      pagination: Object.freeze({ page, per_page: perPage, has_more: pagination.has_more,
        next_page: pagination.next_page as number | null, coverage: pagination.coverage, probe: pagination.probe }) });
  }
  function decodeModelSelection(value: unknown): ResearchModelSelectionSummary {
    if (!isRecord(value)) schemaMismatch('model selection is invalid');
    const native = Object.hasOwn(value, 'candidate_kind');
    const legacySummary = !Object.hasOwn(value, 'effective_reasoning_effort');
    const keys = [...(native ? ['candidate_kind'] : []), 'stage', 'route_ref', 'route_version', 'candidate_ref', 'candidate_sha256',
      'qualification_ref', 'qualification_sha256', 'provider_id', 'model_id', 'transport_policy',
      ...(legacySummary ? [] : ['effective_reasoning_effort'])];
    const raw = exactRecord(value, keys, 'model selection');
    if (native && raw.candidate_kind !== 'provider-native-v1') schemaMismatch('model selection candidate kind is unsupported');
    const stages = ['ANALYZE_BRANCHES', 'COUNTER_SEARCH', 'SYNTHESIZE', 'AUDIT_CLAIMS'] as const;
    if (!stages.includes(raw.stage as typeof stages[number])) schemaMismatch('model selection stage is invalid');
    const providerId = boundedText(raw.provider_id, 'provider_id', 64);
    if (!PROVIDER_IDENTIFIER.test(providerId)) schemaMismatch('model selection provider_id is invalid');
    const modelId = boundedText(raw.model_id, 'model_id', 256);
    if (!MODEL_IDENTIFIER.test(modelId)) schemaMismatch('model selection model_id is invalid');
    const effort = legacySummary ? null : raw.effective_reasoning_effort;
    if (effort !== null && effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'max') {
      schemaMismatch('effective reasoning effort is invalid');
    }
    const policy = transportPolicy.decodeResearchModelTransportPolicy(raw.transport_policy);
    if (providerId !== policy.provider || modelId !== policy.model) {
      schemaMismatch('model selection identity does not match its transport policy');
    }
    if (native && (policy.api !== 'openrouter-chat-completions' || policy.provider !== 'openrouter' ||
        policy.billing.mode !== 'byok' || policy.billing.free_only !== true)) {
      schemaMismatch('native model selection requires a free-only OpenRouter BYOK transport policy');
    }
    return Object.freeze({ ...(native ? { candidate_kind: 'provider-native-v1' as const } : {}),
      stage: raw.stage as ResearchModelSelectionSummary['stage'],
      route_ref: readIdentifier(raw.route_ref, 'route_ref'), route_version: readIdentifier(raw.route_version, 'route_version'),
      candidate_ref: readIdentifier(raw.candidate_ref, 'candidate_ref'), candidate_sha256: sha256(raw.candidate_sha256, 'candidate_sha256'),
      qualification_ref: readIdentifier(raw.qualification_ref, 'qualification_ref'), qualification_sha256: sha256(raw.qualification_sha256, 'qualification_sha256'),
      provider_id: providerId, model_id: modelId, effective_reasoning_effort: effort as ResearchModelSelectionSummary['effective_reasoning_effort'],
      transport_policy: policy });
  }

  function decodeConfigurationRevision(value: unknown): ResearchModelConfigurationRevision {
    const raw = exactRecord(value, ['configuration_ref', 'configuration_sha256', 'created_at', 'qualification_state', 'semantic_revision', 'model_selections'], 'saved model configuration');
    if (raw.qualification_state !== 'qualified' && raw.qualification_state !== 'qualification_required') {
      schemaMismatch('saved model configuration qualification state is invalid');
    }
    const semantic = exactRecord(raw.semantic_revision, ['revision_ref', 'config_sha256'], 'semantic revision');
    if (!Array.isArray(raw.model_selections) || raw.model_selections.length === 0 || raw.model_selections.length > 16) {
      schemaMismatch('saved model selections are invalid');
    }
    const modelSelections = raw.model_selections.map(decodeModelSelection);
    if (new Set(modelSelections.map((selection) => selection.stage)).size !== modelSelections.length) {
      schemaMismatch('saved model configuration contains duplicate stages');
    }
    return Object.freeze({ configuration_ref: readIdentifier(raw.configuration_ref, 'configuration_ref'),
      configuration_sha256: sha256(raw.configuration_sha256, 'configuration_sha256'), created_at: timestamp(raw.created_at, 'created_at'),
      qualification_state: raw.qualification_state,
      semantic_revision: Object.freeze({ revision_ref: readIdentifier(semantic.revision_ref, 'semantic revision_ref'),
        config_sha256: sha256(semantic.config_sha256, 'semantic config_sha256') }),
      model_selections: Object.freeze(modelSelections) });
  }

  function decodeProjectConfiguration(value: unknown, expectedGeneration: string, expectedProject: string,
    limit: number): ResearchProjectModelConfiguration {
    const envelope = exactRecord(value, ['data', 'trace_id', 'deployment_generation'], 'project model configuration envelope');
    if (typeof envelope.trace_id !== 'string' || !TRACE_ID.test(envelope.trace_id)) schemaMismatch('project model configuration trace_id is invalid');
    if (generation(envelope.deployment_generation) !== expectedGeneration) {
      generationMismatch('Deployment changed. Refresh project model configuration.');
    }
    const raw = exactRecord(envelope.data, ['protocol', 'project_id', 'selection_revision', 'selected', 'revisions', 'next_cursor'], 'project model configuration');
    const projectId = readIdentifier(raw.project_id, 'project_id');
    if (raw.protocol !== RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL || projectId !== expectedProject ||
        (raw.selection_revision !== null && (!Number.isSafeInteger(raw.selection_revision) || (raw.selection_revision as number) < 0)) ||
        !Array.isArray(raw.revisions) || raw.revisions.length > limit) schemaMismatch('project model configuration identity or revisions are invalid');
    const revisions = raw.revisions.map(decodeConfigurationRevision);
    if (new Set(revisions.map((revision) => revision.configuration_ref)).size !== revisions.length) {
      schemaMismatch('project model configuration contains duplicate refs');
    }
    const selected = raw.selected === null ? null : decodeConfigurationRevision(raw.selected);
    const selectedListed = selected === null ? undefined : revisions.find((revision) => revision.configuration_ref === selected.configuration_ref);
    if (selectedListed && selectedListed.configuration_sha256 !== selected?.configuration_sha256) {
      schemaMismatch('selected model configuration differs from its saved revision');
    }
    if (raw.next_cursor !== null && (typeof raw.next_cursor !== 'string' || raw.next_cursor.length === 0 ||
        raw.next_cursor.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(raw.next_cursor))) {
      schemaMismatch('project model configuration cursor is invalid');
    }
    if ((raw.selection_revision === null) !== (selected === null)) schemaMismatch('project model selection revision is inconsistent');
    return Object.freeze({ protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL, project_id: projectId,
      selection_revision: raw.selection_revision as number | null, selected, revisions: Object.freeze(revisions),
      next_cursor: raw.next_cursor as string | null });
  }

  function decodeSelectionReceipt(value: unknown, expectedGeneration: string, expectedProject: string,
    expectedConfiguration: string): ResearchProjectModelConfigurationSelection {
    const envelope = exactRecord(value, ['data', 'trace_id', 'deployment_generation'], 'project model selection envelope');
    if (typeof envelope.trace_id !== 'string' || !TRACE_ID.test(envelope.trace_id)) schemaMismatch('project model selection trace_id is invalid');
    if (generation(envelope.deployment_generation) !== expectedGeneration) {
      generationMismatch('Deployment changed. Refresh project model configuration.');
    }
    const raw = exactRecord(envelope.data, ['protocol', 'project_id', 'selection_revision', 'selected'], 'project model selection receipt');
    const projectId = readIdentifier(raw.project_id, 'project_id');
    if (raw.protocol !== RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL || projectId !== expectedProject ||
        !Number.isSafeInteger(raw.selection_revision) || (raw.selection_revision as number) < 0) {
      schemaMismatch('project model selection receipt identity is invalid');
    }
    const selected = decodeConfigurationRevision(raw.selected);
    if (selected.configuration_ref !== expectedConfiguration) schemaMismatch('selection receipt does not match the requested configuration');
    return Object.freeze({ protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL, project_id: projectId,
      selection_revision: raw.selection_revision as number, selected });
  }

  function projectConfigurationPath(projectId: string): string {
    return `${CONFIGURATION_PATH}/${encodeURIComponent(assertId(projectId, 'Project id'))}/model-configuration`;
  }

  async function readResearchModelCatalog(projectId: string, expectedGeneration: string,
    request: ResearchModelCatalogRequest = {}, signal?: AbortSignal): Promise<ResearchModelCatalogPage> {
    const captured = currentOrStale();
    assertId(projectId, 'Project id');
    assertId(expectedGeneration, 'Deployment generation');
    if (request.providerId !== undefined && (typeof request.providerId !== 'string' || !PROVIDER_IDENTIFIER.test(request.providerId))) {
      throw errors({
        status: 400,
        code: 'MODEL_CONFIGURATION_INPUT_INVALID',
        message: 'Provider id is invalid.',
        traceId: null,
        retryable: false,
      });
    }
    const catalogAdapterId = request.providerId === undefined ? undefined : researchModelCatalogAdapterForRouteProvider(request.providerId);
    const page = request.page ?? 1, perPage = request.perPage ?? 20;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 50) {
      throw errors({
        status: 400,
        code: 'MODEL_CONFIGURATION_INPUT_INVALID',
        message: 'Catalog page bounds are invalid.',
        traceId: null,
        retryable: false,
      });
    }
    const params = new URLSearchParams({ project_id: projectId, page: String(page), per_page: String(perPage), task: 'text-generation' });
    if (catalogAdapterId !== undefined) params.set('provider_id', catalogAdapterId);
    if (request.search !== undefined) {
      if (typeof request.search !== 'string' || new TextEncoder().encode(request.search).byteLength > 512 ||
          /[\u0000-\u001f\u007f]/u.test(request.search)) {
        throw errors({
          status: 400,
          code: 'MODEL_CONFIGURATION_INPUT_INVALID',
          message: 'Catalog search is invalid.',
          traceId: null,
          retryable: false,
        });
      }
      if (request.search.trim()) params.set('search', request.search.trim());
    }
    const raw = await http.requestApiWithStatuses(`${MODEL_CATALOG_PATH}?${params.toString()}`, {
      method: 'GET', ...(signal === undefined ? {} : { signal }),
    }, [200]);
    const normalized = { ...request, ...(catalogAdapterId === undefined ? {} : { providerId: catalogAdapterId }), page, perPage };
    const result = decodeCatalog(raw, expectedGeneration, projectId, normalized);
    if (!epoch.isCurrent(captured)) stale();
    return result;
  }

  async function readResearchProjectModelConfiguration(projectId: string, expectedGeneration: string,
    request: ResearchProjectModelConfigurationRequest = {}, signal?: AbortSignal): Promise<ResearchProjectModelConfiguration> {
    const captured = currentOrStale();
    assertId(projectId, 'Project id');
    assertId(expectedGeneration, 'Deployment generation');
    const limit = request.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
        (request.after !== undefined && (typeof request.after !== 'string' || request.after.length === 0 ||
          request.after.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(request.after)))) {
      throw errors({
        status: 400,
        code: 'MODEL_CONFIGURATION_INPUT_INVALID',
        message: 'Saved model configuration page is invalid.',
        traceId: null,
        retryable: false,
      });
    }
    const params = new URLSearchParams({ limit: String(limit) });
    if (request.after !== undefined) params.set('after', request.after);
    const raw = await http.requestApiWithStatuses(`${projectConfigurationPath(projectId)}?${params.toString()}`, {
      method: 'GET', ...(signal === undefined ? {} : { signal }),
    }, [200]);
    const result = decodeProjectConfiguration(raw, expectedGeneration, projectId, limit);
    if (!epoch.isCurrent(captured)) stale();
    return result;
  }

  /**
   * idempotencyKey is required and caller-supplied. The original module minted it inline with
   * crypto.randomUUID, which is ambient randomness a browser module must not own.
   */
  async function selectResearchProjectModelConfiguration(
    projectId: string,
    expectedGeneration: string,
    expectedRevision: number | null,
    configurationRef: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ResearchProjectModelConfigurationSelection> {
    const captured = currentOrStale();
    assertId(expectedGeneration, 'Deployment generation');
    assertId(configurationRef, 'Configuration ref');
    assertId(idempotencyKey, 'Idempotency key');
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
      throw errors({
        status: 400,
        code: 'MODEL_CONFIGURATION_INPUT_INVALID',
        message: 'Selection revision is invalid.',
        traceId: null,
        retryable: false,
      });
    }
    const body = JSON.stringify({ expected_revision: expectedRevision, select_configuration_ref: configurationRef });
    const raw = await http.requestApiWithStatuses(projectConfigurationPath(projectId), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-eliotr-csrf': '1' },
      body,
      ...(signal === undefined ? {} : { signal }),
    }, [200]);
    const result = decodeSelectionReceipt(raw, expectedGeneration, projectId, configurationRef);
    if (!epoch.isCurrent(captured)) stale();
    return result;
  }

  return {
    readResearchModelCatalog,
    readResearchProjectModelConfiguration,
    selectResearchProjectModelConfiguration,
  };
}
