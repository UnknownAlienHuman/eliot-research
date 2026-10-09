import {
  RUNTIME_LIMITS,
  RuntimeLimitError,
  readResponseBodyWithinBytes,
} from "./runtime-limits.js";
import {
  cancelQuietly,
  createRuntimeDeadline,
  waitForRuntimeDeadline,
  type RuntimeDeadline as LocalDeadline,
  type RuntimeDeadlineFailureCode as DeadlineFailureCode,
} from "./runtime-async.js";

export const NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS = 1024;
export const NATIVE_WEB_SEARCH_MAX_RESULTS = 10;
export const NATIVE_WEB_SEARCH_MAX_WAIT_MS = 30_000;

const NATIVE_WEB_SEARCH_RESPONSE_MAX_BYTES = RUNTIME_LIMITS.ordinary_json_bytes;
const BYOK_ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const PROVIDERS = ["ceramic", "exa", "linkup"] as const;
const ITEM_FIELDS = new Set([
  "url",
  "title",
  "description",
  "lastModifiedDate",
  "imageUrl",
  "faviconUrl",
]);
const METADATA_FIELDS = new Set(["query", "requestId", "latencyMs"]);

export type NativeWebSearchProvider = (typeof PROVIDERS)[number];
export type NativeWebSearchDispatchState =
  | "NOT_STARTED"
  | "OUTCOME_UNKNOWN"
  | "RESPONSE_RECEIVED";

export interface NativeWebSearchBindingRequest {
  readonly gatewayId: string;
  readonly query: string;
  readonly provider: NativeWebSearchProvider;
  readonly limit: number;
  readonly byokAlias?: string;
}

/** Structural binding type keeps the beta API isolated from older Workers types. */
export interface NativeWebSearchBinding {
  websearch?(request: NativeWebSearchBindingRequest): Promise<Response>;
}

/** Selected by the server-owned runtime profile; no provider or gateway default is implied. */
export interface NativeWebSearchProfile {
  readonly gateway_id: string;
  readonly provider: NativeWebSearchProvider;
  readonly byok_alias?: string;
  /** Local wait budget. Expiry stops waiting; it cannot cancel a dispatched search. */
  readonly timeout_ms: number;
}

export interface NativeWebSearchRequest {
  readonly query: string;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface NativeWebSearchLocator {
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  readonly last_modified_date?: string;
  readonly image_url?: string;
  readonly favicon_url?: string;
}

export interface NativeWebSearchProviderMetadata {
  readonly query?: string;
  readonly request_id?: string;
  readonly latency_ms?: number;
}

export type NativeWebSearchOmissionReason =
  | "ITEM_NOT_OBJECT"
  | "ITEM_UNKNOWN_FIELD"
  | "ITEM_URL_MISSING"
  | "ITEM_URL_INVALID"
  | "ITEM_FIELD_INVALID";

export interface NativeWebSearchOmission {
  readonly item_index: number;
  readonly reason: NativeWebSearchOmissionReason;
}

interface NativeWebSearchObservedBase {
  readonly protocol: "eliotr.native-web-search.v1";
  readonly selected_gateway_id: string;
  readonly selected_provider: NativeWebSearchProvider;
  readonly requested_query: string;
  readonly requested_limit: number;
  readonly dispatch_state: "RESPONSE_RECEIVED";
  /** Billing data is not returned by this binding response. */
  readonly paid_effect: "UNKNOWN";
  readonly locators: readonly NativeWebSearchLocator[];
  readonly omissions: readonly NativeWebSearchOmission[];
  readonly provider_metadata?: NativeWebSearchProviderMetadata;
}

export interface NativeWebSearchDiscovered extends NativeWebSearchObservedBase {
  readonly disposition: "DISCOVERED";
}

export interface NativeWebSearchNoHit extends NativeWebSearchObservedBase {
  readonly disposition: "NO_HIT";
  readonly locators: readonly [];
  readonly omissions: readonly [];
}

export type NativeWebSearchFailureCode =
  | "INPUT_INVALID"
  | "UNSUPPORTED_RUNTIME"
  | "ABORTED"
  | "TIMEOUT"
  | "DISPATCH_OUTCOME_UNKNOWN"
  | "HTTP_FAILURE"
  | "RESPONSE_INVALID"
  | "RESPONSE_TOO_LARGE"
  | "ALL_ITEMS_OMITTED"
  | "RESULT_LIMIT_EXCEEDED";

export interface NativeWebSearchFailure {
  readonly protocol: "eliotr.native-web-search.v1";
  readonly disposition: "FAILED";
  readonly code: NativeWebSearchFailureCode;
  readonly selected_gateway_id: string;
  readonly selected_provider: NativeWebSearchProvider;
  readonly dispatch_state: NativeWebSearchDispatchState;
  readonly paid_effect: "NONE" | "UNKNOWN";
  readonly requested_query?: string;
  readonly requested_limit?: number;
  readonly http_status?: number;
  readonly omissions?: readonly NativeWebSearchOmission[];
}

export type NativeWebSearchOutcome =
  | NativeWebSearchDiscovered
  | NativeWebSearchNoHit
  | NativeWebSearchFailure;

class DeadlineFailure extends Error {
  public constructor(public readonly code: DeadlineFailureCode) {
    super(code);
    this.name = "DeadlineFailure";
  }
}

function waitForDeadline<T>(promise: Promise<T>, deadline: LocalDeadline): Promise<T> {
  return waitForRuntimeDeadline(promise, deadline, (code) => new DeadlineFailure(code));
}

/** Adds cancellation to the existing bounded reader without duplicating its byte accounting. */
function responseWithAbortableBody(response: Response, deadline: LocalDeadline): Pick<Response, "body" | "headers"> {
  if (response.body === null) return response;
  const sourceReader = response.body.getReader();
  let cancellationStarted = false;
  const cancelSource = (reason?: unknown): void => {
    if (cancellationStarted) return;
    cancellationStarted = true;
    try {
      void sourceReader.cancel(reason).then(
        () => sourceReader.releaseLock(),
        () => sourceReader.releaseLock(),
      );
    } catch {
      try {
        sourceReader.releaseLock();
      } catch {
        // The stream reader may already have been released by a terminal read.
      }
    }
  };
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const part = await waitForDeadline(sourceReader.read(), deadline);
        if (part.done) {
          cancellationStarted = true;
          sourceReader.releaseLock();
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(part.value));
      } catch (error) {
        cancelSource(error);
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelSource(reason);
    },
  });
  return { body, headers: response.headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function queryCharacterCount(query: string): number {
  let count = 0;
  for (const _character of query) {
    count += 1;
    if (count > NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS) return count;
  }
  return count;
}

function validRequest(request: NativeWebSearchRequest): boolean {
  return typeof request.query === "string" &&
    request.query.trim().length > 0 &&
    queryCharacterCount(request.query) <= NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS &&
    Number.isSafeInteger(request.limit) &&
    request.limit >= 1 &&
    request.limit <= NATIVE_WEB_SEARCH_MAX_RESULTS;
}

function validateProfile(profile: NativeWebSearchProfile): NativeWebSearchProfile {
  if (typeof profile.gateway_id !== "string" || profile.gateway_id.trim().length === 0) {
    throw new RangeError("gateway_id must be selected by the server runtime profile");
  }
  if (!(PROVIDERS as readonly string[]).includes(profile.provider)) {
    throw new RangeError("provider must be one of ceramic, exa, or linkup");
  }
  if (profile.byok_alias !== undefined && !BYOK_ALIAS_PATTERN.test(profile.byok_alias)) {
    throw new RangeError("byok_alias must match [A-Za-z0-9_-]{1,64}");
  }
  if (!Number.isSafeInteger(profile.timeout_ms) || profile.timeout_ms < 1 ||
      profile.timeout_ms > NATIVE_WEB_SEARCH_MAX_WAIT_MS) {
    throw new RangeError(`timeout_ms must be from 1 to ${NATIVE_WEB_SEARCH_MAX_WAIT_MS}`);
  }
  return Object.freeze({ ...profile });
}

function failure(
  profile: NativeWebSearchProfile,
  code: NativeWebSearchFailureCode,
  dispatchState: NativeWebSearchDispatchState,
  request?: Pick<NativeWebSearchRequest, "query" | "limit">,
  extra: Pick<NativeWebSearchFailure, "http_status" | "omissions"> = {},
): NativeWebSearchFailure {
  return {
    protocol: "eliotr.native-web-search.v1",
    disposition: "FAILED",
    code,
    selected_gateway_id: profile.gateway_id,
    selected_provider: profile.provider,
    dispatch_state: dispatchState,
    paid_effect: dispatchState === "NOT_STARTED" ? "NONE" : "UNKNOWN",
    ...(request === undefined ? {} : {
      requested_query: request.query,
      requested_limit: request.limit,
    }),
    ...extra,
  };
}

function decodeMetadata(value: unknown): NativeWebSearchProviderMetadata | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyFields(value, METADATA_FIELDS)) return null;
  if (value.query !== undefined && (typeof value.query !== "string" || value.query.length === 0 ||
      queryCharacterCount(value.query) > NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS)) return null;
  if (value.requestId !== undefined && typeof value.requestId !== "string") return null;
  if (value.latencyMs !== undefined &&
      (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0)) return null;
  return {
    ...(typeof value.query === "string" ? { query: value.query } : {}),
    ...(typeof value.requestId === "string" ? { request_id: value.requestId } : {}),
    ...(typeof value.latencyMs === "number" ? { latency_ms: value.latencyMs } : {}),
  };
}

function decodeLocator(value: unknown):
  | { readonly kind: "valid"; readonly locator: NativeWebSearchLocator }
  | { readonly kind: "omitted"; readonly reason: NativeWebSearchOmissionReason } {
  if (!isRecord(value)) return { kind: "omitted", reason: "ITEM_NOT_OBJECT" };
  if (!hasOnlyFields(value, ITEM_FIELDS)) return { kind: "omitted", reason: "ITEM_UNKNOWN_FIELD" };
  if (typeof value.url !== "string" || value.url.length === 0) {
    return { kind: "omitted", reason: "ITEM_URL_MISSING" };
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return { kind: "omitted", reason: "ITEM_URL_INVALID" };
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0 ||
      value.url !== value.url.trim()) {
    return { kind: "omitted", reason: "ITEM_URL_INVALID" };
  }
  for (const field of ["title", "description", "lastModifiedDate", "imageUrl", "faviconUrl"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return { kind: "omitted", reason: "ITEM_FIELD_INVALID" };
    }
  }
  return {
    kind: "valid",
    locator: {
      url: value.url,
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(typeof value.lastModifiedDate === "string" ? { last_modified_date: value.lastModifiedDate } : {}),
      ...(typeof value.imageUrl === "string" ? { image_url: value.imageUrl } : {}),
      ...(typeof value.faviconUrl === "string" ? { favicon_url: value.faviconUrl } : {}),
    },
  };
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/** One non-retrying native discovery call; capture and admission remain caller-owned. */
export function createNativeWebSearchAdapter(
  binding: NativeWebSearchBinding | undefined,
  selectedProfile: NativeWebSearchProfile,
) {
  const profile = validateProfile(selectedProfile);

  return {
    async discover(request: NativeWebSearchRequest): Promise<NativeWebSearchOutcome> {
      if (!validRequest(request)) {
        return failure(profile, "INPUT_INVALID", "NOT_STARTED");
      }
      const stableRequest = { query: request.query, limit: request.limit } as const;
      if (request.signal?.aborted) {
        return failure(profile, "ABORTED", "NOT_STARTED", stableRequest);
      }
      if (typeof binding?.websearch !== "function") {
        return failure(profile, "UNSUPPORTED_RUNTIME", "NOT_STARTED", stableRequest);
      }

      const deadline = createRuntimeDeadline(request.signal, profile.timeout_ms);
      try {
        if (deadline.signal.aborted) {
          return failure(profile, deadline.failureCode() ?? "ABORTED", "NOT_STARTED", stableRequest);
        }

        let dispatched: Promise<Response>;
        try {
          const bindingRequest: NativeWebSearchBindingRequest = {
            gatewayId: profile.gateway_id,
            query: stableRequest.query,
            provider: profile.provider,
            limit: stableRequest.limit,
            ...(profile.byok_alias === undefined ? {} : { byokAlias: profile.byok_alias }),
          };
          dispatched = binding.websearch(bindingRequest);
        } catch {
          return failure(profile, "DISPATCH_OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN", stableRequest);
        }

        const responsePromise = Promise.resolve(dispatched).then((response) => {
          if (deadline.signal.aborted && isResponse(response)) cancelQuietly(response.body);
          return response;
        });
        let response: Response;
        try {
          response = await waitForDeadline(responsePromise, deadline);
        } catch (error) {
          const code = error instanceof DeadlineFailure
            ? error.code
            : "DISPATCH_OUTCOME_UNKNOWN";
          return failure(profile, code, "OUTCOME_UNKNOWN", stableRequest);
        }
        if (deadline.failureCode() !== undefined) {
          return failure(profile, deadline.failureCode() as DeadlineFailureCode, "RESPONSE_RECEIVED", stableRequest);
        }
        if (!isResponse(response)) {
          return failure(profile, "RESPONSE_INVALID", "RESPONSE_RECEIVED", stableRequest);
        }
        if (!response.ok) {
          cancelQuietly(response.body);
          return failure(profile, "HTTP_FAILURE", "RESPONSE_RECEIVED", stableRequest, {
            http_status: response.status,
          });
        }

        let bytes: Uint8Array;
        try {
          bytes = await readResponseBodyWithinBytes(
            responseWithAbortableBody(response, deadline),
            { label: "native web search response", max_bytes: NATIVE_WEB_SEARCH_RESPONSE_MAX_BYTES },
          );
        } catch (error) {
          const deadlineCode = deadline.failureCode();
          const code = deadlineCode ?? (error instanceof RuntimeLimitError &&
            (error.code === "LIMIT_EXCEEDED" || error.code === "STREAM_CHUNK_LIMIT_EXCEEDED")
            ? "RESPONSE_TOO_LARGE"
            : "RESPONSE_INVALID");
          return failure(profile, code, "RESPONSE_RECEIVED", stableRequest);
        }
        if (deadline.failureCode() !== undefined) {
          return failure(profile, deadline.failureCode() as DeadlineFailureCode, "RESPONSE_RECEIVED", stableRequest);
        }

        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        } catch {
          return failure(profile, "RESPONSE_INVALID", "RESPONSE_RECEIVED", stableRequest);
        }
        if (!isRecord(body) || !hasOnlyFields(body, new Set(["items", "metadata"])) ||
            !Array.isArray(body.items)) {
          return failure(profile, "RESPONSE_INVALID", "RESPONSE_RECEIVED", stableRequest);
        }
        if (body.items.length > stableRequest.limit) {
          return failure(profile, "RESULT_LIMIT_EXCEEDED", "RESPONSE_RECEIVED", stableRequest);
        }
        const providerMetadata = decodeMetadata(body.metadata);
        if (providerMetadata === null) {
          return failure(profile, "RESPONSE_INVALID", "RESPONSE_RECEIVED", stableRequest);
        }

        const locators: NativeWebSearchLocator[] = [];
        const omissions: NativeWebSearchOmission[] = [];
        body.items.forEach((item: unknown, itemIndex: number) => {
          const decoded = decodeLocator(item);
          if (decoded.kind === "valid") locators.push(decoded.locator);
          else omissions.push({ item_index: itemIndex, reason: decoded.reason });
        });
        if (body.items.length > 0 && locators.length === 0) {
          return failure(profile, "ALL_ITEMS_OMITTED", "RESPONSE_RECEIVED", stableRequest, { omissions });
        }

        const observed: NativeWebSearchObservedBase = {
          protocol: "eliotr.native-web-search.v1",
          selected_gateway_id: profile.gateway_id,
          selected_provider: profile.provider,
          requested_query: stableRequest.query,
          requested_limit: stableRequest.limit,
          dispatch_state: "RESPONSE_RECEIVED",
          paid_effect: "UNKNOWN",
          locators,
          omissions,
          ...(providerMetadata === undefined ? {} : { provider_metadata: providerMetadata }),
        };
        return body.items.length === 0
          ? { ...observed, disposition: "NO_HIT", locators: [], omissions: [] }
          : { ...observed, disposition: "DISCOVERED" };
      } finally {
        deadline.dispose();
      }
    },
  };
}
