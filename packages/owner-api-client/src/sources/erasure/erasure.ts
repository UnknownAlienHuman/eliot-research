/** C2-E erasure operations.
 *
 * Fields, statuses, bodies, idempotency and the 404 null result are preserved exactly from
 * packages/pwa-source-workspace/src/erasure-api.ts. Only the injection is adapted: the HTTP seam is
 * the existing accepted LegacyHttpAdapter surface, the error factory and the shared EpochPort are
 * explicit required ports. No ambient fetch, timer or DOM is acquired.
 *
 * Fencing order for every exported async operation:
 *   1. capture the epoch before dispatch,
 *   2. preflight isCurrent before dispatch,
 *   3. after the await, fence before the 404-null result,
 *   4. final postdecode fence.
 * A stale epoch raises API_SESSION_CLOSED (503). A deployment generation mismatch keeps the
 * original 409 API_GENERATION_MISMATCH.
 */
import type { LegacyHttpAdapter } from "../../legacy/http";
import type { EpochPort } from "../../transport/client";
import { VersionedRefSchema, type ErasureReceipt, type VersionedRef } from "@eliotr/contracts";
import {
  decodeErasurePrepare,
  decodeErasureReceiptEnvelope,
  decodeErasureStatus,
  ERASURE_EXECUTE_PATH,
  ERASURE_NOT_FOUND,
  ERASURE_STATUS_NOT_FOUND,
  validateErasureExpectedGeneration,
  validateErasureExpectedInputs,
  type ErasureApiFailure,
  type ErasureErrorFactory,
  type ErasurePrepareView,
  type ErasureStatusView,
} from "./decoders";

/** The only HTTP authority: the existing legacy adapter surface, not an invented port shape. */
export type ErasureHttpPort = Pick<LegacyHttpAdapter, "requestApi" | "requestApiWithStatuses">;

export interface ErasurePorts {
  readonly http: ErasureHttpPort;
  readonly fail: ErasureErrorFactory;
  readonly epoch: EpochPort;
  readonly isRequestError: (error: unknown) => boolean;
}

export interface ErasureOperations {
  prepareErasureForOwner(
    sourceId: string,
    idempotencyKey: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<ErasurePrepareView>;
  executePreparedErasure(
    prepared: ErasurePrepareView,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<ErasureReceipt>;
  readErasureStatus(
    erasureRef: VersionedRef,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<ErasureStatusView | null>;
}

const SESSION_CLOSED: ErasureApiFailure = {
  status: 503,
  code: "API_SESSION_CLOSED",
  message: "The workspace changed; the deletion request was discarded.",
  retryable: false,
};

/** Builds the three operations. No barrel re-exports this factory. */
export function createErasureOperations(ports: ErasurePorts): ErasureOperations {
  const fail = ports.fail;
  const epoch = ports.epoch;
  const sessionClosed = (): never => { throw fail(SESSION_CLOSED); };
  const assertCurrent = (capture: object | undefined): void => {
    if (!epoch.isCurrent(capture)) sessionClosed();
  };

  /** The 404 null result is recognized through the injected typed-error predicate, then by code. */
  const isNotFound = (error: unknown): boolean => {
    if (!ports.isRequestError(error)) return false;
    const status = (error as { status?: unknown }).status;
    const code = (error as { code?: unknown }).code;
    return status === 404 && (code === ERASURE_NOT_FOUND || code === ERASURE_STATUS_NOT_FOUND);
  };

  return {
    async prepareErasureForOwner(sourceId, idempotencyKey, expectedDeploymentGeneration, signal) {
      const input = validateErasureExpectedInputs(sourceId, idempotencyKey, expectedDeploymentGeneration, fail);
      const captured = epoch.capture();
      assertCurrent(captured);
      const raw = await ports.http.requestApiWithStatuses(
        "/api/v1/library/erasure/prepare",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source_id: input.sourceId, idempotency_key: input.idempotencyKey }),
          ...(signal === undefined ? {} : { signal }),
        },
        [200],
      );
      assertCurrent(captured);
      const prepared = decodeErasurePrepare(raw, input.generation, input.sourceId, fail);
      assertCurrent(captured);
      return prepared;
    },

    async executePreparedErasure(prepared, expectedDeploymentGeneration, signal) {
      const expected = validateErasureExpectedGeneration(expectedDeploymentGeneration, fail);
      if (prepared.deployment_generation !== expected) {
        throw fail({
          status: 409,
          code: "API_GENERATION_MISMATCH",
          message: "The workspace changed; the deletion request was discarded.",
          retryable: true,
        });
      }
      const captured = epoch.capture();
      assertCurrent(captured);
      const raw = await ports.http.requestApiWithStatuses(
        ERASURE_EXECUTE_PATH,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
          body: JSON.stringify(prepared.request),
          ...(signal === undefined ? {} : { signal }),
        },
        [200],
      );
      assertCurrent(captured);
      const receipt = decodeErasureReceiptEnvelope(raw, expected, fail);
      assertCurrent(captured);
      return receipt;
    },

    async readErasureStatus(erasureRef, expectedDeploymentGeneration, signal) {
      const expected = validateErasureExpectedGeneration(expectedDeploymentGeneration, fail);
      const parsed = VersionedRefSchema.safeParse(erasureRef);
      if (!parsed.success) {
        throw fail({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message: "erasure_ref is not a valid versioned reference" });
      }
      const ref = parsed.data;
      const captured = epoch.capture();
      assertCurrent(captured);
      let raw: unknown;
      try {
        raw = await ports.http.requestApiWithStatuses(
          `/api/v1/library/erasure/${encodeURIComponent(ref.id)}/${ref.revision}`,
          signal === undefined ? undefined : { signal },
          [200],
        );
      } catch (error) {
        assertCurrent(captured);
        if (isNotFound(error)) return null;
        throw error;
      }
      assertCurrent(captured);
      const status = decodeErasureStatus(raw, expected, fail);
      assertCurrent(captured);
      return status;
    },
  };
}

