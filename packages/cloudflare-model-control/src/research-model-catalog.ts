import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

export const RESEARCH_MODEL_CATALOG_PROTOCOL = "eliotr.research-model-catalog.v1" as const;
export const RESEARCH_MODEL_CATALOG_TASK = "text-generation" as const;
const WORKERS_AI_TASK = "Text Generation";

const MAX_PAGE = 100_000;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_BYTES = 512;
const MAX_PROJECT_ID_BYTES = 256;
const MAX_PROVIDER_ID_BYTES = 64;
const MAX_MODEL_STRING_BYTES = 8_192;
const MAX_MODEL_PROPERTY_BYTES = 16_384;
const MAX_PROPERTY_DEPTH = 8;
const MAX_PROPERTY_NODES = 1_024;
const MAX_MODEL_PROPERTIES = 128;
const MAX_MODEL_TAGS = 64;
const MAX_RESPONSE_BYTES = 262_144;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MODEL_IDENTIFIER = /^(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}|[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255})$/u;
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/u;

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type CapabilityState = "supported" | "unsupported" | "unknown";
type BillingSupport = "byok" | "unified_billing" | "unknown";

/** Narrow to the official Workers AI binding method present in the pinned Workers types. */
export type WorkersAiModelCatalogBinding = Pick<Ai, "models">;

export interface ResearchModelCatalogQuery {
  readonly search?: string;
  readonly page?: number;
  readonly per_page?: number;
  /** The service only accepts its bounded text-generation catalog. */
  readonly task?: typeof RESEARCH_MODEL_CATALOG_TASK;
}

export interface ResearchModelCatalogEntry {
  readonly provider_id: string;
  readonly model_id: string;
  readonly name: string;
  readonly description: string;
  readonly catalog_availability: "listed";
  readonly account_availability: "unverified" | "unknown";
  readonly capabilities: {
    readonly text_generation: CapabilityState;
    readonly input_output_schema: "available_from_transport" | "not_exposed_by_workers_ai_binding" | "unknown";
    readonly schema_requirement: "GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}" | null;
  };
  readonly source_id: number | null;
  readonly source_task: { readonly id: string; readonly name: string; readonly description: string } | null;
  readonly billing: {
    readonly selected_path: "workers_ai_binding" | "provider_catalog";
    readonly support: BillingSupport;
    readonly account_entitlement: "not_established_by_catalog";
  };
  readonly properties: readonly { readonly property_id: string; readonly value: JsonValue }[];
  readonly tags: readonly string[];
}

export interface ResearchModelCatalogPage {
  readonly protocol: typeof RESEARCH_MODEL_CATALOG_PROTOCOL;
  readonly project_id: string;
  readonly task: typeof RESEARCH_MODEL_CATALOG_TASK;
  readonly catalog_scope: "workers_ai" | "external_provider";
  readonly provider_id: string;
  readonly models: readonly ResearchModelCatalogEntry[];
  readonly pagination: {
    readonly page: number;
    readonly per_page: number;
    readonly has_more: boolean | null;
    readonly next_page: number | null;
    readonly coverage: "complete" | "partial" | "unknown";
    readonly probe: "next_page_empty" | "next_page_non_empty" | "next_page_unavailable" | "provider_reported";
  };
}

/**
 * An optional adapter around an official provider catalog/package. The core
 * service deliberately does not invent a Cloudflare-wide third-party endpoint.
 */
export interface ExternalProviderCatalogTransport {
  readonly provider_id: string;
  listTextGeneration(input: {
    readonly search?: string;
    readonly page: number;
    readonly per_page: number;
    readonly task: typeof RESEARCH_MODEL_CATALOG_TASK;
    readonly signal?: AbortSignal;
  }): Promise<ExternalProviderCatalogPage>;
}

export interface ExternalProviderCatalogPage {
  readonly models: readonly ExternalProviderCatalogModel[];
  /** null means the provider transport could not establish whether another page exists. */
  readonly has_more: boolean | null;
}

export interface ExternalProviderCatalogModel {
  readonly model_id: string;
  readonly name: string;
  readonly description: string;
  readonly text_generation: CapabilityState;
  readonly billing_support: BillingSupport;
  readonly properties?: readonly { readonly property_id: string; readonly value: JsonValue }[];
  readonly tags?: readonly string[];
}

export type ResearchModelCatalogErrorCode =
  | "MODEL_CATALOG_OWNER_REQUIRED"
  | "MODEL_CATALOG_PROJECT_INVALID"
  | "MODEL_CATALOG_PROJECT_NOT_FOUND"
  | "MODEL_CATALOG_REQUEST_INVALID"
  | "MODEL_CATALOG_WORKERS_AI_UNAVAILABLE"
  | "MODEL_CATALOG_PROVIDER_UNAVAILABLE"
  | "MODEL_CATALOG_STORAGE_UNAVAILABLE"
  | "MODEL_CATALOG_UPSTREAM_UNAVAILABLE"
  | "MODEL_CATALOG_RESPONSE_INVALID"
  | "MODEL_CATALOG_CANCELLED";

export class ResearchModelCatalogError extends Error {
  public constructor(
    public readonly code: ResearchModelCatalogErrorCode,
    public readonly status: number,
    message: string,
    public readonly retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchModelCatalogError";
  }
}

export interface ResearchModelCatalogServiceOptions {
  readonly database: D1Database;
  readonly workersAi?: WorkersAiModelCatalogBinding;
  readonly externalProviders?: readonly ExternalProviderCatalogTransport[];
}

export interface ResearchModelCatalogService {
  listWorkersAi(
    context: AuthenticatedRequestContext,
    projectId: string,
    query?: ResearchModelCatalogQuery,
  ): Promise<ResearchModelCatalogPage>;
  listExternalProvider(
    context: AuthenticatedRequestContext,
    projectId: string,
    providerId: string,
    query?: ResearchModelCatalogQuery,
  ): Promise<ResearchModelCatalogPage>;
}

interface NormalizedQuery {
  readonly search?: string;
  readonly page: number;
  readonly per_page: number;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown, label: string, maxBytes = MAX_MODEL_STRING_BYTES, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) ||
      utf8Bytes(value) > maxBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      `Workers AI catalog returned invalid ${label}`);
  }
  return value;
}

function identifier(value: unknown, label: string, maxBytes = MAX_PROJECT_ID_BYTES): string {
  const result = boundedText(value, label, maxBytes, false);
  const pattern = maxBytes === MAX_PROVIDER_ID_BYTES ? PROVIDER_IDENTIFIER : IDENTIFIER;
  if (!pattern.test(result)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, `${label} is invalid`);
  }
  return result;
}

function normalizeQuery(input: unknown): NormalizedQuery {
  if (input === undefined) return { page: 1, per_page: 20 };
  if (!isPlainObject(input)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, "model catalog query must be an object");
  }
  const allowed = new Set(["search", "page", "per_page", "task"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, "model catalog query contains an unknown field");
  }
  if (input.task !== undefined && input.task !== RESEARCH_MODEL_CATALOG_TASK) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, "only text-generation models can be listed");
  }
  const page = input.page === undefined ? 1 : input.page;
  const perPage = input.per_page === undefined ? 20 : input.per_page;
  if (!Number.isSafeInteger(page) || (page as number) < 1 || (page as number) > MAX_PAGE ||
      !Number.isSafeInteger(perPage) || (perPage as number) < 1 || (perPage as number) > MAX_PAGE_SIZE) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, "model catalog page bounds are invalid");
  }
  let search: string | undefined;
  if (input.search !== undefined) {
    if (typeof input.search !== "string" || utf8Bytes(input.search) > MAX_SEARCH_BYTES ||
        /[\u0000-\u001f\u007f]/u.test(input.search)) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, "model catalog search is invalid");
    }
    search = input.search.trim();
    if (search.length === 0) search = undefined;
  }
  return { ...(search === undefined ? {} : { search }), page: page as number, per_page: perPage as number };
}

function normalizeContext(context: AuthenticatedRequestContext): string {
  if (context.client_class !== "owner_pwa" || typeof context.principal_ref !== "string" ||
      !IDENTIFIER.test(context.principal_ref) || typeof context.credential_generation !== "string" ||
      !IDENTIFIER.test(context.credential_generation) ||
      (context.access !== undefined && (context.access.principal_ref !== context.principal_ref ||
        context.access.credential_generation !== context.credential_generation))) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_OWNER_REQUIRED", 403,
      "an authenticated project owner context is required");
  }
  return context.principal_ref;
}

async function requireProjectOwner(
  database: D1Database,
  principal: string,
  projectId: string,
): Promise<void> {
  let row: { readonly owned: number } | null;
  try {
    row = await database.prepare(
      "SELECT 1 AS owned FROM project_owner WHERE project_id=?1 AND principal_ref=?2 LIMIT 1",
    ).bind(projectId, principal).first<{ owned: number }>();
  } catch (cause) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_STORAGE_UNAVAILABLE", 503,
      "project owner lookup is unavailable", true, cause);
  }
  if (row?.owned !== 1) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_PROJECT_NOT_FOUND", 404,
      "project was not found for this owner");
  }
}

async function authorize(
  database: D1Database,
  context: AuthenticatedRequestContext,
  projectIdRaw: string,
): Promise<{ readonly principal: string; readonly project_id: string }> {
  const principal = normalizeContext(context);
  let projectId: string;
  try {
    projectId = identifier(projectIdRaw, "project id");
  } catch {
    throw new ResearchModelCatalogError("MODEL_CATALOG_PROJECT_INVALID", 400, "project id is invalid");
  }
  if (context.request.signal.aborted) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
  }
  await requireProjectOwner(database, principal, projectId);
  return { principal, project_id: projectId };
}

function boundedJson(value: unknown, depth: number, budget: { nodes: number; bytes: number }): JsonValue {
  if (depth > MAX_PROPERTY_DEPTH || --budget.nodes < 0) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "Workers AI catalog property exceeds its structure bound");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.bytes -= utf8Bytes(value);
    if (budget.bytes < 0) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
        "Workers AI catalog property exceeds its byte bound");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => boundedJson(item, depth + 1, budget)));
  if (!isPlainObject(value)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "Workers AI catalog property is not JSON");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_MODEL_PROPERTIES) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "Workers AI catalog property has too many members");
  }
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    budget.bytes -= utf8Bytes(key);
    if (budget.bytes < 0) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
        "Workers AI catalog property exceeds its byte bound");
    }
    result[key] = boundedJson(value[key], depth + 1, budget);
  }
  return Object.freeze(result);
}

function validatePropertyValues(value: unknown, source: "workers_ai" | "external_provider"):
  readonly { readonly property_id: string; readonly value: JsonValue }[] {
  if (!Array.isArray(value) || value.length > MAX_MODEL_PROPERTIES) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      `${source} catalog properties are invalid`);
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((raw): { property_id: string; value: JsonValue } => {
    if (!isPlainObject(raw)) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
        `${source} catalog property is invalid`);
    }
    const propertyId = boundedText(raw.property_id, "property id", 256, false);
    if (seen.has(propertyId) || !Object.hasOwn(raw, "value")) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
        `${source} catalog property is duplicated or incomplete`);
    }
    seen.add(propertyId);
    return { property_id: propertyId, value: boundedJson(raw.value, 0, { nodes: MAX_PROPERTY_NODES, bytes: MAX_MODEL_PROPERTY_BYTES }) };
  }));
}

function validateTags(value: unknown, source: "workers_ai" | "external_provider"): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MODEL_TAGS) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502, `${source} catalog tags are invalid`);
  }
  const tags = value.map((tag) => boundedText(tag, "tag", 256, false));
  if (new Set(tags).size !== tags.length) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502, `${source} catalog tags are duplicated`);
  }
  return Object.freeze(tags);
}

function isTextGenerationTask(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const id = typeof value.id === "string" ? value.id : "";
  const name = typeof value.name === "string" ? value.name : "";
  const normalize = (text: string): string => text.trim().toLowerCase().replace(/[ _-]+/gu, " ");
  return normalize(id) === "text generation" || normalize(name) === "text generation";
}

function workersAiModel(raw: unknown): ResearchModelCatalogEntry {
  if (!isPlainObject(raw) || !isTextGenerationTask(raw.task)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "Workers AI catalog returned a model outside the requested text-generation task");
  }
  const task = raw.task as Record<string, unknown>;
  const modelId = boundedText(raw.id, "model id", 256, false);
  if (!MODEL_IDENTIFIER.test(modelId)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "Workers AI catalog returned an invalid model id");
  }
  const taskId = boundedText(task.id, "task id", 256, false);
  const taskName = boundedText(task.name, "task name", 256, false);
  const taskDescription = boundedText(task.description, "task description");
  const sourceTask = Object.freeze({ id: taskId, name: taskName, description: taskDescription });
  const properties = validatePropertyValues(raw.properties, "workers_ai");
  const tags = validateTags(raw.tags, "workers_ai");
  if (!Number.isSafeInteger(raw.source) || (raw.source as number) < 0) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "Workers AI catalog returned an invalid source id");
  }
  return Object.freeze({
    provider_id: "cloudflare-workers-ai",
    model_id: modelId,
    name: boundedText(raw.name, "model name", 512, false),
    description: boundedText(raw.description, "model description"),
    catalog_availability: "listed",
    account_availability: "unknown",
    capabilities: Object.freeze({
      text_generation: "supported",
      input_output_schema: "not_exposed_by_workers_ai_binding",
      schema_requirement: "GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}",
    }),
    source_id: raw.source as number,
    source_task: sourceTask,
    billing: Object.freeze({
      selected_path: "workers_ai_binding",
      support: "unknown",
      account_entitlement: "not_established_by_catalog",
    }),
    properties,
    tags,
  });
}

function externalProviderModel(
  raw: ExternalProviderCatalogModel,
  providerId: string,
): ResearchModelCatalogEntry {
  if (!isPlainObject(raw)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "provider catalog returned an invalid model");
  }
  const modelId = boundedText(raw.model_id, "model id", 256, false);
  if (!MODEL_IDENTIFIER.test(modelId) || !["supported", "unsupported", "unknown"].includes(raw.text_generation) ||
      !["byok", "unified_billing", "unknown"].includes(raw.billing_support)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "provider catalog returned an invalid capability or model id");
  }
  return Object.freeze({
    provider_id: providerId,
    model_id: modelId,
    name: boundedText(raw.name, "model name", 512, false),
    description: boundedText(raw.description, "model description"),
    catalog_availability: "listed",
    account_availability: "unknown",
    capabilities: Object.freeze({
      text_generation: raw.text_generation,
      input_output_schema: "unknown",
      schema_requirement: null,
    }),
    source_id: null,
    source_task: null,
    billing: Object.freeze({
      selected_path: "provider_catalog",
      support: raw.billing_support,
      account_entitlement: "not_established_by_catalog",
    }),
    properties: validatePropertyValues(raw.properties ?? [], "external_provider"),
    tags: validateTags(raw.tags ?? [], "external_provider"),
  });
}

function pageResult(
  projectId: string,
  providerId: string,
  scope: ResearchModelCatalogPage["catalog_scope"],
  query: NormalizedQuery,
  models: readonly ResearchModelCatalogEntry[],
  hasMore: boolean | null,
  probe: ResearchModelCatalogPage["pagination"]["probe"],
): ResearchModelCatalogPage {
  const coverage: ResearchModelCatalogPage["pagination"]["coverage"] = hasMore === null
    ? "unknown"
    : hasMore || query.page !== 1 ? "partial" : "complete";
  const result: ResearchModelCatalogPage = Object.freeze({
    protocol: RESEARCH_MODEL_CATALOG_PROTOCOL,
    project_id: projectId,
    task: RESEARCH_MODEL_CATALOG_TASK,
    catalog_scope: scope,
    provider_id: providerId,
    models: Object.freeze([...models]),
    pagination: Object.freeze({
      page: query.page,
      per_page: query.per_page,
      has_more: hasMore,
      next_page: hasMore === true ? query.page + 1 : null,
      coverage,
      probe,
    }),
  });
  if (utf8Bytes(JSON.stringify(result)) > MAX_RESPONSE_BYTES) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "model catalog page exceeds its response byte bound");
  }
  return result;
}

function normalizeUpstreamModels(value: unknown, source: "workers_ai" | "external_provider",
  limit: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      `${source} catalog returned an invalid or oversized page`);
  }
  return value;
}

function upstreamError(source: string, cause: unknown): ResearchModelCatalogError {
  return new ResearchModelCatalogError("MODEL_CATALOG_UPSTREAM_UNAVAILABLE", 503,
    `${source} catalog is unavailable`, true, cause);
}

function validateProviderPage(value: unknown, perPage: number): ExternalProviderCatalogPage {
  if (!isPlainObject(value) || !Array.isArray(value.models) || value.models.length > perPage ||
      !(value.has_more === true || value.has_more === false || value.has_more === null)) {
    throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
      "provider catalog returned an invalid page envelope");
  }
  return value as unknown as ExternalProviderCatalogPage;
}

export function createResearchModelCatalogService(
  options: ResearchModelCatalogServiceOptions,
): ResearchModelCatalogService {
  async function listWorkersAi(
    context: AuthenticatedRequestContext,
    projectIdRaw: string,
    input?: ResearchModelCatalogQuery,
  ): Promise<ResearchModelCatalogPage> {
    const owner = await authorize(options.database, context, projectIdRaw);
    const query = normalizeQuery(input);
    const models = options.workersAi?.models;
    if (typeof models !== "function") {
      throw new ResearchModelCatalogError("MODEL_CATALOG_WORKERS_AI_UNAVAILABLE", 503,
        "Workers AI model catalog binding is unavailable", true);
    }
    const params = {
      page: query.page,
      per_page: query.per_page,
      task: WORKERS_AI_TASK,
      ...(query.search === undefined ? {} : { search: query.search }),
    };
    let rawPage: unknown;
    try {
      rawPage = await models.call(options.workersAi, params);
    } catch (cause) {
      if (context.request.signal.aborted) {
        throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
      }
      throw upstreamError("Workers AI model", cause);
    }
    const pageRows = normalizeUpstreamModels(rawPage, "workers_ai", query.per_page);
    const pageModels = Object.freeze(pageRows.map(workersAiModel));
    const ids = new Set(pageModels.map((model) => model.model_id));
    if (ids.size !== pageModels.length) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
        "Workers AI catalog returned duplicate model ids");
    }

    let hasMore: boolean | null;
    let probe: ResearchModelCatalogPage["pagination"]["probe"];
    try {
      if (context.request.signal.aborted) throw new Error("request cancelled");
      const next = await models.call(options.workersAi, { ...params, page: query.page + 1 });
      const nextRows = normalizeUpstreamModels(next, "workers_ai", query.per_page);
      const nextModels = nextRows.map(workersAiModel);
      if (new Set(nextModels.map((model) => model.model_id)).size !== nextModels.length) {
        throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
          "Workers AI catalog returned duplicate model ids in its pagination probe");
      }
      hasMore = nextRows.length > 0;
      probe = hasMore ? "next_page_non_empty" : "next_page_empty";
    } catch (cause) {
      if (cause instanceof ResearchModelCatalogError && cause.code === "MODEL_CATALOG_RESPONSE_INVALID") throw cause;
      hasMore = null;
      probe = "next_page_unavailable";
    }
    return pageResult(owner.project_id, "cloudflare-workers-ai", "workers_ai", query,
      pageModels, hasMore, probe);
  }

  async function listExternalProvider(
    context: AuthenticatedRequestContext,
    projectIdRaw: string,
    providerIdRaw: string,
    input?: ResearchModelCatalogQuery,
  ): Promise<ResearchModelCatalogPage> {
    const owner = await authorize(options.database, context, projectIdRaw);
    const query = normalizeQuery(input);
    let providerId: string;
    try {
      providerId = identifier(providerIdRaw, "provider id", MAX_PROVIDER_ID_BYTES);
    } catch {
      throw new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, "provider id is invalid");
    }
    const provider = options.externalProviders?.find((candidate) => candidate.provider_id === providerId);
    if (provider === undefined) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_PROVIDER_UNAVAILABLE", 503,
        "no official provider catalog transport is configured", true);
    }
    if (typeof provider.listTextGeneration !== "function") {
      throw new ResearchModelCatalogError("MODEL_CATALOG_PROVIDER_UNAVAILABLE", 503,
        "official provider catalog transport is unavailable", true);
    }
    let raw: ExternalProviderCatalogPage;
    try {
      raw = validateProviderPage(await provider.listTextGeneration({
        ...(query.search === undefined ? {} : { search: query.search }),
        page: query.page,
        per_page: query.per_page,
        task: RESEARCH_MODEL_CATALOG_TASK,
        signal: context.request.signal,
      }), query.per_page);
    } catch (cause) {
      if (cause instanceof ResearchModelCatalogError) throw cause;
      if (context.request.signal.aborted) {
        throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
      }
      throw upstreamError("provider", cause);
    }
    const models = Object.freeze(raw.models.map((model) => externalProviderModel(model, providerId)));
    if (new Set(models.map((model) => model.model_id)).size !== models.length) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502,
        "provider catalog returned duplicate model ids");
    }
    const probe: ResearchModelCatalogPage["pagination"]["probe"] = raw.has_more === null
      ? "next_page_unavailable" : "provider_reported";
    return pageResult(owner.project_id, providerId, "external_provider", query, models,
      raw.has_more, probe);
  }

  return Object.freeze({ listWorkersAi, listExternalProvider });
}
