import { type BundleAdmissionReceipt } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";
import { discoverBundleRecovery, readBundleRecovery, type RecoveredImport } from "./bundle-recovery-api.js";
import { type BrowserBundle, checkCancelled, bundleInputError } from "./bundle-input.js";
import { decodePrepared, importCall, importIdentifier, importOpaque, importMismatch, importRecord, importTime, receiptFor,
  readImportStatus, type ImportIdentity, type ImportTransport, type PreparedImport } from "./bundle-import-api.js";

export interface ImportProgress { readonly phase: string; readonly bytes: number; readonly total: number; }
export interface ImportOptions {
  readonly signal?: AbortSignal;
  readonly transport?: ImportTransport;
  readonly onIdentity?: (identity: ImportIdentity) => void;
  readonly onProgress?: (progress: ImportProgress) => void;
}
interface FileCheckpoint {
  readonly parts: { part_number: number; size_bytes: number; etag: string }[];
  completed: boolean;
}
interface AttemptCheckpoint { prepared?: PreparedImport; readonly files: Map<string, FileCheckpoint>; readonly recovered?: RecoveredImport; }
export interface BrowserBundleImport {
  readonly canResume: boolean;
  run(options?: ImportOptions): Promise<BundleAdmissionReceipt | null>;
  dispose(): void;
}

/** Explicit same-tab continuation. No timer/retry, private offline storage or new operation identity. */
export function createBrowserBundleImport(input: BrowserBundle, idempotencyKey: string): BrowserBundleImport {
  return createAttempt(input, idempotencyKey);
}

/** Explicit recovery by operation ID after reload/sign-in; no source bytes or tokens in local storage. */
export async function recoverBrowserBundleImport(input: BrowserBundle, operationId: string,
  options: Pick<ImportOptions, "signal" | "transport"> = {}): Promise<BrowserBundleImport> {
  const frozen: BrowserBundle = { manifest: structuredClone(input.manifest), hashes: { ...input.hashes },
    files: input.files.map(({ path, blob }) => ({ path, blob: new Blob([blob]) })), totalBytes: input.totalBytes };
  const recovered = await readBundleRecovery(frozen, operationId, options.signal, options.transport);
  return createAttempt(frozen, recovered.key, recovered);
}

/** Discovery alone is read-only. The caller must explicitly run the recovered original operation. */
export async function discoverBrowserBundleImport(input: BrowserBundle,
  options: Pick<ImportOptions, "signal" | "transport"> = {}): Promise<{ attempt: BrowserBundleImport; identity: ImportIdentity }> {
  const frozen: BrowserBundle = { manifest: structuredClone(input.manifest), hashes: { ...input.hashes },
    files: input.files.map(({ path, blob }) => ({ path, blob: new Blob([blob]) })), totalBytes: input.totalBytes };
  const recovered = await discoverBundleRecovery(frozen, options.signal, options.transport);
  return { attempt: createAttempt(frozen, recovered.key, recovered), identity: { ...recovered.identity } };
}

function createAttempt(input: BrowserBundle, idempotencyKey: string, recovered?: RecoveredImport): BrowserBundleImport {
  importIdentifier(idempotencyKey);
  // Metadata is copied as well as bytes: later caller edits cannot change an upload slot on resume.
  let bundle: BrowserBundle | undefined = { manifest: structuredClone(input.manifest), hashes: { ...input.hashes },
    files: input.files.map(({ path, blob }) => ({ path, blob: new Blob([blob]) })), totalBytes: input.totalBytes };
  const checkpoint: AttemptCheckpoint = { files: new Map(), ...(recovered ? { recovered } : {}) };
  let inFlight = false; let attempted = recovered !== undefined; let terminal = false; let controller: AbortController | undefined;
  const dispose = () => { controller?.abort(); bundle = undefined; checkpoint.files.clear(); delete checkpoint.prepared; terminal = true; };
  return {
    get canResume() { return attempted && !inFlight && !terminal && bundle !== undefined; },
    dispose,
    async run(options = {}) {
      if (inFlight || terminal || !bundle) throw new ApiRequestError({ status: 409, code: "BUNDLE_IMPORT_NOT_RESUMABLE",
        message: "This upload is active, terminal or cleared. It cannot be continued." });
      checkCancelled(options.signal);
      inFlight = true; attempted = true; controller = new AbortController();
      const abort = () => controller?.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await executeAttempt(bundle, idempotencyKey, checkpoint, { ...options, signal: controller.signal });
        checkCancelled(controller.signal); terminal = true;
        return result;
      } catch (error) {
        if (error instanceof ApiRequestError && ([401, 403].includes(error.status) || error.code === "INGEST_RESPONSE_MISMATCH")) dispose();
        throw error;
      } finally { options.signal?.removeEventListener("abort", abort); inFlight = false; controller = undefined; }
    },
  };
}

/** Backwards-compatible one-shot API. Retain createBrowserBundleImport only for explicit continuation. */
export async function importBrowserBundle(bundle: BrowserBundle, idempotencyKey: string,
  options: ImportOptions = {}): Promise<BundleAdmissionReceipt | null> {
  const attempt = createBrowserBundleImport(bundle, idempotencyKey);
  try { return await attempt.run(options); } finally { attempt.dispose(); }
}

async function executeAttempt(bundle: BrowserBundle, idempotencyKey: string, checkpoint: AttemptCheckpoint,
  options: ImportOptions): Promise<BundleAdmissionReceipt | null> {
  const transport = options.transport ?? requestApi;
  const signal = options.signal;
  importIdentifier(idempotencyKey); checkCancelled(signal);
  let sent = [...checkpoint.files.entries()].reduce((sum, [path, file]) => sum + (file.completed
    ? bundle.files.find((candidate) => candidate.path === path)?.blob.size ?? 0
    : file.parts.reduce((n, part) => n + part.size_bytes, 0)), 0);
  const progress = (phase: string) => options.onProgress?.({ phase, bytes: sent, total: bundle.totalBytes });
  const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  let prepared = checkpoint.prepared;
  if (!prepared && checkpoint.recovered) {
    const recovered = checkpoint.recovered;
    options.onIdentity?.({ ...recovered.identity });
    const observed = await readImportStatus(recovered.identity, signal, transport, recovered.session);
    if (observed.receipt) return observed.receipt;
    if (["REJECTED", "QUARANTINED"].includes(observed.state)) { progress(observed.state); return null; }
  }
  if (prepared) {
    progress("Reconciling durable status before continuation");
    const observed = await readImportStatus(prepared.identity, signal, transport, prepared.session);
    if (observed.receipt) return observed.receipt;
    if (["REJECTED", "QUARANTINED"].includes(observed.state)) { progress(observed.state); return null; }
  } else {
    progress("Preparing upload");
    const prepareRequest = json({ manifest: bundle.manifest, file_hashes: bundle.hashes,
      total_bytes: bundle.totalBytes, idempotency_key: idempotencyKey });
    if (new TextEncoder().encode(String(prepareRequest.body)).byteLength > 256 * 1024) {
      bundleInputError("The prepare request exceeds the HTTP metadata budget.");
    }
    const response = await importCall("/api/v1/ingest/bundles/prepare", prepareRequest, transport);
    prepared = decodePrepared(response.data, bundle, response.generation);
    if (checkpoint.recovered && (prepared.identity.operation !== checkpoint.recovered.identity.operation ||
        prepared.identity.manifestDigest !== checkpoint.recovered.identity.manifestDigest ||
        prepared.identity.sourceRevision !== checkpoint.recovered.identity.sourceRevision ||
        prepared.identity.generation !== checkpoint.recovered.identity.generation ||
        checkpoint.recovered.session !== undefined && prepared.session !== checkpoint.recovered.session)) importMismatch();
    checkpoint.prepared = prepared;
  }
  options.onIdentity?.({ ...prepared.identity });
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
    const saved = checkpoint.files.get(file.path) ?? { parts: [], completed: false };
    checkpoint.files.set(file.path, saved);
    if (saved.completed) continue;
    const parts = saved.parts;
    const complete = async (knownParts: FileCheckpoint["parts"]) => {
      const result = await importCall(`${base}/files/complete`, json({ multipart_session_ref: prepared.session,
        path: file.path, parts: knownParts }), transport, identity.generation);
      const row = importRecord(result.data, ["operation_id", "multipart_session_ref", "path", "sha256", "size_bytes", "etag", "completed_at"]);
      checkBinding(row, file.path);
      if (row.sha256 !== bundle.hashes[file.path] || row.size_bytes !== file.blob.size) importMismatch();
      importOpaque(row.etag); importTime(row.completed_at); saved.completed = true;
    };
    if (checkpoint.recovered && parts.length === 0) {
      // Empty parts can only reopen an already materialized file and repair its lost receipt.
      // The one explicit NOT_COMPLETED result permits re-uploading the same original slots.
      try { await complete([]); sent += file.blob.size; progress("Reconciled existing file"); continue; }
      catch (error) {
        if (!(error instanceof ApiRequestError) || error.code !== "STAGING_FILE_NOT_COMPLETED") throw error;
      }
    }
    const acknowledged = parts.reduce((sum, part) => sum + part.size_bytes, 0);
    // An unacknowledged part is resent only on explicit run(), with the same slot and frozen bytes.
    // A complete-file ACK loss retries completeFile with the same known parts, never uploads to a closed multipart.
    for (let start = acknowledged, number = parts.length + 1; start < file.blob.size; start += upload.maxPart, number += 1) {
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
    await complete(parts);
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
