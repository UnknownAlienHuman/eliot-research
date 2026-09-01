import {
  LocatorCandidateSchema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import type { VerifyEvidenceRequest } from "@eliotr/interfaces";
import { readRequestBodyWithinBytes } from "@eliotr/platform-cloudflare";

export class EvidenceHttpInputError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable = false;

  public constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "EvidenceHttpInputError";
    this.code = code;
    this.status = status;
  }
}

function fail(code: string, status: number, message: string): never {
  throw new EvidenceHttpInputError(code, status, message);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("EVIDENCE_BODY_INVALID", 400, "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) {
    fail("EVIDENCE_UNKNOWN_FIELD", 400, "request contains an unknown field");
  }
}

async function jsonBody(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    fail("EVIDENCE_CONTENT_TYPE_INVALID", 415, "request body must use application/json");
  }
  const bytes = await readRequestBodyWithinBytes(request, {
    label: "http.request.evidence-json",
    max_bytes: maximumBytes,
    max_chunks: 4096,
  });
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("EVIDENCE_BODY_INVALID", 400, "request body is not UTF-8"); }
  try { return record(JSON.parse(text)); }
  catch { fail("EVIDENCE_BODY_INVALID", 400, "request body is not valid JSON"); }
}

export async function parseVerifyEvidenceRequest(
  request: Request,
  maximumBytes: number,
): Promise<VerifyEvidenceRequest> {
  const value = await jsonBody(request, maximumBytes);
  exactKeys(value, ["scope_snapshot_ref", "locator_candidate", "handle_ref"]);
  let scopeSnapshotRef: VersionedRef;
  try { scopeSnapshotRef = VersionedRefSchema.parse(value.scope_snapshot_ref); }
  catch { fail("EVIDENCE_SCOPE_REF_INVALID", 400, "scope_snapshot_ref is invalid"); }
  const hasLocator = value.locator_candidate !== undefined;
  const hasHandle = value.handle_ref !== undefined;
  if (hasLocator === hasHandle) {
    fail("EVIDENCE_VERIFY_TARGET_INVALID", 400, "exactly one locator_candidate or handle_ref is required");
  }
  if (hasLocator) {
    try {
      return {
        scope_snapshot_ref: scopeSnapshotRef,
        locator_candidate: LocatorCandidateSchema.parse(value.locator_candidate),
      };
    } catch {
      fail("EVIDENCE_LOCATOR_INVALID", 400, "locator_candidate is invalid");
    }
  }
  try {
    return {
      scope_snapshot_ref: scopeSnapshotRef,
      handle_ref: VersionedRefSchema.parse(value.handle_ref),
    };
  } catch {
    fail("EVIDENCE_HANDLE_REF_INVALID", 400, "handle_ref is invalid");
  }
}

export function parseEvidenceHandleRef(value: string): VersionedRef {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    fail("EVIDENCE_HANDLE_REF_INVALID", 400, "evidence handle ref must end with :revision");
  }
  const id = value.slice(0, separator);
  const rawRevision = value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(rawRevision)) {
    fail("EVIDENCE_HANDLE_REF_INVALID", 400, "evidence handle revision is invalid");
  }
  try { return VersionedRefSchema.parse({ id, revision: Number(rawRevision) }); }
  catch { fail("EVIDENCE_HANDLE_REF_INVALID", 400, "evidence handle ref is invalid"); }
}

export function parseEvidenceOpenRange(
  url: URL,
): { readonly start: number; readonly end: number } | undefined {
  const allowed = new Set(["start", "end"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) fail("EVIDENCE_QUERY_UNKNOWN", 400, "open query contains an unknown parameter");
  }
  const starts = url.searchParams.getAll("start");
  const ends = url.searchParams.getAll("end");
  if (starts.length > 1 || ends.length > 1) {
    fail("EVIDENCE_QUERY_DUPLICATED", 400, "open range parameter is duplicated");
  }
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1) {
    fail("EVIDENCE_RANGE_INVALID", 400, "open range requires both start and end");
  }
  const startRaw = starts[0];
  const endRaw = ends[0];
  if (startRaw === undefined || endRaw === undefined ||
      !/^(0|[1-9][0-9]*)$/u.test(startRaw) || !/^[1-9][0-9]*$/u.test(endRaw)) {
    fail("EVIDENCE_RANGE_INVALID", 400, "open range must contain decimal byte offsets");
  }
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    fail("EVIDENCE_RANGE_INVALID", 400, "open range is invalid");
  }
  return { start, end };
}
