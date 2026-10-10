/** C3-RP strict no-argument projection adapter.
 *
 * The adapter fuses the strict decoder and the socket lifecycle. It performs reads only: it creates no
 * run, operation id, provider effect, transcript or settlement and never derives proactive progress from
 * a socket event. A missing, stale, unknown or inconsistent snapshot stays `UNAVAILABLE` for the caller
 * until canonical HTTP readback succeeds; this adapter never guesses a value.
 *
 * Classification uses an injected typed-error identity predicate, so a forged plain object or an
 * unrelated error can never be mistaken for an expected chat-history or session-closed outcome. The
 * final fence keeps the capture taken before the call, so a replaced epoch cannot pass it.
 */

import type { LegacyErrorFactory } from "../../legacy/http";
import type { EpochPort } from "../../transport/client";
import {
  CHAT_HISTORY_DISABLED_CODE,
  CHAT_HISTORY_STATUS_CODE,
  createResearchSessionProjectionDecoder,
  type ResearchSessionProjection,
  type ResearchSessionProjectionDecoder,
} from "./projection";
import {
  createResearchSession,
  freezeBinding,
  type ResearchSessionBinding,
  type ResearchSessionClientFactory,
  type ResearchSessionHostControls,
  type ResearchSessionSocket,
} from "./session";

export type SessionProjectionResult =
  | { readonly kind: "PROJECTION"; readonly value: ResearchSessionProjection }
  | { readonly kind: "CHAT_HISTORY_DISABLED" }
  | { readonly kind: "UNAVAILABLE" };

export interface ResearchSessionProjectionPorts {
  readonly epoch: EpochPort;
  readonly errors: LegacyErrorFactory;
  readonly now: () => number;
  /** Only a real typed request error is classified; a forged plain object is not. */
  readonly isRequestError: (error: unknown) => boolean;
  /** Official seam by default; a test injects a bounded trusted factory instead. */
  readonly connect?: ResearchSessionClientFactory;
  readonly controls: ResearchSessionHostControls;
}

export interface ResearchSessionProjectionAdapter {
  readProjection(binding: ResearchSessionBinding): Promise<SessionProjectionResult>;
  dispose(): void;
}

const codeOf = (error: unknown): string | undefined => {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const statusOf = (error: unknown): number | undefined => {
  if (error === null || typeof error !== "object") return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
};

export function createResearchSessionProjectionAdapter(
  ports: ResearchSessionProjectionPorts,
): ResearchSessionProjectionAdapter {
  const decoder: ResearchSessionProjectionDecoder =
    createResearchSessionProjectionDecoder(ports.errors);
  const socket: ResearchSessionSocket = createResearchSession(
    {
      epoch: ports.epoch,
      errors: ports.errors,
      now: ports.now,
      isRequestError: ports.isRequestError,
    },
    ports.connect,
    ports.controls,
  );

  const matchesBinding = (
    value: ResearchSessionProjection,
    binding: ResearchSessionBinding,
  ): boolean =>
    value.session_id === binding.session_id && value.operation_id === binding.operation_id &&
    value.investigation_ref.id === binding.investigation_ref.id &&
    value.investigation_ref.revision === binding.investigation_ref.revision;

  return {
    async readProjection(requested) {
      // Freeze before awaiting so a caller mutation cannot change the read or the final fence.
      const binding = freezeBinding(requested);
      // The capture is taken before the call and reused by the final fence: a replaced epoch,
      // including one advanced by the caller during the call, cannot pass it.
      const captured = ports.epoch.capture();
      if (captured === undefined || !ports.epoch.isCurrent(captured)) return { kind: "UNAVAILABLE" };
      const observed = ports.now();
      if (!Number.isFinite(observed) || observed >= binding.authority_expires_at) {
        return { kind: "UNAVAILABLE" };
      }
      let raw: unknown;
      try {
        raw = await socket.callProjection(binding);
      } catch (error) {
        if (ports.isRequestError(error)) {
          if (codeOf(error) === CHAT_HISTORY_DISABLED_CODE && statusOf(error) === CHAT_HISTORY_STATUS_CODE) {
            return { kind: "CHAT_HISTORY_DISABLED" };
          }
          if (codeOf(error) === "API_SESSION_CLOSED") return { kind: "UNAVAILABLE" };
        }
        throw error;
      }
      const value = decoder.decodeProjection(raw);
      if (!matchesBinding(value, binding)) {
        throw ports.errors({
          code: "RESEARCH_RUN_RESPONSE_INVALID",
          status: 502,
          message: "Snapshot does not belong to the bound session tuple",
          traceId: null,
          retryable: false,
        });
      }
      // Final fence on the original capture and a finite clock.
      const settled = ports.now();
      if (!Number.isFinite(settled) || settled >= binding.authority_expires_at ||
          !ports.epoch.isCurrent(captured)) {
        return { kind: "UNAVAILABLE" };
      }
      return { kind: "PROJECTION", value };
    },

    dispose() {
      socket.dispose();
    },
  };
}
