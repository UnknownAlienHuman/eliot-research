import type {
  ProviderConfigCredentialPort,
  ProviderConfigFetchPort,
} from "./provider-config-rest-contract.js";

export type OpenRouterProviderKeyEffect = "NONE" | "UNKNOWN" | "CREATED";

export type OpenRouterProviderKeyErrorCode =
  | "OPENROUTER_PROVIDER_KEY_INPUT_INVALID"
  | "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID"
  | "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED"
  | "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT"
  | "OPENROUTER_PROVIDER_KEY_ALIAS_ALREADY_ATTEMPTED"
  | "OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN"
  | "OPENROUTER_PROVIDER_KEY_READBACK_MISMATCH";

/** Classified error with a fixed message and no retained cause or control-plane body. */
export class OpenRouterProviderKeyRestError extends Error {
  public readonly code: OpenRouterProviderKeyErrorCode;
  public readonly effect: OpenRouterProviderKeyEffect;
  public readonly retryable = false;
  public readonly http_status?: number;

  public constructor(
    code: OpenRouterProviderKeyErrorCode,
    message: string,
    options: {
      readonly effect: OpenRouterProviderKeyEffect;
      readonly http_status?: number;
    },
  ) {
    super(message);
    this.name = "OpenRouterProviderKeyRestError";
    this.code = code;
    this.effect = options.effect;
    if (options.http_status !== undefined) this.http_status = options.http_status;
  }
}

export interface OpenRouterProviderKeyCreateRequest {
  readonly protocol: "eliotr.openrouter-provider-key-create.v1";
  /** Server-derived immutable alias: `eliotr-` followed by 48 lowercase hex characters. */
  readonly alias: string;
  /** Transient provider key. It is sent only in the native provider-config create request. */
  readonly secret: string;
}

export interface OpenRouterProviderKeyConfiguredReceipt {
  readonly protocol: "eliotr.openrouter-provider-key-configured.v1";
  readonly disposition: "configured_not_qualified";
  readonly account_id: string;
  readonly gateway_id: string;
  readonly provider_config_id: string;
  readonly provider_slug: "openrouter";
  readonly alias: string;
  readonly default_config: false;
  readonly secret_id: string;
  readonly observed_modified_at: string;
}

export interface OpenRouterProviderKeyCreatePort {
  readonly account_id: string;
  readonly gateway_id: string;
  create(
    rawRequest: unknown,
    context?: OpenRouterProviderKeyExecutionContext,
  ): Promise<OpenRouterProviderKeyConfiguredReceipt>;
}

/** Local execution controls only; never serialized into the create request. */
export interface OpenRouterProviderKeyExecutionContext {
  readonly signal?: AbortSignal;
  /** Absolute Unix time in milliseconds. The adapter caps an operation at 60 seconds. */
  readonly deadline_ms?: number;
}

export interface OpenRouterProviderKeyLinkedExecution {
  readonly signal: AbortSignal;
  dispose(): void;
}

const EXECUTION_CONTEXT_KEYS = new Set(["deadline_ms", "signal"]);
const DEFAULT_EXECUTION_MS = 30_000;
const MAX_EXECUTION_MS = 60_000;

/** Creates one total-operation signal shared by the preflight, create, and readback requests. */
export function createOpenRouterProviderKeyLinkedExecution(
  rawContext?: OpenRouterProviderKeyExecutionContext,
): OpenRouterProviderKeyLinkedExecution {
  const context = decodeExecutionContext(rawContext);
  const startedAt = Date.now();
  const requestedDeadline = context.deadline_ms ?? startedAt + DEFAULT_EXECUTION_MS;
  if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= startedAt) {
    throw new OpenRouterProviderKeyRestError(
      "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      "OpenRouter provider-key deadline has elapsed before any secret write",
      { effect: "NONE" },
    );
  }
  const deadline = Math.min(requestedDeadline, startedAt + MAX_EXECUTION_MS);
  const controller = new AbortController();
  const parent = context.signal;
  const abort = () => controller.abort();
  if (parent !== undefined) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  });
}

/** Bounds fetch/credential promises even when a supplied port ignores AbortSignal. */
export function waitForOpenRouterProviderKeySignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new Error("operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function decodeExecutionContext(
  raw?: OpenRouterProviderKeyExecutionContext,
): OpenRouterProviderKeyExecutionContext {
  if (raw === undefined) return Object.freeze({});
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key !== "string" || !EXECUTION_CONTEXT_KEYS.has(key))) {
      throw new Error();
    }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error();
      }
    }
    const signal = descriptors.signal?.value as unknown;
    if (signal !== undefined && !isAbortSignal(signal)) throw new Error();
    const deadline = descriptors.deadline_ms?.value as unknown;
    if (deadline !== undefined &&
        (typeof deadline !== "number" || !Number.isSafeInteger(deadline))) throw new Error();
    return Object.freeze({
      ...(signal === undefined ? {} : { signal }),
      ...(deadline === undefined ? {} : { deadline_ms: deadline as number }),
    });
  } catch {
    throw new OpenRouterProviderKeyRestError(
      "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
      "OpenRouter provider-key execution context is invalid",
      { effect: "NONE" },
    );
  }
}

function isAbortSignal(raw: unknown): raw is AbortSignal {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function";
}

export interface CloudflareOpenRouterProviderKeyDependencies {
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  readonly credentials: ProviderConfigCredentialPort;
  readonly fetch: ProviderConfigFetchPort;
}
