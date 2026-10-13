// C3-RH move of packages/pwa-research-workspace/src/research-changes-api.ts.
// Helpers stay independent by design: their own bounds, patterns and error codes.
// Only the transport, error and epoch seams are injected. No new DTO or endpoint.
//
// v2 adds the named bounded-read visibility scan next to the four existing v1 fields. Those fields
// keep their exact semantics: the same page bound, cursor shape and byte limit, the same envelope and
// epoch fences, the same request body and the same five change kinds.
import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import type { LegacyErrorFactory, LegacyHttpAdapter } from "../../legacy/http.js";
import type { EpochPort } from "../../transport/client.js";

const CHANGES_PATH = "/api/v1/research/changes";
const CHANGES_PROTOCOL_V1 = "eliotr.research-changes.v1" as const;
const CHANGES_PROTOCOL_V2 = "eliotr.research-changes.v2" as const;
const MAX_ITEMS = 20;
const MAX_CURSOR_BYTES = 4_096;
const MAX_METADATA_BYTES = 65_536;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHANGE_KINDS = ["RESEARCH_COMPLETED", "ARTIFACT_DRAFTED", "WIKI_PUBLISHED", "SOURCE_ADMITTED", "SOURCE_UPDATED"] as const;
const SCAN_DIRECTIONS = ["FORWARD", "LATEST"] as const;
const SCAN_STATES = ["TARGET_REACHED", "SOURCE_EXHAUSTED", "BUDGET_STOPPED"] as const;

export type ResearchChangesKind = typeof CHANGE_KINDS[number];

export type ResearchChangesProtocol = typeof CHANGES_PROTOCOL_V1 | typeof CHANGES_PROTOCOL_V2;

/** Traversal direction of the bounded read. Never a count and never a record identity. */
export type ResearchChangesScanDirection = typeof SCAN_DIRECTIONS[number];

/**
 * Named completion state of the bounded read. `BUDGET_STOPPED` reports that the candidate budget ran
 * out before the target or the source end; it never asserts completion or emptiness.
 */
export type ResearchChangesScanState = typeof SCAN_STATES[number];

export interface ResearchChangesVisibilityScan {
  readonly direction: ResearchChangesScanDirection;
  readonly state: ResearchChangesScanState;
}

export interface ResearchChangeFeedItem {
  readonly kind: ResearchChangesKind;
  readonly subject_ref: string;
  readonly subject_revision: number;
  readonly occurred_at: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResearchChangesView {
  readonly items: readonly ResearchChangeFeedItem[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
  readonly deployment_generation: string;
  /** Present only for `eliotr.research-changes.v2`; absent for v1. */
  readonly visibility_scan?: ResearchChangesVisibilityScan;
}

export interface ReadResearchChangesOptions {
  readonly afterCursor?: string | null;
  readonly startAt?: "latest";
  readonly signal?: AbortSignal;
}

export type ChangesHttp = Pick<LegacyHttpAdapter, "requestApi">;
export type ChangesErrors = LegacyErrorFactory;

export interface ChangesApi {
  /** Pure decoder. No epoch, no transport, no ambient state. */
  readonly decodeResearchChanges: (raw: unknown, expectedDeploymentGeneration: string) => ResearchChangesView;
  readonly readResearchChanges: (expectedDeploymentGeneration: string, options?: ReadResearchChangesOptions) => Promise<ResearchChangesView>;
}

export function createChangesApi(http: ChangesHttp, errors: ChangesErrors, epoch: EpochPort): ChangesApi {
  const invalid = (message: string): never => {
    throw errors({
      status: 502,
      code: "RESEARCH_CHANGES_RESPONSE_INVALID",
      message,
      traceId: null,
      retryable: false,
    });
  };

  const inputInvalid = (message: string): never => {
    throw errors({
      status: 400,
      code: "RESEARCH_CHANGES_INPUT_INVALID",
      message,
      traceId: null,
      retryable: false,
    });
  };

  const closed = (): never => {
    throw errors({
      status: 503,
      code: "API_SESSION_CLOSED",
      message: "Response belongs to a closed owner session",
      traceId: null,
      retryable: false,
    });
  };

  /** Type guards that return the narrowing predicate TS needs after each rejection. */
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const exactRecord = (
    value: unknown,
    required: readonly string[],
    optional: readonly string[],
    label: string,
  ): Record<string, unknown> => {
    if (!isRecord(value)) return invalid(`${label} is not an object`);
    if (required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
      return invalid(`${label} has missing or unknown fields`);
    }
    return value;
  };

  const boundedString = (value: unknown, label: string, maximum: number): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
      return invalid(`${label} is invalid`);
    }
    return value;
  };

  const generation = (value: unknown, label: string): string => {
    const text = boundedString(value, label, 256);
    if (!SAFE_GENERATION.test(text)) return invalid(`${label} is invalid`);
    return text;
  };

  const traceId = (value: unknown): string => {
    const text = boundedString(value, "trace_id", 128);
    if (!SAFE_TRACE_ID.test(text)) return invalid("trace_id is invalid");
    return text;
  };

  const reference = (value: unknown, label: string): string => {
    const text = boundedString(value, label, 512);
    if (!SAFE_REF.test(text) || text.includes("..") || text.includes("\\")) return invalid(`${label} is invalid`);
    return text;
  };

  const sha256 = (value: unknown, label: string): string => {
    const text = boundedString(value, label, 64);
    if (!/^[a-f0-9]{64}$/u.test(text)) return invalid(`${label} is invalid`);
    return text;
  };

  const timestamp = (value: unknown, label: string): string => {
    const text = boundedString(value, label, 64);
    if (!ISO_MILLISECONDS.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
      return invalid(`${label} is invalid`);
    }
    return text;
  };

  const positiveInteger = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid(`${label} is invalid`);
    return value;
  };

  const versionedRef = (value: unknown, label: string): VersionedRef => {
    const parsed = VersionedRefSchema.safeParse(value);
    if (!parsed.success) return invalid(`${label} is invalid`);
    return parsed.data;
  };

  const flatMetadata = (
    value: unknown,
  ): Readonly<Record<string, string | number | boolean | null>> => {
    if (!isRecord(value)) return invalid("change metadata is not a flat object");
    const keys = Object.keys(value);
    const sorted = [...keys].sort();
    if (keys.some((key, index) => key !== sorted[index] || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key))) {
      return invalid("change metadata keys are invalid or noncanonical");
    }
    const metadata: Record<string, string | number | boolean | null> = {};
    for (const key of keys) {
      const item: unknown = value[key];
      if (item !== null && typeof item !== "string" && typeof item !== "boolean" &&
          (typeof item !== "number" || !Number.isFinite(item))) {
        return invalid("change metadata must contain only scalar values");
      }
      metadata[key] = item as string | number | boolean | null;
    }
    let encoded!: string;
    try { encoded = JSON.stringify(metadata); }
    catch { return invalid("change metadata could not be encoded"); }
    if (new TextEncoder().encode(encoded).byteLength > MAX_METADATA_BYTES) {
      return invalid("change metadata exceeds its byte bound");
    }
    return metadata;
  };

  const cursor = (value: unknown, label: string): string => {
    const text = boundedString(value, label, MAX_CURSOR_BYTES);
    if (new TextEncoder().encode(text).byteLength > MAX_CURSOR_BYTES || !SAFE_CURSOR.test(text)) {
      return invalid(`${label} is invalid`);
    }
    return text;
  };

  const expectedGeneration = (value: string): string => {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() || !SAFE_GENERATION.test(value)) {
      return inputInvalid("deployment generation is invalid");
    }
    return value;
  };

  const requestCursor = (value: string | null | undefined): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_BYTES ||
        !SAFE_CURSOR.test(value)) return inputInvalid("afterCursor is invalid");
    return value;
  };

  const scanDirection = (value: unknown, label: string): ResearchChangesScanDirection => {
    const text = boundedString(value, label, 32);
    const direction = SCAN_DIRECTIONS.find((candidate) => candidate === text);
    if (direction === undefined) return invalid(`${label} is invalid`);
    return direction;
  };

  const scanState = (value: unknown, label: string): ResearchChangesScanState => {
    const text = boundedString(value, label, 32);
    const state = SCAN_STATES.find((candidate) => candidate === text);
    if (state === undefined) return invalid(`${label} is invalid`);
    return state;
  };

  const visibilityScan = (value: unknown): ResearchChangesVisibilityScan => {
    const scan = exactRecord(value, ["direction", "state"], [], "changes data.visibility_scan");
    return {
      direction: scanDirection(scan.direction, "changes data.visibility_scan.direction"),
      state: scanState(scan.state, "changes data.visibility_scan.state"),
    };
  };

  const decodeItem = (value: unknown, index: number): ResearchChangeFeedItem => {
    const item = exactRecord(value, [
      "sequence", "change_ref", "kind", "subject_ref", "subject_revision", "payload_ref",
      "payload_sha256", "occurred_at", "metadata",
    ], ["visibility_principal_ref", "visibility_scope_ref"], `changes.items[${index}]`);
    positiveInteger(item.sequence, `changes.items[${index}].sequence`);
    reference(item.change_ref, `changes.items[${index}].change_ref`);
    if (!CHANGE_KINDS.includes(item.kind as ResearchChangesKind)) invalid(`changes.items[${index}].kind is invalid`);
    const subjectRef = reference(item.subject_ref, `changes.items[${index}].subject_ref`);
    const subjectRevision = positiveInteger(item.subject_revision, `changes.items[${index}].subject_revision`);
    reference(item.payload_ref, `changes.items[${index}].payload_ref`);
    sha256(item.payload_sha256, `changes.items[${index}].payload_sha256`);
    const occurredAt = timestamp(item.occurred_at, `changes.items[${index}].occurred_at`);
    const metadata = flatMetadata(item.metadata);
    if (Object.hasOwn(item, "visibility_principal_ref")) {
      reference(item.visibility_principal_ref, `changes.items[${index}].visibility_principal_ref`);
    }
    if (Object.hasOwn(item, "visibility_scope_ref")) {
      versionedRef(item.visibility_scope_ref, `changes.items[${index}].visibility_scope_ref`);
    }
    return {
      kind: item.kind as ResearchChangesKind,
      subject_ref: subjectRef,
      subject_revision: subjectRevision,
      occurred_at: occurredAt,
      metadata,
    };
  };

  const decodeEnvelope = (value: unknown, expected: string): Record<string, unknown> => {
    const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], [], "changes envelope");
    traceId(envelope.trace_id);
    const actual = generation(envelope.deployment_generation, "deployment_generation");
    if (actual !== expected) {
      throw errors({
        status: 409,
        code: "RESEARCH_CHANGES_DEPLOYMENT_CHANGED",
        message: "The application changed; refresh the recent research activity.",
        traceId: null,
        retryable: true,
      });
    }
    if (!isRecord(envelope.data)) return invalid("changes data is not an object");
    return envelope.data;
  };

  const decodeResearchChanges = (raw: unknown, expectedDeploymentGeneration: string): ResearchChangesView => {
    const expected = expectedGeneration(expectedDeploymentGeneration);
    const data = decodeEnvelope(raw, expected);
    const v2 = data.protocol === CHANGES_PROTOCOL_V2;
    if (data.protocol !== CHANGES_PROTOCOL_V1 && !v2) return invalid("changes result is invalid");
    const response = exactRecord(data,
      v2 ? ["protocol", "items", "next_cursor", "has_more", "visibility_scan"]
        : ["protocol", "items", "next_cursor", "has_more"], [], "changes data");
    if (!Array.isArray(response.items) || response.items.length > MAX_ITEMS ||
        typeof response.has_more !== "boolean") {
      return invalid("changes result is invalid");
    }
    const entries = response.items as unknown[];
    const items = entries.map((entry: unknown, index: number) => decodeItem(entry, index));
    if (v2) {
      // decodeItem has already validated each full record and its positive safe sequence.
      const sequences = entries.map((entry: unknown) => {
        if (!isRecord(entry)) return invalid("changes item is not an object");
        return positiveInteger(entry.sequence, "changes item.sequence");
      });
      // Only the bounded read promises an ascending unique page, so only v2 enforces it. Each
      // sequence is already an accepted safe positive integer, so a duplicate or rewind is rejected
      // instead of being silently reordered into the projected view.
      for (let index = 1; index < sequences.length; index += 1) {
        const previous = sequences[index - 1];
        const current = sequences[index];
        if (previous === undefined || current === undefined || current <= previous) {
          return invalid("changes items are not strictly ascending");
        }
      }
    }
    const nextCursor = response.next_cursor === null ? null : cursor(response.next_cursor, "next_cursor");
    const hasMore = response.has_more as boolean;
    if (v2) {
      const scan = visibilityScan(response.visibility_scan);
      // A page that returns items owes the caller the cursor that resumes them, even when the read
      // stopped for its budget or reached the end of the source.
      if (items.length > 0 && nextCursor === null) {
        return invalid("changes items require a continuation cursor");
      }
      if (scan.state === "BUDGET_STOPPED" && (!hasMore || nextCursor === null)) {
        return invalid("a budget-stopped scan must continue");
      }
      if (scan.state === "SOURCE_EXHAUSTED" && hasMore) {
        return invalid("an exhausted scan must not promise more data");
      }
      if (scan.state === "TARGET_REACHED" && scan.direction === "FORWARD" &&
          (!hasMore || items.length === 0 || nextCursor === null)) {
        return invalid("a forward target must report visible lookahead");
      }
      if (scan.state === "TARGET_REACHED" && scan.direction === "LATEST" &&
          (hasMore || items.length === 0 || nextCursor === null)) {
        return invalid("a completed latest window must report a nonempty ordered page");
      }
      return {
        items,
        next_cursor: nextCursor,
        has_more: hasMore,
        deployment_generation: expected,
        visibility_scan: scan,
      };
    }
    return {
      items,
      next_cursor: nextCursor,
      has_more: hasMore,
      deployment_generation: expected,
    };
  };

  const readResearchChanges = async (
    expectedDeploymentGeneration: string,
    options: ReadResearchChangesOptions = {},
  ): Promise<ResearchChangesView> => {
    const expected = expectedGeneration(expectedDeploymentGeneration);
    const afterCursor = requestCursor(options.afterCursor);
    if (options.startAt !== undefined && options.startAt !== "latest") inputInvalid("startAt is invalid");
    const request: Record<string, unknown> = {
      after_cursor: afterCursor,
      limit: MAX_ITEMS,
      kinds: [...CHANGE_KINDS],
    };
    if (options.startAt !== undefined) request.start_at = options.startAt;
    // Preflight: an already-closed or missing epoch never dispatches.
    const capture = epoch.capture();
    if (capture === undefined || !epoch.isCurrent(capture)) closed();
    const raw = await http.requestApi(CHANGES_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
      body: JSON.stringify(request),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const view = decodeResearchChanges(raw, expected);
    // Post-await/post-decode fence: a stale response never reaches the caller.
    if (!epoch.isCurrent(capture)) closed();
    return view;
  };

  return { decodeResearchChanges, readResearchChanges };
}
