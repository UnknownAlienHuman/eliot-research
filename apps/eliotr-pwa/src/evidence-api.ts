import {
  EvidenceHandleSchema,
  ResolvedEvidenceSchema,
  Sha256Schema,
  VersionedRefSchema,
  type ResolvedEvidence,
  type VersionedRef,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi, requestApiText } from "./api.js";

const MAX_EVIDENCE_BYTES = 512 * 1024;

export interface OpenedEvidence {
  readonly text: string;
  readonly handleRef: VersionedRef;
  readonly excerptSha256: string;
  readonly verificationReceiptRef: string;
}

export interface VerifiedEvidence extends OpenedEvidence {
  readonly evidence: ResolvedEvidence;
}

function mismatch(message = "Evidence response is invalid; run the query again"): never {
  throw new ApiRequestError({ status: 502, code: "EVIDENCE_RESPONSE_INVALID", message });
}

function record(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !required.includes(key)) ||
      required.some((key) => !Object.hasOwn(value, key))) mismatch();
  return value as Record<string, unknown>;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value || value !== value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) mismatch();
  return value;
}

function parseHandleHeader(value: string): VersionedRef {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1 || !/^[1-9][0-9]*$/u.test(value.slice(separator + 1))) {
    mismatch("Opened evidence handle is invalid");
  }
  const parsed = VersionedRefSchema.safeParse({ id: value.slice(0, separator), revision: Number(value.slice(separator + 1)) });
  if (!parsed.success) mismatch("Opened evidence handle is invalid");
  return parsed.data;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export async function verifyEvidence(
  scopeSnapshotRef: VersionedRef,
  handleRef: VersionedRef,
  signal?: AbortSignal,
): Promise<ResolvedEvidence> {
  const scope = VersionedRefSchema.parse(scopeSnapshotRef);
  const handle = VersionedRefSchema.parse(handleRef);
  const raw = await requestApi("/api/v1/research/verify", {
    method: "POST",
    body: JSON.stringify({ scope_snapshot_ref: scope, handle_ref: handle }),
    headers: { "content-type": "application/json" },
    ...(signal ? { signal } : {}),
  });
  const envelope = record(raw, ["data", "trace_id", "deployment_generation"]);
  const data = record(envelope.data, ["resolved_evidence", "handle"]);
  let evidence: ResolvedEvidence;
  let returnedHandle: ReturnType<typeof EvidenceHandleSchema.parse>;
  try {
    evidence = ResolvedEvidenceSchema.parse(data.resolved_evidence);
    returnedHandle = EvidenceHandleSchema.parse(data.handle);
  } catch { mismatch(); }
  if (!sameRef(evidence.handle.handle_ref, handle) || !sameRef(evidence.handle.scope_snapshot_ref, scope) ||
      !sameRef(returnedHandle.handle_ref, handle) || !sameRef(returnedHandle.scope_snapshot_ref, scope) ||
      evidence.handle.source_revision_ref !== returnedHandle.source_revision_ref ||
      evidence.handle.excerpt_sha256 !== returnedHandle.excerpt_sha256) {
    mismatch("Verified evidence does not match the selected handle or scope");
  }
  return evidence;
}

export async function openEvidence(handleRef: VersionedRef, signal?: AbortSignal): Promise<OpenedEvidence> {
  const handle = VersionedRefSchema.parse(handleRef);
  const path = `/api/v1/research/open/${encodeURIComponent(`${handle.id}:${handle.revision}`)}`;
  const response = await requestApiText(path, signal, MAX_EVIDENCE_BYTES);
  const returned = parseHandleHeader(requiredHeader(response.headers, "x-eliotr-evidence-handle"));
  if (!sameRef(returned, handle)) mismatch("Opened evidence handle differs from the selected handle");
  const excerptSha256 = requiredHeader(response.headers, "x-eliotr-excerpt-sha256");
  if (!Sha256Schema.safeParse(excerptSha256).success) mismatch("Opened evidence digest is invalid");
  const verificationReceiptRef = requiredHeader(response.headers, "x-eliotr-verification-receipt");
  const length = response.headers.get("content-length");
  const byteLength = new TextEncoder().encode(response.text).byteLength;
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== byteLength)) mismatch("Opened evidence length is invalid");
  return { text: response.text, handleRef: returned, excerptSha256, verificationReceiptRef };
}

export async function verifyAndOpenEvidence(
  scopeSnapshotRef: VersionedRef,
  handleRef: VersionedRef,
  signal?: AbortSignal,
): Promise<VerifiedEvidence> {
  const evidence = await verifyEvidence(scopeSnapshotRef, handleRef, signal);
  const opened = await openEvidence(evidence.handle.handle_ref, signal);
  const contentSha256 = await sha256(opened.text);
  if (!sameRef(opened.handleRef, evidence.handle.handle_ref) || opened.excerptSha256 !== evidence.handle.excerpt_sha256 ||
      opened.excerptSha256 !== contentSha256 || new TextEncoder().encode(opened.text).byteLength !== evidence.handle.excerpt_byte_length ||
      opened.verificationReceiptRef !== evidence.verification_receipt_ref) {
    mismatch("Opened evidence does not match the verified excerpt");
  }
  return { evidence, ...opened };
}
