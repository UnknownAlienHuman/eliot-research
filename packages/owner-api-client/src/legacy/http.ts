/** Legacy-compatible request seam over the accepted side-effect-free transport.
 *
 * C1.4 owns no product code: the legacy package keeps its own transport until U6 retires it. This
 * adapter only lets existing callers keep their request shapes while the injected owner client
 * provides path policy, protected headers, deadlines and authorization observation. The module
 * never imports the legacy package, so `instanceof` for legacy errors stays with the caller's
 * factory and applies to every typed failure, including body-parser errors.
 */

import { createOwnerApiClient, OwnerClientError } from '../transport/client';
import { OwnerBodyError } from '../transport/body';
import type { OwnerClientPorts, RequestOptions } from '../transport/client';
import type { SessionEpoch } from '../transport/session/epoch';

export interface LegacyHttpPorts extends OwnerClientPorts {
  readonly epoch: SessionEpoch;
}

export interface LegacyErrorDetails {
  readonly code: string;
  readonly status: number;
  readonly message: string;
  readonly traceId: string | null;
  readonly retryable: boolean;
}

/** Error construction stays with the caller, so legacy `instanceof` keeps working. */
export type LegacyErrorFactory = (details: LegacyErrorDetails) => Error;

export interface LegacyBytesResponse {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
}

export interface LegacyTextResponse {
  readonly text: string;
  readonly headers: Headers;
}

const LEGACY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type LegacyMethod = (typeof LEGACY_METHODS)[number];

/** Every RequestInit key this seam consumes. Anything else is a hostile override. */
const ASSUMED_INIT_KEYS = ['method', 'body', 'headers', 'signal', 'credentials', 'cache', 'redirect', 'mode'] as const;

const toMethod = (init: RequestInit | undefined): LegacyMethod => {
  if (init === undefined) return 'GET';
  if (!Object.hasOwn(init, 'method')) return 'GET';
  const method = init.method === undefined ? undefined : String(init.method).toUpperCase();
  if (method === undefined) return 'GET';
  if (!LEGACY_METHODS.includes(method as LegacyMethod)) {
    throw new TypeError(`unsupported legacy method: ${String(init.method)}`);
  }
  return method as LegacyMethod;
};

const toBody = (init: RequestInit | undefined): string | undefined => {
  if (init === undefined || !Object.hasOwn(init, 'body')) return undefined;
  const body = init.body;
  if (body === undefined) return undefined;
  if (body !== null && typeof body !== 'string') {
    throw new TypeError('legacy adapter accepts only a frozen string body');
  }
  return body === null ? undefined : body;
};

const idempotencyOf = (init: RequestInit | undefined): string | undefined => {
  if (init?.headers === undefined) return undefined;
  return new Headers(init.headers).get('idempotency-key') ?? undefined;
};

/**
 * Transport authority is never inherited from a caller's RequestInit: unknown keys, a non-fixed
 * credential, cache, redirect or mode policy is rejected before fetch, not silently ignored.
 */
export function normalizeLegacyInit(init: RequestInit | undefined, timeoutMs?: number): RequestOptions {
  if (init !== undefined) {
    for (const key of Object.keys(init)) {
      if (!ASSUMED_INIT_KEYS.includes(key as (typeof ASSUMED_INIT_KEYS)[number])) {
        throw new TypeError(`unsupported legacy request field: ${key}`);
      }
    }
  }
  if (init?.credentials !== undefined && init.credentials !== 'same-origin') {
    throw new TypeError('caller must not override request credentials');
  }
  if (init?.cache !== undefined && init.cache !== 'no-store') {
    throw new TypeError('caller must not override request cache');
  }
  if (init?.redirect !== undefined && init.redirect !== 'manual') {
    throw new TypeError('caller must not override request redirect');
  }
  if (init?.mode !== undefined && init.mode !== 'same-origin') {
    throw new TypeError('caller must not change request mode');
  }
  const body = toBody(init);
  const signal = init?.signal ?? undefined;
  return {
    method: toMethod(init),
    ...(body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

const withIdempotency = (options: RequestOptions, init: RequestInit | undefined): RequestOptions => {
  const idempotencyKey = idempotencyOf(init);
  return idempotencyKey === undefined ? options : { ...options, idempotencyKey };
};

export interface LegacyHttpAdapter {
  requestApi(path: string, init?: RequestInit, timeoutMs?: number): Promise<unknown>;
  requestApiWithStatuses(path: string, init: RequestInit | undefined, acceptedStatuses: readonly number[], timeoutMs?: number): Promise<unknown>;
  requestApiBytes(path: string, signal?: AbortSignal, maximumBytes?: number, expectedContentType?: string): Promise<LegacyBytesResponse>;
  requestReauthorizedSectionBytes(path: string, signal?: AbortSignal): Promise<LegacyBytesResponse>;
  requestApiText(path: string, signal?: AbortSignal, maximumBytes?: number): Promise<LegacyTextResponse>;
  dispose(): void;
}

export function createLegacyHttpAdapter(ports: LegacyHttpPorts, errorFactory: LegacyErrorFactory): LegacyHttpAdapter {
  const client = createOwnerApiClient(ports);

  /** Every typed transport failure keeps its legacy class through the caller factory. */
  const adapterCall = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof OwnerClientError || error instanceof OwnerBodyError) {
        throw errorFactory({
          code: error.code,
          status: error.status,
          message: error.message,
          traceId: error instanceof OwnerClientError ? error.traceId : null,
          retryable: error instanceof OwnerClientError ? error.retryable : false,
        });
      }
      throw error;
    }
  };

  const requestApiBytes: LegacyHttpAdapter['requestApiBytes'] = async (
    path, signal, maximumBytes = 512 * 1024, expectedContentType = 'application/octet-stream',
  ) => adapterCall(client.requestWholeObject(path, { expectedContentType, maximumBytes },
    signal === undefined ? {} : { signal }));

  return {
    async requestApi(path, init, timeoutMs) {
      return adapterCall(client.requestJson(path, withIdempotency(normalizeLegacyInit(init, timeoutMs), init)));
    },
    async requestApiWithStatuses(path, init, acceptedStatuses, timeoutMs) {
      return adapterCall(client.requestJson(path, withIdempotency({ ...normalizeLegacyInit(init, timeoutMs), acceptedStatuses }, init)));
    },
    requestApiBytes,
    requestReauthorizedSectionBytes(path, signal) {
      return adapterCall(client.requestReauthorizedSectionBytes(path, signal === undefined ? {} : { signal }));
    },
    async requestApiText(path, signal, maximumBytes) {
      const response = await requestApiBytes(path, signal, maximumBytes, 'text/plain');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(response.bytes);
      } catch {
        throw errorFactory({
          code: 'API_RESPONSE_SCHEMA_MISMATCH',
          status: 502,
          message: 'Evidence response is not valid UTF-8',
          traceId: null,
          retryable: false,
        });
      }
      return { text, headers: response.headers };
    },
    dispose() {
      client.dispose();
    },
  };
}
