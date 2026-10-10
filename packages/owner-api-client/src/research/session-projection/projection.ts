/** C3-RP strict ResearchSession projection decoder.
 *
 * The wire contract is `eliotr.research-session-projection.v1` from
 * `docs/implementation/research-session-projection-protocol.md`, restated as the amendment authority.
 * The decoder accepts exactly the three-state union, rejects every unknown field and imports no backend
 * package, so no raw provider or runtime payload can pass into the browser.
 */

import { VersionedRefSchema } from "@eliotr/contracts";
import type { LegacyErrorFactory } from "../../legacy/http";
import { createResearchRunWire } from "../runs/wire";

export const SESSION_PROJECTION_PROTOCOL = "eliotr.research-session-projection.v1";
export const CHAT_HISTORY_STATUS_CODE = 410;
export const CHAT_HISTORY_DISABLED_CODE = "SESSION_CHAT_HISTORY_DISABLED";

export type ResearchSessionEngineStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause";

const PROJECTION_KEYS = [
  "protocol", "session_id", "operation_id", "state", "investigation_ref", "run_status",
  "cancellation_receipt_ref", "completion_receipt_ref", "output_manifest_ref",
] as const;

const ENGINE_STATUSES: readonly ResearchSessionEngineStatus[] = [
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause",
];

export interface ResearchSessionProjectionActive {
  readonly protocol: typeof SESSION_PROJECTION_PROTOCOL;
  readonly session_id: string;
  readonly operation_id: string;
  readonly state: "ACTIVE";
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly run_status: {
    readonly execution_state: "ACTIVE";
    readonly engine_status: ResearchSessionEngineStatus;
    readonly next_stage_index: number;
  };
}

export interface ResearchSessionProjectionCancelled {
  readonly protocol: typeof SESSION_PROJECTION_PROTOCOL;
  readonly session_id: string;
  readonly operation_id: string;
  readonly state: "CANCELLED";
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly cancellation_receipt_ref: string;
}

export interface ResearchSessionProjectionCompleted {
  readonly protocol: typeof SESSION_PROJECTION_PROTOCOL;
  readonly session_id: string;
  readonly operation_id: string;
  readonly state: "ENGINE_COMPLETED";
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly completion_receipt_ref: string;
  readonly output_manifest_ref: string;
}

export type ResearchSessionProjection =
  | ResearchSessionProjectionActive
  | ResearchSessionProjectionCancelled
  | ResearchSessionProjectionCompleted;

export interface ResearchSessionProjectionDecoder {
  decodeProjection: (raw: unknown) => ResearchSessionProjection;
  isChatHistoryDisabled: (error: unknown) => boolean;
}

export function createResearchSessionProjectionDecoder(
  errors: LegacyErrorFactory,
): ResearchSessionProjectionDecoder {
  const { invalid, record, objectRecord, boundedString, identifier } = createResearchRunWire(errors);

  function reference(value: unknown, label: string): { readonly id: string; readonly revision: number } {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) invalid(`${label} is invalid`);
    // `success` is true past the guard, so the value is the parsed reference.
    if (!parsed.success) return invalid(`${label} is invalid`);
    return { id: parsed.data.id, revision: parsed.data.revision };
  }

  function sessionId(value: unknown): string {
    return boundedString(identifier(value, "session_id"), "session_id", 128);
  }

  function operationId(value: unknown): string {
    return boundedString(identifier(value, "operation_id"), "operation_id", 128);
  }

  function receiptRef(value: unknown, label: string): string {
    return boundedString(identifier(value, label), label, 256);
  }

  function runStatus(value: unknown): {
    readonly execution_state: "ACTIVE";
    readonly engine_status: ResearchSessionEngineStatus;
    readonly next_stage_index: number;
  } {
    const status = record(value, ["execution_state", "engine_status", "next_stage_index"]);
    if (status.execution_state !== "ACTIVE") invalid("run status execution state is invalid");
    if (typeof status.engine_status !== "string" ||
        !ENGINE_STATUSES.includes(status.engine_status as ResearchSessionEngineStatus)) {
      invalid("engine status is invalid");
    }
    if (!Number.isSafeInteger(status.next_stage_index) || (status.next_stage_index as number) < 0) {
      invalid("next stage index is invalid");
    }
    return {
      execution_state: "ACTIVE",
      engine_status: status.engine_status as ResearchSessionEngineStatus,
      next_stage_index: status.next_stage_index as number,
    };
  }

  function decodeProjection(raw: unknown): ResearchSessionProjection {
    const outer = objectRecord(raw);
    if (Object.keys(outer).some((key) => !PROJECTION_KEYS.includes(key as (typeof PROJECTION_KEYS)[number]))) {
      invalid("projection carries an unknown field");
    }
    if (outer.protocol !== SESSION_PROJECTION_PROTOCOL) invalid("projection protocol is invalid");
    const state = outer.state;
    if (state !== "ACTIVE" && state !== "CANCELLED" && state !== "ENGINE_COMPLETED") {
      invalid("projection state is invalid");
    }
    const base = {
      protocol: SESSION_PROJECTION_PROTOCOL,
      session_id: sessionId(outer.session_id),
      operation_id: operationId(outer.operation_id),
      investigation_ref: reference(outer.investigation_ref, "investigation_ref"),
    } as const;
    if (state === "ACTIVE") {
      for (const key of ["cancellation_receipt_ref", "completion_receipt_ref", "output_manifest_ref"]) {
        if (Object.hasOwn(outer, key)) invalid("an active projection carries only its run status");
      }
      if (!Object.hasOwn(outer, "run_status")) invalid("an active projection carries a run status");
      return { ...base, state: "ACTIVE", run_status: runStatus(outer.run_status) };
    }
    if (state === "CANCELLED") {
      if (!Object.hasOwn(outer, "cancellation_receipt_ref") || Object.hasOwn(outer, "run_status")) {
        invalid("a cancelled projection carries only its cancellation receipt");
      }
      return {
        ...base,
        state: "CANCELLED",
        cancellation_receipt_ref: receiptRef(outer.cancellation_receipt_ref, "cancellation_receipt_ref"),
      };
    }
    if (!Object.hasOwn(outer, "completion_receipt_ref") || !Object.hasOwn(outer, "output_manifest_ref") ||
        Object.hasOwn(outer, "run_status")) {
      invalid("a completed projection carries only its completion receipts");
    }
    return {
      ...base,
      state: "ENGINE_COMPLETED",
      completion_receipt_ref: receiptRef(outer.completion_receipt_ref, "completion_receipt_ref"),
      output_manifest_ref: receiptRef(outer.output_manifest_ref, "output_manifest_ref"),
    };
  }

  function isChatHistoryDisabled(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const candidate = error as { readonly code?: unknown; readonly status?: unknown };
    return candidate.code === CHAT_HISTORY_DISABLED_CODE && candidate.status === CHAT_HISTORY_STATUS_CODE;
  }

  return { decodeProjection, isChatHistoryDisabled };
}
