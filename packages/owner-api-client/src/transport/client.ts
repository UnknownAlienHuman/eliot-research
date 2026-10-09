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
  async function request<T>(path: string, options: RequestOptions, accept: string, consume: (response: Response, signal: AbortSignal) => Promise<T>, extra: readonly ProtectedHeader[] = []): Promise<T> {
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
      const fetching = ports.fetch(path, { method, ...(options.body === undefined ? {} : { body: options.body }), headers, signal: controller.signal, credentials: "same-origin", redirect: "manual", cache: "no-store" });
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
    requestWholeObject(path: string, input: WholeObjectOptions, options: Pick<RequestOptions, "signal" | "timeoutMs" | "headers"> = {}) {
      const object = Object.freeze({ ...input });
      return request(path, readOptions(options), object.expectedContentType, (response, signal) => readWholeObject(response, object, signal));
    },
    requestObjectRange(path: string, input: RangeRequestOptions, options: Pick<RequestOptions, "signal" | "timeoutMs" | "headers"> = {}) {
      const range = Object.freeze({ ...input });
      if (!Number.isSafeInteger(range.requestedStart) || range.requestedStart < 0 || !Number.isSafeInteger(range.requestedEnd) || range.requestedEnd < range.requestedStart || !isStrongValidator(range.expectedETag) || !["if-match", "if-range"].includes(range.conditional)) throw failure("API_RANGE_INVALID", "Invalid immutable range request", undefined, 400);
      return request(path, readOptions(options), range.expectedContentType, (response, signal) => readObjectRange(response, range, signal), [{ name: "range", value: `bytes=${range.requestedStart}-${range.requestedEnd}` }, { name: range.conditional, value: range.expectedETag }]);
    },
    dispose() { if (!disposed) { disposed = true; ownedEpoch?.dispose(); for (const cancel of active) cancel(); } },
  };
}
