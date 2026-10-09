// C2-I owner-client move of packages/pwa-source-workspace/src/bundle-import.ts.
// Attempt, checkpoint and upload implementation moves here verbatim; only the transport, byte
// and error seams are injected. No new endpoint, bound, identity or retry rule is introduced.
import type { BundleAdmissionReceipt } from "@eliotr/contracts";
import type { BrowserBundle } from "./bundle-input.js";
import { createBundleRecoveryApi, type RecoveredImport } from "./bundle-recovery.js";
import { type BundleWireApi, type ImportIdentity,
  type PreparedImport } from "./bundle-wire.js";
import type { LegacyErrorFactory } from "../../legacy/http.js";
import type { EpochPort } from "../../transport/client.js";

export interface ImportProgress {
  readonly phase: string;
  readonly bytes: number;
  readonly total: number;
}

export interface ImportOptions {
  readonly signal?: AbortSignal;
    readonly onIdentity?: (identity: ImportIdentity) => void;
  readonly onProgress?: (progress: ImportProgress) => void;
}

export interface BrowserBundleImport {
  readonly canResume: boolean;
  run(options?: ImportOptions): Promise<BundleAdmissionReceipt | null>;
  dispose(): void;
}

export type BundleImportErrors = LegacyErrorFactory;

export interface BundleImportApi {
  readonly createBrowserBundleImport: (input: BrowserBundle, idempotencyKey: string)
    => BrowserBundleImport;
  readonly recoverBrowserBundleImport: (input: BrowserBundle, operationId: string,
    options?: Pick<ImportOptions, "signal">) => Promise<BrowserBundleImport>;
  readonly discoverBrowserBundleImport: (input: BrowserBundle,
    options?: Pick<ImportOptions, "signal">)
    => Promise<{ attempt: BrowserBundleImport; identity: ImportIdentity }>;
}

interface FileCheckpoint {
  readonly parts: { part_number: number; size_bytes: number; etag: string }[];
  completed: boolean;
}
interface AttemptCheckpoint {
  prepared?: PreparedImport;
  readonly files: Map<string, FileCheckpoint>;
  readonly recovered?: RecoveredImport;
}

export function createBundleImportApi(wire: BundleWireApi, errors: BundleImportErrors,
  epoch: EpochPort, clock: {readonly now: () => number},
  isRequestError: (value: unknown) => value is Error & {readonly code: string; readonly status: number}): BundleImportApi {
  const fail: (status: number, code: string, message: string) => never = (status, code, message) => {
    throw errors({ status, code, message, traceId: null, retryable: false });
  };
  const recovery = createBundleRecoveryApi(wire, errors, clock);
  const mismatch: () => never = wire.mismatch;
  const capture = (): object => {const stamp=epoch.capture();if(!stamp||!epoch.isCurrent(stamp))fail(503,'API_SESSION_CLOSED','Owner session is closed');return stamp;};
  const assertEpoch = (stamp: object): void => {if(!epoch.isCurrent(stamp))fail(503,'API_SESSION_CLOSED','Owner session is closed');};
  const checkCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
      fail(499, "BUNDLE_IMPORT_CANCELLED",
        "Import stopped. Already sent operations may have completed; inspect durable status.");
    }
  };
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) {
      fail(400, "BUNDLE_INPUT_INVALID", "The import operation identity is invalid.");
    }
    return value;
  };
  const opaque = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        new TextEncoder().encode(value).byteLength > 1024) mismatch();
    return value;
  };
  const record = (value: unknown, required: readonly string[],
    optional: readonly string[] = []): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        required.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) {
      mismatch();
    }
    return value as Record<string, unknown>;
  };
  const checkBinding = (row: Record<string, unknown>, identity: ImportIdentity,
    session: string | undefined, path: string): void => {
    if (row.operation_id !== identity.operation ||
        row.multipart_session_ref !== session || row.path !== path) mismatch();
  };

  const createAttempt = (input: BrowserBundle, idempotencyKey: string,
    recovered?: RecoveredImport): BrowserBundleImport => {
    const stamp = capture();
    identifier(idempotencyKey);
    const bundle: BrowserBundle = {
      manifest: input.manifest,
      files: input.files,
      hashes: input.hashes,
      totalBytes: input.totalBytes,
    };
    const checkpoint: AttemptCheckpoint = { files: new Map(),
      ...(recovered ? { recovered } : {}) };
    let inFlight = false;
    let attempted = recovered !== undefined;
    let terminal = false;
    let controller: AbortController | undefined;
    const dispose = (): void => {
      controller?.abort();
      checkpoint.files.clear();
      delete checkpoint.prepared;
      terminal = true;
    };
    return {
      get canResume(): boolean {
        return epoch.isCurrent(stamp) && attempted && !inFlight && !terminal;
      },
      dispose,
      async run(options = {}): Promise<BundleAdmissionReceipt | null> {
        assertEpoch(stamp);
        if (inFlight || terminal) {
          fail(409, "BUNDLE_IMPORT_NOT_RESUMABLE",
            "This upload is active, terminal or cleared. It cannot be continued.");
        }
        checkCancelled(options.signal);
        inFlight = true;
        attempted = true;
        controller = new AbortController();
        const abort = (): void => controller?.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
          const result = await executeAttempt(bundle, idempotencyKey, checkpoint,
            { ...options, signal: controller.signal }, () => {assertEpoch(stamp);checkCancelled(controller?.signal);if(terminal)fail(503,"API_SESSION_CLOSED","Import was disposed");}, wire);
          assertEpoch(stamp);
          checkCancelled(controller.signal);
          terminal = true;
          return result;
        } catch (error) {
          const status = isRequestError(error) ? error.status : undefined;
          const code = isRequestError(error) ? error.code : undefined;
          if (status === 401 || status === 403 || code === "INGEST_RESPONSE_MISMATCH") {
            dispose();
          }
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", abort);
          inFlight = false;
          controller = undefined;
        }
      },
    };
  };

  async function executeAttempt(bundle: BrowserBundle, idempotencyKey: string,
    checkpoint: AttemptCheckpoint, options: ImportOptions, assertAttempt: () => void, parentWire: BundleWireApi): Promise<BundleAdmissionReceipt | null> {
    assertAttempt();
    const guarded = async <T>(promise: Promise<T>): Promise<T> => {const result=await promise;assertAttempt();return result;};
    const wire: BundleWireApi = {...parentWire, importCall(...args){assertAttempt();return guarded(parentWire.importCall(...args));},importBytesCall(...args){assertAttempt();return guarded(parentWire.importBytesCall(...args));}};

    const signal = options.signal;
    identifier(idempotencyKey);
    checkCancelled(signal);
    let sent = [...checkpoint.files.entries()].reduce((sum, [filePath, file]) =>
      sum + (file.completed
        ? bundle.files.find((candidate) => candidate.path === filePath)?.bytes.byteLength ?? 0
        : file.parts.reduce((total, part) => total + part.size_bytes, 0)), 0);
    const progress = (phase: string): void =>
      options.onProgress?.({ phase, bytes: sent, total: bundle.totalBytes });
    const json = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const checkBound = (row: Record<string, unknown>, identity: ImportIdentity,
      session: string | undefined, filePath: string): void => {
      checkBinding(row, identity, session, filePath);
    };
    let prepared = checkpoint.prepared;
    if (!prepared && checkpoint.recovered) {
      const recovered = checkpoint.recovered;
      options.onIdentity?.({ ...recovered.identity });
      const observed = wire.decodeImportStatus(
        await readStatus(wire, recovered.identity, signal, recovered.session),
        recovered.identity, recovered.session);
      if (observed.receipt) return observed.receipt;
      if (["REJECTED", "QUARANTINED"].includes(observed.state)) {
        progress(observed.state);
        return null;
      }
    }
    if (prepared) {
      progress("Reconciling durable status before continuation");
      const observed = wire.decodeImportStatus(
        await readStatus(wire, prepared.identity, signal, prepared.session),
        prepared.identity, prepared.session);
      if (observed.receipt) return observed.receipt;
      if (["REJECTED", "QUARANTINED"].includes(observed.state)) {
        progress(observed.state);
        return null;
      }
    } else {
      progress("Preparing upload");
      const prepareRequest = json({ manifest: bundle.manifest,
        file_hashes: bundle.hashes, total_bytes: bundle.totalBytes,
        idempotency_key: idempotencyKey });
      if (new TextEncoder().encode(String(prepareRequest.body)).byteLength > 256 * 1024) {
        fail(400, "BUNDLE_INPUT_INVALID",
          "The prepare request exceeds the HTTP metadata budget.");
      }
      const response = await wire.importCall(
        "/api/v1/ingest/bundles/prepare", prepareRequest);
      prepared = wire.decodePrepared(response.data, bundle.manifest,
        bundle.manifest.origin.source_revision_ref, bundle.files.length,
        bundle.hashes, response.generation);
      if (checkpoint.recovered && (prepared.identity.operation !==
          checkpoint.recovered.identity.operation ||
          prepared.identity.manifestDigest !== checkpoint.recovered.identity.manifestDigest ||
          prepared.identity.sourceRevision !== checkpoint.recovered.identity.sourceRevision ||
          prepared.identity.generation !== checkpoint.recovered.identity.generation ||
          (checkpoint.recovered.session !== undefined &&
            prepared.session !== checkpoint.recovered.session))) {
        mismatch();
      }
      checkpoint.prepared = prepared;
    }
    options.onIdentity?.({ ...prepared.identity });
    const identity = prepared.identity;
    if (prepared.existing) {
      const observed = wire.decodeImportStatus(await readStatus(wire, identity, signal),
        identity);
      if (!observed.receipt ||
          JSON.stringify(observed.receipt) !== JSON.stringify(prepared.existing)) {
        mismatch();
      }
      return prepared.existing;
    }
    if (prepared.rejected) {
      progress(`Rejected: ${prepared.reasons.join(", ")}`);
      return null;
    }
    const current = (): void => {
      checkCancelled(signal);
      if (clock.now() >= (prepared as PreparedImport).expiry) mismatch();
    };
    const base = `/api/v1/ingest/bundles/${encodeURIComponent(identity.operation)}`;
    for (const upload of prepared.files) {
      current();
      const file = bundle.files.find((candidate) => candidate.path === upload.path);
      if (!file) mismatch();
      const saved = checkpoint.files.get(file.path) ?? { parts: [], completed: false };
      checkpoint.files.set(file.path, saved);
      if (saved.completed) continue;
      const parts = saved.parts;
      const complete = async (knownParts: FileCheckpoint["parts"]): Promise<void> => {
        const result = await wire.importCall(`${base}/files/complete`,
          json({ multipart_session_ref: prepared?.session, path: file.path,
            parts: knownParts }), identity.generation);
        const row = record(result.data, ["operation_id", "multipart_session_ref",
          "path", "sha256", "size_bytes", "etag", "completed_at"]);
        checkBound(row, identity, prepared?.session, file.path);
        if (row.sha256 !== bundle.hashes[file.path] ||
            row.size_bytes !== file.bytes.byteLength) mismatch();
        opaque(row.etag);
        saved.completed = true;
      };
      if (checkpoint.recovered && parts.length === 0) {
        try {
          await complete([]);
          sent += file.bytes.byteLength;
          progress("Reconciled existing file");
          continue;
        } catch (error) {
          const code = isRequestError(error) ? error.code : undefined;
          if (code !== "STAGING_FILE_NOT_COMPLETED") throw error;
        }
      }
      const acknowledged = parts.reduce((sum, part) => sum + part.size_bytes, 0);
      for (let start = acknowledged, number = parts.length + 1;
        start < file.bytes.byteLength; start += upload.maxPart, number += 1) {
        current();
        const part = file.bytes.subarray(start, start + upload.maxPart);
        const query = new URLSearchParams({
          multipart_session_ref: prepared?.session ?? "",
          path: file.path,
          size_bytes: String(part.byteLength),
          final_part: start + part.byteLength === file.bytes.byteLength ? "1" : "0",
        }).toString();
        const result = await wire.importBytesCall(`${base}/parts/${number}?${query}`,
          { method: "PUT", bytes: part, maximumBytes:upload.maxPart, contentType:"application/octet-stream",
            ...(signal ? { signal } : {}) }, identity.generation);
        const row = record(result.data, ["operation_id", "multipart_session_ref",
          "path", "part_number", "size_bytes", "etag"]);
        checkBound(row, identity, prepared?.session, file.path);
        if (row.part_number !== number || row.size_bytes !== part.byteLength) {
          mismatch();
        }
        parts.push({ part_number: number, size_bytes: part.byteLength,
          etag: opaque(row.etag) });
        sent += part.byteLength;
        progress("Uploading verified bytes");
      }
      current();
      await complete(parts);
    }
    current();
    progress("Checking admission and canonical readback");
    const committed = await wire.importCall(
      "/api/v1/ingest/bundles/commit", json({ operation_id: identity.operation,
        multipart_session_ref: prepared?.session,
        manifest_sha256: identity.manifestDigest }),
      identity.generation);
    const receipt = wire.receiptFor(committed.data, identity);
    progress("Reading durable status");
    const status = wire.decodeImportStatus(await readStatus(wire, identity, signal),
      identity);
    if (!status.receipt ||
        JSON.stringify(status.receipt) !== JSON.stringify(receipt)) mismatch();
    progress(receipt.decision === "ADMITTED" || receipt.decision === "DUPLICATE"
      ? "Admitted; search index readiness is separate"
      : `${receipt.decision}; no admitted source`);
    return receipt;
  }

  const readStatus = async (wire: BundleWireApi, identity: ImportIdentity, signal?: AbortSignal,
    _session?: string): Promise<unknown> => {
    const result = await wire.importCall(
      `/api/v1/ingest/bundles/${encodeURIComponent(identity.operation)}`,
      { ...(signal ? { signal } : {}) });
    return result.data;
  };

  return {
    createBrowserBundleImport: (input, idempotencyKey) =>
      createAttempt(input, idempotencyKey),
    recoverBrowserBundleImport: async (input, operationId, options = {}) => {
      const stamp = capture();
      const recovered = await recovery.readBundleRecovery(input, operationId,
        options.signal);
      assertEpoch(stamp);
      return createAttempt(input, recovered.key, recovered);
    },
    discoverBrowserBundleImport: async (input, options = {}) => {
      const stamp = capture();
      const recovered = await recovery.discoverBundleRecovery(input, options.signal);
      assertEpoch(stamp);
      const attempt = createAttempt(input, recovered.key, recovered);
      return { attempt, identity: { ...recovered.identity } };
    },
  };
}
