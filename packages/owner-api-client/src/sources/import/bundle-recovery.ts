// C2-I owner-client move of packages/pwa-source-workspace/src/bundle-recovery-api.ts.
// Recovery and discovery implementation moves here verbatim; only the wire and error seams
// are injected. No new endpoint, protocol or identity rule is introduced.
import type { LegacyErrorFactory } from "../../legacy/http.js";
import type { BrowserBundle } from "./bundle-input.js";
import type { BundleWireApi, ImportIdentity } from "./bundle-wire.js";

export interface RecoveredImport {
  readonly identity: ImportIdentity;
  readonly key: string;
  readonly session?: string;
}

export type BundleRecoveryErrors = LegacyErrorFactory;

export interface BundleRecoveryApi {
  readonly readBundleRecovery: (bundle: BrowserBundle, operationId: string,
    signal?: AbortSignal) => Promise<RecoveredImport>;
  readonly discoverBundleRecovery: (bundle: BrowserBundle,
    signal?: AbortSignal) => Promise<RecoveredImport>;
}

export function createBundleRecoveryApi(wire: BundleWireApi, errors: BundleRecoveryErrors, clock: {readonly now: () => number}):
  BundleRecoveryApi {
  const fail = (status: number, code: string, message: string, retryable = false): never => {
    throw errors({ status, code, message, traceId: null, retryable });
  };
  const identifier = (value: unknown): string => {
    if (typeof value !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) wire.mismatch();
    return value;
  };
  const opaque = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        new TextEncoder().encode(value).byteLength > 1024) wire.mismatch();
    return value;
  };
  const sha256 = (value: unknown): string => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) wire.mismatch();
    return value;
  };
  const path = (value: unknown): string => {
    if (typeof value !== "string" || value.length > 512 ||
        !value.split("/").every((part) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(part))) wire.mismatch();
    return value;
  };

  const decodeRecovery = (bundle: BrowserBundle,
    response: { data: unknown; generation: string },
    expectedOperation?: string): RecoveredImport => {
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      wire.mismatch();
    }
    const row = response.data as Record<string, unknown>;
    const expected = ["protocol", "status", "idempotency_key", "manifest_sha256",
      "total_bytes", "file_hashes"];
    if (expected.some((key) => !Object.hasOwn(row, key)) ||
        Object.keys(row).some((key) => !expected.includes(key))) wire.mismatch();
    if (row.protocol !== "eliotr.ingest-recovery.v1") wire.mismatch();
    const status = row.status as Record<string, unknown>;
    const operationId = identifier(status.operation_id);
    if (expectedOperation !== undefined && operationId !== expectedOperation) wire.mismatch();
    const identity: ImportIdentity = {
      operation: operationId,
      manifestDigest: sha256(row.manifest_sha256),
      sourceRevision: bundle.manifest.origin.source_revision_ref,
      generation: response.generation,
    };
    const decoded = wire.decodeImportStatus(status, identity);
    const hashes = row.file_hashes as Record<string, unknown>;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes) ||
        Object.keys(hashes).length !== bundle.files.length) wire.mismatch();
    if (row.total_bytes !== bundle.totalBytes ||
        Object.entries(hashes).some(([entry, value]) =>
          path(entry) !== entry || sha256(value) !== bundle.hashes[entry])) {
      fail(409, "BUNDLE_RECOVERY_FILES_CHANGED",
        "Reselect the exact original folder. Its bytes differ from the saved server reservation; nothing was uploaded.");
    }
    if (decoded.receipt === undefined && Date.parse(String(status.expires_at)) <= clock.now()) {
      fail(410, "BUNDLE_RECOVERY_EXPIRED",
        "The original upload expired. It cannot be continued or silently replaced.");
    }
    return { identity, key: opaque(row.idempotency_key),
      ...(status.staging_session_ref === undefined ? {} :
        { session: identifier(status.staging_session_ref) }) };
  };

  return {
    readBundleRecovery: async (bundle, operationId, signal) => {
      identifier(operationId);
      const response = await wire.importCall(
        `/api/v1/ingest/bundles/${encodeURIComponent(operationId)}/recovery`,
        { method: "GET", ...(signal ? { signal } : {}) });
      return decodeRecovery(bundle, response, operationId);
    },
    discoverBundleRecovery: async (bundle, signal) => {
      const body = JSON.stringify({ manifest: bundle.manifest,
        file_hashes: bundle.hashes, total_bytes: bundle.totalBytes });
      if (new TextEncoder().encode(body).byteLength > 256 * 1024) {
        fail(400, "BUNDLE_INPUT_INVALID", "The discovery request exceeds the HTTP metadata budget.");
      }
      const response = await wire.importCall("/api/v1/ingest/bundles/discover",
        { method: "POST", headers: { "content-type": "application/json" }, body,
          ...(signal ? { signal } : {}) });
      return decodeRecovery(bundle, response);
    },
  };
}
