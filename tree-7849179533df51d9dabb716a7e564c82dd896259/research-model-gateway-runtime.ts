import {
  ModelGatewayExecutionError,
  resolveModelGatewayReasoningEndpoint,
  validateModelGatewayToken,
  type ModelGatewayCredentialPort,
  type ModelGatewayFetchPort,
  type ModelGatewayBindingTransport,
  type ModelGatewayTokenTransport,
} from "@eliotr/cloudflare-ai";
import { createResearchModelGatewayBindingFetch, type ResearchModelGatewayBinding } from "./research-model-gateway-binding.js";

const REQUEST_TIMEOUT_HEADER = "cf-aig-request-timeout";
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const MAX_SUCCESS_BODY_BYTES = 256 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

interface ResearchModelGatewayRuntimeOptions {
  /** The configured server-owned reasoning gateway base URL. */
  readonly reasoning_gateway_base_url: string;
  /** A request-context signal for one invocation; do not retain it globally. */
  readonly signal?: AbortSignal;
}

export interface ResearchModelGatewayHttpRuntimeInput extends ResearchModelGatewayRuntimeOptions {
  /** The server-held AI Gateway credential; caller input is never consulted. */
  readonly gateway_token: unknown;
  /** An injected fetch is for controlled tests; production uses Worker fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly ai_gateway_binding?: never;
}

export interface ResearchModelGatewayBindingRuntimeInput extends ResearchModelGatewayRuntimeOptions {
  readonly ai_gateway_binding: ResearchModelGatewayBinding;
  readonly gateway_token?: never;
  readonly fetch?: never;
}

export type ResearchModelGatewayRuntimeInput = ResearchModelGatewayHttpRuntimeInput | ResearchModelGatewayBindingRuntimeInput;
export type ResearchModelGatewayRuntimeConfig = Omit<ResearchModelGatewayHttpRuntimeInput, "signal"> | Omit<ResearchModelGatewayBindingRuntimeInput, "signal">;
export interface ResearchModelGatewayHttpRuntime extends ModelGatewayTokenTransport {
  readonly endpoint: string;
}
export interface ResearchModelGatewayBindingRuntime extends ModelGatewayBindingTransport { readonly endpoint: string; }
export type ResearchModelGatewayRuntime = ResearchModelGatewayHttpRuntime | ResearchModelGatewayBindingRuntime;

interface RequestLifecycle {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly abortPromise: Promise<never>;
  readonly abort: (reason: Error) => void;
  readonly finish: () => void;
}

function requestInvalid(message: string, cause?: unknown): never {
  throw new ModelGatewayExecutionError(
    "MODEL_GATEWAY_REQUEST_INVALID",
    message,
    cause === undefined ? {} : { cause },
  );
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertLifecycleActive(lifecycle: RequestLifecycle): void {
  if (lifecycle.signal.aborted) {
    const error = abortError("model gateway call was cancelled");
    lifecycle.abort(error);
    throw error;
  }
  if (Date.now() >= lifecycle.deadlineAt) {
    const error = abortError("model gateway response deadline exceeded");
    lifecycle.abort(error);
    throw error;
  }
}

function requestTimeout(init: RequestInit): number {
  const value = new Headers(init.headers).get(REQUEST_TIMEOUT_HEADER);
  if (value === null || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    requestInvalid("prepared model gateway request is missing its canonical timeout header");
  }
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS) {
    requestInvalid("prepared model gateway request timeout is outside its canonical range");
  }
  return timeout;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason: Error): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // The body may already have failed; no teardown is awaited here.
  }
  try {
    reader.releaseLock();
  } catch {
    // A pending read owns the lock until it settles.
  }
}

function cancelResponseBody(response: Response, reason: Error): void {
  if (response.body === null) return;
  try {
    const reader = response.body.getReader();
    cancelReader(reader, reason);
  } catch {
    // A response body that cannot be acquired is already unavailable.
  }
}

function cancelReaderWithoutRelease(reader: ReadableStreamDefaultReader<Uint8Array>, reason: Error): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // The source may already have completed or failed.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // A pending read owns the lock until it settles.
  }
}

function createRequestLifecycle(
  timeoutMs: number,
  parents: readonly AbortSignal[],
): RequestLifecycle {
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  let state: "ACTIVE" | "ABORTED" | "FINISHED" = "ACTIVE";
  let rejectAbort!: (reason: Error) => void;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    abort(abortError("model gateway response deadline exceeded"));
  }, timeoutMs);

  const detach = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    for (const parent of parents) parent.removeEventListener("abort", onParentAbort);
  };
  const abort = (reason: Error): void => {
    if (state !== "ACTIVE") return;
    state = "ABORTED";
    detach();
    try {
      controller.abort(reason);
    } catch {
      // The controller may already have been aborted by another parent.
    }
    rejectAbort(reason);
  };
  const onParentAbort = (): void => abort(abortError("model gateway call was cancelled"));
  for (const parent of parents) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  if (parents.some((parent) => parent.aborted)) onParentAbort();
  const finish = (): void => {
    if (state !== "ACTIVE") return;
    state = "FINISHED";
    detach();
  };
  return { signal: controller.signal, deadlineAt, abortPromise, abort, finish };
}

async function bufferResponseBody(
  response: Response,
  lifecycle: RequestLifecycle,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    const error = abortError("model gateway response body cannot be read");
    lifecycle.abort(error);
    throw error;
  }
  const maximumBytes = response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES;
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onLifecycleAbort = (): void => cancelReaderWithoutRelease(
    reader,
    abortError("model gateway response consumption was cancelled"),
  );
  lifecycle.signal.addEventListener("abort", onLifecycleAbort, { once: true });
  if (lifecycle.signal.aborted) onLifecycleAbort();
  try {
    while (true) {
      const next = await Promise.race([reader.read(), lifecycle.abortPromise]);
      assertLifecycleActive(lifecycle);
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        const error = abortError("model gateway response exceeds its bounded byte budget");
        lifecycle.abort(error);
        cancelReaderWithoutRelease(reader, error);
        throw error;
      }
      chunks.push(next.value);
    }
    assertLifecycleActive(lifecycle);
    lifecycle.finish();
    lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
    releaseReader(reader);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      lifecycle.abort(cause);
    } else {
      lifecycle.abort(abortError("model gateway response body could not be read"));
    }
    lifecycle.signal.removeEventListener("abort", onLifecycleAbort);
    try {
      releaseReader(reader);
    } catch {
      // Reader release is best effort during failure cleanup.
    }
    throw cause;
  }
}

async function readResponseWithDeadline(
  response: Response,
  lifecycle: RequestLifecycle,
  endpoint: string,
  bindingBase?: string,
): Promise<Response> {
  const deadlineExceeded = Date.now() >= lifecycle.deadlineAt;
  if (lifecycle.signal.aborted || deadlineExceeded) {
    const error = abortError(deadlineExceeded
      ? "model gateway response deadline exceeded"
      : "model gateway call was cancelled");
    lifecycle.abort(error);
    cancelResponseBody(response, error);
    throw error;
  }
  const boundResponse = bindingBase !== undefined && (response.url === bindingBase || response.url === `${bindingBase}/`);
  if (response.redirected || (response.url !== "" && response.url !== endpoint && !boundResponse)) {
    const error = abortError("model gateway response was redirected");
    lifecycle.abort(error);
    cancelResponseBody(response, error);
    throw error;
  }
  if (response.body === null) {
    lifecycle.finish();
    return response;
  }
  const bytes = await bufferResponseBody(response, lifecycle);
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

export function createResearchModelGatewayRuntime(input: ResearchModelGatewayHttpRuntimeInput): ResearchModelGatewayHttpRuntime;
export function createResearchModelGatewayRuntime(input: ResearchModelGatewayBindingRuntimeInput): ResearchModelGatewayBindingRuntime;
export function createResearchModelGatewayRuntime(input: ResearchModelGatewayRuntimeInput): ResearchModelGatewayRuntime;
export function createResearchModelGatewayRuntime(
  input: ResearchModelGatewayRuntimeInput,
): ResearchModelGatewayRuntime {
  if (typeof input.fetch !== "undefined" && typeof input.fetch !== "function") {
    requestInvalid("injected model gateway fetch must be callable");
  }
  const endpoint = resolveModelGatewayReasoningEndpoint(input.reasoning_gateway_base_url);
  const binding = input.ai_gateway_binding;
  if (binding !== undefined && (input.gateway_token !== undefined || input.fetch !== undefined)) {
    requestInvalid("Worker gateway binding cannot be combined with a token or HTTP transport");
  }
  const token = binding === undefined ? validateModelGatewayToken(input.gateway_token) : undefined;
  const fetchImpl = binding === undefined
    ? input.fetch ?? globalThis.fetch.bind(globalThis)
    : createResearchModelGatewayBindingFetch(binding, endpoint);
  const bindingBase = binding === undefined ? undefined : endpoint.slice(0, -"/compat/chat/completions".length);
  const transport: ModelGatewayFetchPort = Object.freeze({
    async fetch(url: string, init: RequestInit): Promise<Response> {
      if (url !== endpoint) requestInvalid("model gateway transport destination differs from configured reasoning gateway");
      if (init.method !== "POST" || init.redirect !== "error") {
        requestInvalid("model gateway transport requires the canonical POST and redirect:error request");
      }
      const timeoutMs = requestTimeout(init);
      const parents = [input.signal, init.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined && signal !== null,
      );
      if (parents.some((signal) => signal.aborted)) throw abortError("model gateway call was cancelled");
      const lifecycle = createRequestLifecycle(timeoutMs, parents);
      const fetchPromise = Promise.resolve().then(() => {
        assertLifecycleActive(lifecycle);
        return fetchImpl(url, {
          ...init,
          redirect: "error",
          signal: lifecycle.signal,
        });
      });
      void fetchPromise.then((response) => {
        if (lifecycle.signal.aborted && response instanceof Response) {
          cancelResponseBody(response, abortError("model gateway call was cancelled"));
        }
      }, () => undefined);
      try {
        const response = await Promise.race([fetchPromise, lifecycle.abortPromise]);
        if (!(response instanceof Response)) requestInvalid("model gateway transport returned a non-Response value");
        return await readResponseWithDeadline(response, lifecycle, endpoint, bindingBase);
      } catch (cause) {
        lifecycle.abort(cause instanceof Error ? cause : abortError("model gateway transport failed"));
        throw cause;
      }
    },
  });
  if (binding !== undefined) return Object.freeze({ endpoint, binding_transport: transport });
  const credentials: ModelGatewayCredentialPort = Object.freeze({ async readGatewayToken(): Promise<unknown> { return token; } });
  return Object.freeze({ endpoint, credentials, transport });
}
