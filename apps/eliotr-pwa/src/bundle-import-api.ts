import { BundleAdmissionReceiptSchema, type BundleAdmissionReceipt } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";
import { type BrowserBundle, checkCancelled } from "./bundle-input.js";

export function importMismatch(): never {
  throw new ApiRequestError({ status: 502, code: "INGEST_RESPONSE_MISMATCH",
    message: "Ingest response identity or schema differs from the requested operation. Inspect durable status." });
}
export function importRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) importMismatch();
  return value as Record<string, unknown>;
}
export function importIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) importMismatch();
  return value;
}
export function importOpaque(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) importMismatch();
  return value;
}
export function importDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) importMismatch(); return value;
}
export function importTime(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) importMismatch(); return Date.parse(value);
}
export interface ImportIdentity {
  readonly operation: string; readonly manifestDigest: string; readonly sourceRevision: string; readonly generation: string;
}
export function receiptFor(value: unknown, identity: ImportIdentity): BundleAdmissionReceipt {
  const parsed = BundleAdmissionReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.operation_id !== identity.operation ||
      parsed.data.manifest_sha256 !== identity.manifestDigest || parsed.data.source_revision_ref !== identity.sourceRevision) importMismatch();
  return parsed.data;
}
export type ImportTransport = (path: string, init?: RequestInit) => Promise<unknown>;
export async function importCall(path: string, init: RequestInit, transport: ImportTransport = requestApi,
  generation?: string): Promise<{ data: unknown; generation: string }> {
  checkCancelled(init.signal ?? undefined);
  const envelope = importRecord(await transport(path, init), ["data", "trace_id", "deployment_generation"]);
  checkCancelled(init.signal ?? undefined);
  importIdentifier(envelope.trace_id);
  const observed = importIdentifier(envelope.deployment_generation);
  if (generation !== undefined && generation !== observed) importMismatch();
  return { data: envelope.data, generation: observed };
}
export interface PreparedImport {
  readonly identity: ImportIdentity; readonly session?: string; readonly expiry: number;
  readonly files: readonly { path: string; maxPart: number }[]; readonly existing?: BundleAdmissionReceipt;
  readonly rejected: boolean; readonly reasons: readonly string[];
}
export function decodePrepared(data: unknown, bundle: BrowserBundle, generation: string): PreparedImport {
  const record = importRecord(data, ["operation_id", "manifest_sha256", "disposition", "expires_at", "reason_codes"],
    ["multipart_session_ref", "files", "existing_receipt"]);
  const identity: ImportIdentity = { operation: importIdentifier(record.operation_id), manifestDigest: importDigest(record.manifest_sha256),
    sourceRevision: bundle.manifest.origin.source_revision_ref, generation };
  if (!Array.isArray(record.reason_codes) || record.reason_codes.length > 128) importMismatch();
  const reasons = record.reason_codes.map(importIdentifier);
  if (new Set(reasons).size !== reasons.length) importMismatch();
  const expiry = importTime(record.expires_at);
  const existing = record.existing_receipt === undefined ? undefined : receiptFor(record.existing_receipt, identity);
  if (record.disposition === "DUPLICATE" || record.disposition === "REJECTED") {
    if (record.files !== undefined || record.multipart_session_ref !== undefined ||
        (record.disposition === "DUPLICATE" && (!existing || !["ADMITTED", "DUPLICATE"].includes(existing.decision))) ||
        (record.disposition === "REJECTED" && existing && !["REJECTED", "QUARANTINED"].includes(existing.decision))) importMismatch();
    return { identity, expiry, files: [], rejected: record.disposition === "REJECTED", reasons, ...(existing ? { existing } : {}) };
  }
  if (record.disposition !== "UPLOAD_REQUIRED" || existing || !Array.isArray(record.files) ||
      record.files.length !== bundle.files.length || expiry <= Date.now()) importMismatch();
  const paths = new Set<string>();
  const files = record.files.map((raw) => {
    const item = importRecord(raw, ["path", "expected_sha256", "max_part_bytes"]);
    if (typeof item.path !== "string" || item.path.length > 512) importMismatch();
    const path = item.path;
    if (paths.has(path) || bundle.hashes[path] !== importDigest(item.expected_sha256) ||
        typeof item.max_part_bytes !== "number" || !Number.isSafeInteger(item.max_part_bytes) ||
        item.max_part_bytes < 5 * 1024 * 1024 || item.max_part_bytes > 8 * 1024 * 1024) importMismatch();
    paths.add(path); return { path, maxPart: item.max_part_bytes };
  });
  return { identity, expiry, files, session: importIdentifier(record.multipart_session_ref), rejected: false, reasons };
}
export interface ImportStatus { readonly state: string; readonly receipt?: BundleAdmissionReceipt; }
export async function readImportStatus(identity: ImportIdentity, signal?: AbortSignal,
  transport: ImportTransport = requestApi, session?: string): Promise<ImportStatus> {
  const result = await importCall(`/api/v1/ingest/bundles/${encodeURIComponent(identity.operation)}`,
    { ...(signal ? { signal } : {}) }, transport, identity.generation);
  return decodeImportStatus(result.data, identity, session);
}
export function decodeImportStatus(value: unknown, identity: ImportIdentity, session?: string): ImportStatus {
  const row = importRecord(value, ["operation_id", "state", "source_revision_ref", "expires_at", "updated_at"],
    ["staging_session_ref", "qualification_report_ref", "decision_receipt_ref", "promotion_receipt_ref", "receipt"]);
  if (row.operation_id !== identity.operation || row.source_revision_ref !== identity.sourceRevision ||
      !["PREPARING", "UPLOAD_REQUIRED", "VERIFIED", "AUTHORIZED", "PROMOTED", "COMMITTED", "QUARANTINED", "REJECTED"].includes(String(row.state))) importMismatch();
  importTime(row.expires_at); importTime(row.updated_at);
  for (const key of ["staging_session_ref", "qualification_report_ref", "decision_receipt_ref", "promotion_receipt_ref"]) {
    if (row[key] !== undefined) importIdentifier(row[key]);
  }
  const receipt = row.receipt === undefined ? undefined : receiptFor(row.receipt, identity);
  if (row.state === "COMMITTED" && (!receipt || !["ADMITTED", "DUPLICATE"].includes(receipt.decision))) importMismatch();
  if (receipt && row.state !== "COMMITTED" && row.state !== receipt.decision) importMismatch();
  if (session !== undefined && (!receipt && importTime(row.expires_at) <= Date.now() || row.staging_session_ref !== session)) importMismatch();
  return { state: String(row.state), ...(receipt ? { receipt } : {}) };
}
