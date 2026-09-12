import {
  FederationEvidenceBundleSchema,
  FederationJobStatusSchema,
  type FederationEvidenceBundle,
  type FederationJobStatus,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  FEDERATION_ACTIVE_STATES,
  FEDERATION_RESULT_JSON_MAX_BYTES,
  FEDERATION_STATUS_JSON_MAX_BYTES,
  federationAssertDatabase,
  federationCanonicalJson,
  federationCanonicalJsonWithin,
  federationD1Fail,
  federationDigest,
  federationNow,
  federationVersionedRef,
  requireFederationBinding,
  type FederationAuthorityBinding,
  type FederationJobRecord,
} from "./federation-d1-common.js";
import {
  readFederationJob,
  readFederationJobById,
} from "./federation-d1-codec.js";
import {
  federationRuntimeFail,
  federationSha256Bytes,
} from "./federation-runtime-common.js";

const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export interface FederationBundleRangeLike {
  readonly start: number;
  readonly endExclusive: number;
}

export interface FederationBundleAuthorityLike {
  readAuthorizedManifest(
    binding: FederationAuthorityBinding,
    bundleRef: VersionedRef,
  ): Promise<FederationEvidenceBundle | null>;
  readAuthorizedBytes(
    binding: FederationAuthorityBinding,
    bundleRef: VersionedRef,
    range?: FederationBundleRangeLike,
  ): Promise<ReadableStream<Uint8Array> | null>;
}

async function bundleObjectKey(
  jobId: string,
  immutableDigest: string,
): Promise<string> {
  const jobDigest = await federationSha256Bytes(encoder.encode(jobId));
  return `federation/bundles/${jobDigest}/${immutableDigest}.bin`;
}

export async function federationBundleObjectKey(
  bundle: FederationEvidenceBundle,
): Promise<string> {
  const parsed = FederationEvidenceBundleSchema.parse(bundle);
  return bundleObjectKey(parsed.job_id, parsed.immutable_bundle_digest);
}

async function loadAuthorizedBundle(
  database: D1Database,
  binding: FederationAuthorityBinding,
  rawRef: VersionedRef,
): Promise<FederationEvidenceBundle | null> {
  const ref = federationVersionedRef(rawRef, "bundle ref");
  if (ref.revision !== 1) return null;
  const job = await readFederationJobById(database, ref.id);
  if (job === null) return null;
  requireFederationBinding(job.binding, binding);
  if (
    job.record.status.transport_state !== "COMPLETED" ||
    job.record.result === null
  ) {
    return null;
  }
  return job.record.result;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const stable = Uint8Array.from(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(stable);
      controller.close();
    },
  });
}

function validRange(
  range: FederationBundleRangeLike | undefined,
  byteLength: number,
): { readonly start: number; readonly end: number } {
  if (range === undefined) return { start: 0, end: byteLength };
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.endExclusive) ||
    range.start < 0 ||
    range.endExclusive <= range.start ||
    range.endExclusive > byteLength ||
    range.endExclusive - range.start > MAX_BUNDLE_BYTES
  ) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_RANGE_INVALID",
      "federation bundle range is invalid",
    );
  }
  return { start: range.start, end: range.endExclusive };
}

export function createD1R2FederationBundleAuthority(
  database: D1Database,
  bucket: R2Bucket,
): FederationBundleAuthorityLike {
  federationAssertDatabase(database);
  if (
    typeof bucket !== "object" ||
    bucket === null ||
    typeof bucket.get !== "function"
  ) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CONFIG_INVALID",
      "federation R2 binding is invalid",
    );
  }
  return Object.freeze<FederationBundleAuthorityLike>({
    readAuthorizedManifest(binding, bundleRef) {
      return loadAuthorizedBundle(database, binding, bundleRef);
    },
    async readAuthorizedBytes(binding, bundleRef, range) {
      const bundle = await loadAuthorizedBundle(database, binding, bundleRef);
      if (bundle === null) return null;
      const key = await bundleObjectKey(
        bundle.job_id,
        bundle.immutable_bundle_digest,
      );
      let object: R2ObjectBody | null;
      try {
        object = await bucket.get(key);
      } catch (cause) {
        federationRuntimeFail(
          "FEDERATION_BUNDLE_BYTES_MISSING",
          "federation bundle object read failed",
          true,
          cause,
        );
      }
      if (object === null) return null;
      if (object.size > MAX_BUNDLE_BYTES) {
        federationRuntimeFail(
          "FEDERATION_BUNDLE_TOO_LARGE",
          "federation bundle exceeds the bounded read envelope",
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await object.arrayBuffer());
      } catch (cause) {
        federationRuntimeFail(
          "FEDERATION_BUNDLE_BYTES_MISSING",
          "federation bundle object body is unavailable",
          true,
          cause,
        );
      }
      const metadata = object.customMetadata;
      if (
        bytes.byteLength !== object.size ||
        metadata?.protocol !== "eliotr.federation-bundle-bytes.v1" ||
        metadata?.job_id !== bundle.job_id ||
        metadata?.immutable_bundle_digest !==
          bundle.immutable_bundle_digest ||
        await federationSha256Bytes(bytes) !==
          bundle.immutable_bundle_digest
      ) {
        federationRuntimeFail(
          "FEDERATION_BUNDLE_INTEGRITY_MISMATCH",
          "federation bundle bytes do not match the immutable result digest",
        );
      }
      const selected = validRange(range, bytes.byteLength);
      return byteStream(bytes.slice(selected.start, selected.end));
    },
  });
}

export async function putFederationBundleBytes(
  bucket: R2Bucket,
  rawBundle: FederationEvidenceBundle,
  rawBytes: Uint8Array,
): Promise<{ readonly key: string; readonly byte_length: number }> {
  const bundle = FederationEvidenceBundleSchema.parse(rawBundle);
  if (
    !(rawBytes instanceof Uint8Array) ||
    rawBytes.byteLength > MAX_BUNDLE_BYTES
  ) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_TOO_LARGE",
      "federation bundle bytes exceed the bounded write envelope",
    );
  }
  const bytes = Uint8Array.from(rawBytes);
  if (
    await federationSha256Bytes(bytes) !== bundle.immutable_bundle_digest
  ) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_INTEGRITY_MISMATCH",
      "federation bundle write digest does not match the result manifest",
    );
  }
  const key = await bundleObjectKey(
    bundle.job_id,
    bundle.immutable_bundle_digest,
  );
  let prior: R2ObjectBody | null;
  try {
    prior = await bucket.get(key);
  } catch (cause) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_BYTES_MISSING",
      "federation bundle preflight read failed",
      true,
      cause,
    );
  }
  if (prior === null) {
    try {
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: "application/octet-stream" },
        customMetadata: {
          protocol: "eliotr.federation-bundle-bytes.v1",
          job_id: bundle.job_id,
          immutable_bundle_digest: bundle.immutable_bundle_digest,
        },
      });
    } catch {
      // A lost acknowledgement is resolved by exact readback below.
    }
  }
  let readback: R2ObjectBody | null;
  try {
    readback = await bucket.get(key);
  } catch (cause) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_BYTES_MISSING",
      "federation bundle write lacks authoritative readback",
      true,
      cause,
    );
  }
  if (readback === null || readback.size !== bytes.byteLength) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_BYTES_MISSING",
      "federation bundle write lacks authoritative readback",
      true,
    );
  }
  const readbackBytes = new Uint8Array(await readback.arrayBuffer());
  const readbackMetadata = readback.customMetadata;
  if (
    readbackBytes.byteLength !== bytes.byteLength ||
    readbackMetadata?.protocol !== "eliotr.federation-bundle-bytes.v1" ||
    readbackMetadata?.job_id !== bundle.job_id ||
    readbackMetadata?.immutable_bundle_digest !==
      bundle.immutable_bundle_digest ||
    await federationSha256Bytes(readbackBytes) !==
      bundle.immutable_bundle_digest
  ) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_INTEGRITY_MISMATCH",
      "federation bundle readback differs from the immutable bytes",
    );
  }
  return { key, byte_length: bytes.byteLength };
}

function completionStatus(
  current: FederationJobStatus,
  bundle: FederationEvidenceBundle,
  terminalReceiptRef: string,
): FederationJobStatus {
  return FederationJobStatusSchema.parse({
    ...current,
    transport_state: "COMPLETED",
    completion_disposition: bundle.completion_disposition,
    terminal_receipt_ref: terminalReceiptRef,
  });
}

function sameBundle(
  left: FederationEvidenceBundle | null,
  right: FederationEvidenceBundle,
): boolean {
  return left !== null &&
    federationCanonicalJson(left) === federationCanonicalJson(right);
}

export async function completeD1FederationJob(
  database: D1Database,
  bucket: R2Bucket,
  binding: FederationAuthorityBinding,
  exchangeId: string,
  idempotencyKey: string,
  rawBundle: FederationEvidenceBundle,
  clock: () => number = Date.now,
): Promise<FederationJobRecord> {
  federationAssertDatabase(database);
  const bundle = FederationEvidenceBundleSchema.parse(rawBundle);
  const bundleKey = await bundleObjectKey(
    bundle.job_id,
    bundle.immutable_bundle_digest,
  );
  let durableObject: R2ObjectBody | null;
  try {
    durableObject = await bucket.get(bundleKey);
  } catch (cause) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_BYTES_MISSING",
      "federation completion could not read immutable bundle bytes",
      true,
      cause,
    );
  }
  if (durableObject === null || durableObject.size > MAX_BUNDLE_BYTES) {
    federationRuntimeFail(
      durableObject === null
        ? "FEDERATION_BUNDLE_BYTES_MISSING"
        : "FEDERATION_BUNDLE_TOO_LARGE",
      "federation completion requires bounded immutable bundle bytes",
    );
  }
  const durableBytes = new Uint8Array(await durableObject.arrayBuffer());
  const durableMetadata = durableObject.customMetadata;
  if (
    durableBytes.byteLength !== durableObject.size ||
    durableMetadata?.protocol !== "eliotr.federation-bundle-bytes.v1" ||
    durableMetadata?.job_id !== bundle.job_id ||
    durableMetadata?.immutable_bundle_digest !==
      bundle.immutable_bundle_digest ||
    await federationSha256Bytes(durableBytes) !==
      bundle.immutable_bundle_digest
  ) {
    federationRuntimeFail(
      "FEDERATION_BUNDLE_INTEGRITY_MISMATCH",
      "federation completion bundle bytes failed exact readback",
    );
  }
  const existing = await readFederationJob(
    database,
    exchangeId,
    idempotencyKey,
  );
  if (existing === null) {
    federationD1Fail(
      "FEDERATION_D1_STATE_CONFLICT",
      "federation completion target does not exist",
    );
  }
  requireFederationBinding(existing.binding, binding);
  if (
    bundle.exchange_id !== existing.request.exchange_id ||
    bundle.job_id !== existing.record.status.job_id ||
    bundle.request_digest !== existing.record.request_digest ||
    bundle.coverage_receipt.terminal_disposition !==
      bundle.completion_disposition
  ) {
    federationD1Fail(
      "FEDERATION_D1_BINDING_MISMATCH",
      "federation result does not belong to the durable job",
    );
  }
  if (existing.record.status.transport_state === "COMPLETED") {
    if (!sameBundle(existing.record.result, bundle)) {
      federationD1Fail(
        "FEDERATION_D1_STATE_CONFLICT",
        "federation job is already completed with another result",
      );
    }
    return existing.record;
  }
  if (!FEDERATION_ACTIVE_STATES.has(
    existing.record.status.transport_state as
      "ACCEPTED" | "RUNNING" | "PARTIAL" | "BLOCKED",
  )) {
    federationD1Fail(
      "FEDERATION_D1_STATE_CONFLICT",
      "federation job cannot be completed from its current state",
    );
  }

  const terminalDigest = await federationDigest({
    protocol: "eliotr.federation-terminal-receipt.v1",
    job_id: bundle.job_id,
    immutable_bundle_digest: bundle.immutable_bundle_digest,
    completion_disposition: bundle.completion_disposition,
  });
  const terminalReceiptRef =
    `federation-terminal-${terminalDigest.slice(0, 48)}`;
  const status = completionStatus(
    existing.record.status,
    bundle,
    terminalReceiptRef,
  );
  const statusJson = federationCanonicalJsonWithin(
    status,
    FEDERATION_STATUS_JSON_MAX_BYTES,
    "federation completion status",
  );
  const resultJson = federationCanonicalJsonWithin(
    bundle,
    FEDERATION_RESULT_JSON_MAX_BYTES,
    "federation completion result",
  );
  const previousStatusJson = federationCanonicalJsonWithin(
    existing.record.status,
    FEDERATION_STATUS_JSON_MAX_BYTES,
    "stored federation status",
  );
  const previousUpdatedAt = existing.updatedAt;
  const observed = federationNow(() =>
    Math.max(clock(), Date.parse(previousUpdatedAt) + 1)
  );

  let mutationError: unknown;
  try {
    const mutation = await database.prepare(
      "UPDATE federation_job SET transport_state='COMPLETED', " +
      "status_json=?1, observed_completion_disposition=?2, " +
      "result_json=?3, updated_at=?4 WHERE job_id=?5 " +
      "AND status_json=?6 AND updated_at=?7 AND transport_state " +
      "IN ('ACCEPTED','RUNNING','PARTIAL','BLOCKED')",
    ).bind(
      statusJson,
      bundle.completion_disposition,
      resultJson,
      observed.iso,
      bundle.job_id,
      previousStatusJson,
      previousUpdatedAt,
    ).run();
    const changes = mutation.meta?.changes;
    if (typeof changes !== "number" || changes !== 1) {
      mutationError = new Error(
        "federation completion CAS changed no row",
      );
    }
  } catch (cause) {
    mutationError = cause;
  }

  const readback = await readFederationJob(
    database,
    exchangeId,
    idempotencyKey,
  );
  if (
    readback !== null &&
    readback.record.status.transport_state === "COMPLETED" &&
    sameBundle(readback.record.result, bundle)
  ) {
    requireFederationBinding(readback.binding, binding);
    return readback.record;
  }
  if (
    readback !== null &&
    readback.record.status.transport_state === "COMPLETED"
  ) {
    federationD1Fail(
      "FEDERATION_D1_STATE_CONFLICT",
      "federation completion raced with another result",
    );
  }
  federationD1Fail(
    "FEDERATION_D1_SETTLEMENT_UNCERTAIN",
    "federation completion lacks exact durable readback",
    true,
    mutationError,
  );
}
