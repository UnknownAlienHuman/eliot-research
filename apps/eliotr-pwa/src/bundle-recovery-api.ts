import { type BrowserBundle, checkCancelled, safeBundlePath } from "./bundle-input.js";
import { ApiRequestError, requestApi } from "./api.js";
import { decodeImportStatus, importCall, importDigest, importIdentifier, importMismatch, importRecord,
  importTime, type ImportIdentity, type ImportTransport } from "./bundle-import-api.js";

export interface RecoveredImport {
  readonly identity: ImportIdentity;
  readonly key: string;
  readonly session?: string;
}

/** Fetch only the current authenticated reservation; compare every reselected byte hash before writes. */
export async function readBundleRecovery(bundle: BrowserBundle, operationId: string, signal?: AbortSignal,
  transport: ImportTransport = requestApi): Promise<RecoveredImport> {
  importIdentifier(operationId); checkCancelled(signal);
  const response = await importCall(`/api/v1/ingest/bundles/${encodeURIComponent(operationId)}/recovery`,
    { ...(signal ? { signal } : {}) }, transport);
  const row = importRecord(response.data, ["protocol", "status", "idempotency_key", "manifest_sha256", "total_bytes", "file_hashes"]);
  if (row.protocol !== "eliotr.ingest-recovery.v1") importMismatch();
  const identity = { operation: operationId, manifestDigest: importDigest(row.manifest_sha256),
    sourceRevision: bundle.manifest.origin.source_revision_ref, generation: response.generation };
  const status = decodeImportStatus(row.status, identity);
  const raw = row.status as Record<string, unknown>;
  const hashes = importRecord(row.file_hashes, bundle.files.map((file) => file.path));
  if (row.total_bytes !== bundle.totalBytes || Object.entries(hashes).some(([path, value]) =>
    safeBundlePath(path) !== path || importDigest(value) !== bundle.hashes[path])) {
    throw new ApiRequestError({ status: 409, code: "BUNDLE_RECOVERY_FILES_CHANGED",
      message: "Reselect the exact original folder. Its bytes differ from the saved server reservation; nothing was uploaded." });
  }
  if (!status.receipt && importTime(raw.expires_at) <= Date.now()) {
    throw new ApiRequestError({ status: 410, code: "BUNDLE_RECOVERY_EXPIRED",
      message: "The original upload expired. It cannot be continued or silently replaced." });
  }
  checkCancelled(signal);
  return { identity, key: importIdentifier(row.idempotency_key),
    ...(raw.staging_session_ref === undefined ? {} : { session: importIdentifier(raw.staging_session_ref) }) };
}
