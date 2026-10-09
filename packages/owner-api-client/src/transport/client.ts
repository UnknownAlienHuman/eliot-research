import { assertSameOriginApiPath } from "./path";
import { mergeProtectedHeaders, type ProtectedHeader } from "./headers";
import { OwnerBodyError, readJsonBody, readWholeObject, readObjectRange, isStrongValidator, type WholeObjectOptions, type ObjectRangeOptions } from "./body";
import { readProblemBody } from "./problem";
import { createSessionEpoch } from "./session/epoch";

export class OwnerClientError extends OwnerBodyError {
  public readonly traceId: string | null;
  public readonly retryable: boolean;
  public constructor(input: { readonly code: string; readonly message: string; readonly status?: number; readonly cause?: unknown; readonly traceId?: string; readonly retryable?: boolean }) {
    super({ ...input, status: input.status ?? 503 });
    this.name = "OwnerClientError";
    this.traceId = input.traceId ?? null;
    this.retryable = input.retryable ?? false;
  }
}
export interface EpochPort { capture(): object | undefined; isCurrent(capture: unknown): boolean }
export interface TimerPort { setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(handle: unknown): void }
export interface AuthorizationLoss { readonly epoch: object; readonly status: number; readonly code: string; readonly current: boolean }
export interface OwnerClientPorts {
  readonly fetch: typeof fetch;
  readonly baseUrl: string;
  readonly timers: TimerPort;
  readonly epoch?: EpochPort;
  readonly defaultTimeoutMs?: number;
  readonly onAuthorizationLoss?: (observation: AuthorizationLoss) => void;
}
export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly headers?: HeadersInit;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: string;
  readonly idempotencyKey?: string;
  readonly protectedHeaders?: readonly ProtectedHeader[];
  readonly acceptedStatuses?: readonly number[];
}
export interface BinaryUploadOptions extends Omit<RequestOptions, "method" | "body"> {
  readonly method: "POST" | "PUT";
  readonly bytes: Uint8Array;
  readonly maximumBytes: number;
  /** Frozen MIME type selected by the endpoint; no transport-selected format. */
  readonly contentType: string;
}
export interface RangeRequestOptions extends ObjectRangeOptions { readonly conditional: "if-match" | "if-range" }
function failure(code: string, message: string, cause?: unknown, status = 503) {
  return new OwnerClientError({ code, message, cause, status });
}
function timeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 600_000) throw failure("API_TIMEOUT_INVALID", "Invalid request deadline", undefined, 400);
  return value;
}
function discard(response: Response | undefined) {
  if (response?.body && !response.bodyUsed && !response.body.locked) {
    try { void response.body.cancel().catch(() => {}); } catch { /* Cleanup cannot replace the first cause. */ }
  }
}
function readOptions(options: Pick<RequestOptions, "signal" | "timeoutMs" | "headers">): RequestOptions {
  return { method: "GET", ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.headers === undefined ? {} : { headers: options.headers }) };
}

/** No global fetch, timer, event, DOM or persistence authority is acquired. No retry exists. */
export function createOwnerApiClient(ports: OwnerClientPorts) {
  const base = new URL(ports.baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw failure("API_ORIGIN_INVALID", "Expected a trusted same-origin base", undefined, 400);
  }
  const defaultTimeout = timeout(ports.defaultTimeoutMs ?? 30_000);
  const ownedEpoch = createSessionEpoch();
  const epoch = ports.epoch ?? ownedEpoch;
  let disposed = false;
  const active = new Set<() => void>();
  async function request<T>(path: string, options: RequestOptions, accept: string, consume: (response: Response, signal: AbortSignal) => Promise<T>, extra: readonly ProtectedHeader[] = [], upload?: { readonly bytes: Uint8Array<ArrayBuffer>; readonly contentType: string }): Promise<T> {
    assertSameOriginApiPath(path);
    const milliseconds = timeout(options.timeoutMs ?? defaultTimeout);
    const captured = epoch.capture();
    if (disposed || !captured || !epoch.isCurrent(captured)) throw failure("API_SESSION_CLOSED", "Owner session is not current");
    const method = options.method ?? "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || (method === "GET" && options.body !== undefined) || (options.body !== undefined && typeof options.body !== "string")) {
      throw failure("API_REQUEST_INVALID", "Invalid request method or frozen body", undefined, 400);
    }
    const required: ProtectedHeader[] = [{ name: "accept", value: accept }, ...extra];
    if (method !== "GET") required.push({ name: "x-eliotr-csrf", value: "1" });
    if (options.body !== undefined) required.push({ name: "content-type", value: "application/json" });
    if (upload !== undefined) required.push({ name: "content-type", value: upload.contentType });
    if (options.idempotencyKey !== undefined) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(options.idempotencyKey)) throw failure("API_REQUEST_INVALID", "Invalid frozen operation identity", undefined, 400);
      required.push({ name: "idempotency-key", value: options.idempotencyKey });
    }
    for (const item of options.protectedHeaders ?? []) {
      const existing = required.find(header => header.name.toLowerCase() === item.name.toLowerCase());
      if (existing && existing.value !== item.value) throw failure("API_HEADER_CONFLICT", "Endpoint policy conflicts with transport", undefined, 400);
      required.push(item);
    }
    const headers = mergeProtectedHeaders(options.headers, required);
    const controller = new AbortController();
    let firstCause: OwnerClientError | undefined;
    const interrupt = (cause: OwnerClientError) => { if (!firstCause) { firstCause = cause; controller.abort(cause); } };
    const callerAbort = () => interrupt(failure("API_REQUEST_ABORTED", "Caller interrupted the request", options.signal?.reason));
    const disposeAbort = () => interrupt(failure("API_SESSION_CLOSED", "Owner client was disposed"));
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(firstCause ?? failure("API_REQUEST_ABORTED", "Request was interrupted", controller.signal.reason));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    void cancelled.catch(() => {});
    options.signal?.addEventListener("abort", callerAbort, { once: true });
    if (options.signal?.aborted) callerAbort();
    active.add(disposeAbort);
    let handle: unknown;
    let scheduled = false;
    let response: Response | undefined;
    let observed = false;
    const current = () => { if (firstCause) throw firstCause; if (disposed || !epoch.isCurrent(captured)) throw failure("API_SESSION_CLOSED", "Response belongs to a closed session"); };
    const observe = (status: number, code: string) => {
      if (observed) return;
      observed = true;
      try { ports.onAuthorizationLoss?.({ epoch: captured, status, code, current: !disposed && epoch.isCurrent(captured) }); }
      catch { /* An observer cannot rewrite the request's first error. */ }
    };
    try {
      current();
      handle = ports.timers.setTimeout(() => interrupt(failure("API_REQUEST_DEADLINE", "Request deadline elapsed")), milliseconds);
      scheduled = true;
      current();
      // A root-relative path always uses the browser's own origin, even with a hostile base option.
      const body = upload?.bytes ?? options.body;
      const fetching = ports.fetch(path, { method, ...(body === undefined ? {} : { body }), headers, signal: controller.signal, credentials: "same-origin", redirect: "manual", cache: "no-store" });
      void fetching.then(late => { if (controller.signal.aborted) discard(late); }, () => {});
      response = await Promise.race([fetching, cancelled]);
      current();
      if (response.url && new URL(response.url).origin !== base.origin) throw failure("API_ORIGIN_INVALID", "Response origin is not the owner origin", undefined, 502);
      const redirected = response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400);
      if (redirected) { observe(401, "ACCESS_SESSION_REQUIRED"); throw failure("ACCESS_SESSION_REQUIRED", "Owner access needs verification", undefined, 401); }
      if (response.status >= 400) {
        let problem;
        try { problem = await Promise.race([readProblemBody(response, controller.signal), cancelled]); }
        catch (error) { if (response.status === 401) observe(401, "ACCESS_SESSION_REQUIRED"); throw error; }
        current();
        if (response.status === 401 || (response.status === 403 && problem.code.startsWith("ACCESS_"))) observe(response.status, problem.code);
        throw new OwnerClientError({ status: problem.status, code: problem.code, message: problem.title, traceId: problem.traceId, retryable: problem.retryable });
      }
      const value = await Promise.race([consume(response, controller.signal), cancelled]);
      current();
      return value;
    } catch (error) {
      if (firstCause) throw firstCause;
      if (error instanceof OwnerBodyError) throw error;
      throw failure("API_UNREACHABLE", "Owner request could not reach a response", error);
    } finally {
      if (scheduled) { try { ports.timers.clearTimeout(handle); } catch { /* A hostile timer cleanup cannot replace the first failure. */ } }
      options.signal?.removeEventListener("abort", callerAbort);
      controller.signal.removeEventListener("abort", rejectAbort);
      active.delete(disposeAbort);
      discard(response);
    }
  }
  return {
    requestJson(path: string, options: RequestOptions = {}) {
      const statuses = Object.freeze([...(options.acceptedStatuses ?? [200])]);
      return request(path, options, "application/json", (response, signal) => readJsonBody(response, signal, undefined, statuses));
    },
    async requestBinaryJson(path: string, input: BinaryUploadOptions) {
      if (!["POST", "PUT"].includes(input.method) || !(input.bytes instanceof Uint8Array) ||
          !Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.bytes.byteLength > input.maximumBytes ||
          typeof input.contentType !== "string" || input.contentType.length > 256 ||
          !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+\/[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/u.test(input.contentType)) {
        throw failure("API_UPLOAD_INVALID", "Expected bounded bytes and an explicit upload media type", undefined, 400);
      }
      // Clone before the first await. Caller mutation never changes dispatched bytes.
      const bytes = new Uint8Array(input.bytes);
      const statuses = Object.freeze([...(input.acceptedStatuses ?? [200])]);
      const options: RequestOptions = {
        method: input.method,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        ...(input.protectedHeaders === undefined ? {} : { protectedHeaders: input.protectedHeaders }),
      };
      return request(path, options, "application/json", (response, signal) => readJsonBody(response, signal, undefined, statuses), [], { bytes, contentType: input.contentType });
    },
    requestWholeObject(path: string, input: WholeObjectOptions, options: Pick<RequestOptions, "signal" | "timeoutMs" | "headers"> = {}) {
      const object = Object.freeze({ ...input });
      return request(path, readOptions(options), object.expectedContentType, (response, signal) => readWholeObject(response, object, signal));
    },
    async requestReauthorizedSectionBytes(path: string, options: Pick<RequestOptions, "signal" | "timeoutMs"> = {}) {
      // The implemented report reauthorization read is POST with an empty body. Keep this
      // operation finite: no generic mutation-byte transport, range, header or status override.
      const match = /^\/api\/v1\/research\/artifact\/([^/?#]+)\/sections\/([^/?#]+)\/reauthorize$/u.exec(path);
      if (!match || Object.keys(options).some(key => key !== "signal" && key !== "timeoutMs")) {
        throw failure("API_REQUEST_INVALID", "Expected an exact reauthorized report section read", undefined, 400);
      }
      for (const segment of match.slice(1)) {
        let decoded: string;
        try { decoded = decodeURIComponent(segment); }
        catch { throw failure("API_REQUEST_INVALID", "Invalid section reference encoding", undefined, 400); }
        const separator = decoded.lastIndexOf(":");
        const id = decoded.slice(0, separator);
        const revision = decoded.slice(separator + 1);
        // IdentifierSchema permits 1..256 UTF-16 characters; it is not the narrower
        // Workflow identifier. Compare canonical component encoding before dispatch.
        if (separator < 1 || id.length > 256 || !/^[1-9][0-9]*$/u.test(revision) ||
            !Number.isSafeInteger(Number(revision)) || encodeURIComponent(decoded) !== segment) {
          throw failure("API_REQUEST_INVALID", "Invalid exact section reference", undefined, 400);
        }
      }
      const object = { expectedContentType: "application/octet-stream", maximumBytes: 1024 * 1024 };
      return request(path, { ...options, method: "POST" }, object.expectedContentType,
        (response, signal) => readWholeObject(response, object, signal));
    },
    requestObjectRange(path: string, input: RangeRequestOptions, options: Pick<RequestOptions, "signal" | "timeoutMs" | "headers"> = {}) {
      const range = Object.freeze({ ...input });
      if (!Number.isSafeInteger(range.requestedStart) || range.requestedStart < 0 || !Number.isSafeInteger(range.requestedEnd) || range.requestedEnd < range.requestedStart || !isStrongValidator(range.expectedETag) || !["if-match", "if-range"].includes(range.conditional)) throw failure("API_RANGE_INVALID", "Invalid immutable range request", undefined, 400);
      return request(path, readOptions(options), range.expectedContentType, (response, signal) => readObjectRange(response, range, signal), [{ name: "range", value: `bytes=${range.requestedStart}-${range.requestedEnd}` }, { name: range.conditional, value: range.expectedETag }]);
    },
    dispose() { if (!disposed) { disposed = true; ownedEpoch?.dispose(); for (const cancel of active) cancel(); } },
  };
}
