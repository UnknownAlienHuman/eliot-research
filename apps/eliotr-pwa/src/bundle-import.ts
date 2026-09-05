import { type BundleAdmissionReceipt } from "@eliotr/contracts";
import { requestApi } from "./api.js";
import { type BrowserBundle, checkCancelled, bundleInputError } from "./bundle-input.js";
import { decodePrepared, importCall, importIdentifier, importOpaque, importMismatch, importRecord, importTime, receiptFor,
  readImportStatus, type ImportIdentity, type ImportTransport } from "./bundle-import-api.js";

export interface ImportProgress { readonly phase: string; readonly bytes: number; readonly total: number; }
export interface ImportOptions {
  readonly signal?: AbortSignal;
  readonly transport?: ImportTransport;
  readonly onIdentity?: (identity: ImportIdentity) => void;
  readonly onProgress?: (progress: ImportProgress) => void;
}
/** A single attempt. Never automatically repeat multipart/commit mutations after an uncertain response. */
export async function importBrowserBundle(bundle: BrowserBundle, idempotencyKey: string,
  options: ImportOptions = {}): Promise<BundleAdmissionReceipt | null> {
  const transport = options.transport ?? requestApi;
  const signal = options.signal;
  importIdentifier(idempotencyKey); checkCancelled(signal);
  let sent = 0;
  const progress = (phase: string) => options.onProgress?.({ phase, bytes: sent, total: bundle.totalBytes });
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  progress("Preparing upload");
  const prepareRequest = json({ manifest: bundle.manifest, file_hashes: bundle.hashes,
    total_bytes: bundle.totalBytes, idempotency_key: idempotencyKey });
  if (new TextEncoder().encode(String(prepareRequest.body)).byteLength > 256 * 1024) {
    bundleInputError("The prepare request exceeds the HTTP metadata budget.");
  }
  const response = await importCall("/api/v1/ingest/bundles/prepare", prepareRequest, transport);
  const prepared = decodePrepared(response.data, bundle, response.generation);
  options.onIdentity?.(prepared.identity);
  const { identity } = prepared;
  if (prepared.existing) {
    const observed = await readImportStatus(identity, signal, transport);
    if (!observed.receipt || JSON.stringify(observed.receipt) !== JSON.stringify(prepared.existing)) importMismatch();
    return prepared.existing;
  }
  if (prepared.rejected) { progress(`Rejected: ${prepared.reasons.join(", ")}`); return null; }
  const current = () => { checkCancelled(signal); if (Date.now() >= prepared.expiry) importMismatch(); };
  const checkBinding = (row: Record<string, unknown>, path: string) => {
    if (row.operation_id !== identity.operation || row.multipart_session_ref !== prepared.session || row.path !== path) importMismatch();
  };
  const base = `/api/v1/ingest/bundles/${encodeURIComponent(identity.operation)}`;
  for (const upload of prepared.files) {
    current();
    const file = bundle.files.find((candidate) => candidate.path === upload.path);
    if (!file) importMismatch();
    const parts: { part_number: number; size_bytes: number; etag: string }[] = [];
    for (let start = 0, number = 1; start < file.blob.size; start += upload.maxPart, number += 1) {
      current();
      const part = file.blob.slice(start, start + upload.maxPart);
      const query = new URLSearchParams({ multipart_session_ref: prepared.session ?? "", path: file.path,
        size_bytes: String(part.size), final_part: start + part.size === file.blob.size ? "1" : "0" });
      const result = await importCall(`${base}/parts/${number}?${query.toString()}`, { method: "PUT", body: part,
        headers: { "content-type": "application/octet-stream" }, ...(signal ? { signal } : {}) }, transport, identity.generation);
      const row = importRecord(result.data, ["operation_id", "multipart_session_ref", "path", "part_number", "size_bytes", "etag"]);
      checkBinding(row, file.path);
      if (row.part_number !== number || row.size_bytes !== part.size) importMismatch();
      parts.push({ part_number: number, size_bytes: part.size, etag: importOpaque(row.etag) });
      sent += part.size; progress("Uploading verified bytes");
    }
    current();
    const result = await importCall(`${base}/files/complete`, json({ multipart_session_ref: prepared.session,
      path: file.path, parts }), transport, identity.generation);
    const row = importRecord(result.data, ["operation_id", "multipart_session_ref", "path", "sha256", "size_bytes", "etag", "completed_at"]);
    checkBinding(row, file.path);
    if (row.sha256 !== bundle.hashes[file.path] || row.size_bytes !== file.blob.size) importMismatch();
    importOpaque(row.etag); importTime(row.completed_at);
  }
  current(); progress("Checking admission and canonical readback");
  const committed = await importCall("/api/v1/ingest/bundles/commit", json({ operation_id: identity.operation,
    multipart_session_ref: prepared.session, manifest_sha256: identity.manifestDigest }), transport, identity.generation);
  const receipt = receiptFor(committed.data, identity);
  // A response alone does not mean durable settlement. Inspect the real operation before reporting it.
  progress("Reading durable status");
  const status = await readImportStatus(identity, signal, transport);
  if (!status.receipt || JSON.stringify(status.receipt) !== JSON.stringify(receipt)) importMismatch();
  progress(receipt.decision === "ADMITTED" || receipt.decision === "DUPLICATE"
    ? "Admitted; search index readiness is separate" : `${receipt.decision}; no admitted source`);
  return receipt;
}
