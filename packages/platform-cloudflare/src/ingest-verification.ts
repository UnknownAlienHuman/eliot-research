import { NormalizedBundleManifestSchema } from "@eliotr/contracts";
import { hashReadableStream, type Sha256DigestSinkFactory } from "./r2.js";
import {
  readCompletionReceipt,
  readText,
} from "./ingest-state.js";
import { assertStagingObject } from "./ingest-storage.js";
import type {
  InternalStagedBundleSession,
  StagedBundleVerification,
} from "./ingest-types.js";
import {
  canonicalJson,
  parseHashesDocument,
} from "./ingest-validation.js";

const MAX_HASHES_DOCUMENT_BYTES = 1024 * 1024;
const MAX_MANIFEST_DOCUMENT_BYTES = 512 * 1024;

export async function verifyStagedBundle(input: {
  readonly bucket: R2Bucket;
  readonly session: InternalStagedBundleSession;
  readonly create_sha256_sink?: Sha256DigestSinkFactory;
}): Promise<StagedBundleVerification> {
  const { bucket, session } = input;
  const hashes: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  const reasons: string[] = [];
  let total = 0;

  for (const upload of session.uploads) {
    let completed;
    try {
      completed = await readCompletionReceipt(bucket, session, upload.path);
    } catch {
      reasons.push(`FILE_COMPLETION_RECEIPT_INVALID:${upload.path}`);
      continue;
    }
    if (completed === null) {
      reasons.push(`FILE_NOT_COMPLETED:${upload.path}`);
      continue;
    }
    const object = await bucket.get(upload.staging_key);
    if (object === null) {
      reasons.push(`FILE_MISSING:${upload.path}`);
      continue;
    }
    if (object.etag !== completed.etag) {
      reasons.push(`FILE_ETAG_MISMATCH:${upload.path}`);
      continue;
    }
    try {
      await assertStagingObject(object, session, upload, completed.size_bytes);
      const hash = await hashReadableStream(
        object.body,
        completed.size_bytes,
        input.create_sha256_sink,
      );
      if (hash.sha256 !== upload.expected_sha256 || hash.size_bytes !== completed.size_bytes) {
        reasons.push(`FILE_INTEGRITY_MISMATCH:${upload.path}`);
        continue;
      }
      hashes[upload.path] = hash.sha256;
      sizes[upload.path] = hash.size_bytes;
      total += hash.size_bytes;
    } catch {
      reasons.push(`FILE_READBACK_FAILED:${upload.path}`);
    }
  }

  if (total !== session.total_bytes) reasons.push("TOTAL_SIZE_MISMATCH");
  const manifestUpload = session.uploads.find((upload) => upload.path === "manifest.json");
  const hashesUpload = session.uploads.find((upload) => upload.path === "hashes.sha256");

  if (manifestUpload !== undefined && hashes["manifest.json"] !== undefined) {
    const text = await readText(bucket, manifestUpload.staging_key, MAX_MANIFEST_DOCUMENT_BYTES);
    try {
      const parsed = NormalizedBundleManifestSchema.parse(JSON.parse(text ?? ""));
      if (canonicalJson(parsed) !== canonicalJson(session.manifest)) {
        reasons.push("MANIFEST_SEMANTIC_MISMATCH");
      }
    } catch {
      reasons.push("MANIFEST_INVALID");
    }
  }

  if (hashesUpload !== undefined && hashes["hashes.sha256"] !== undefined) {
    const text = await readText(bucket, hashesUpload.staging_key, MAX_HASHES_DOCUMENT_BYTES);
    try {
      const listed = parseHashesDocument(text ?? "");
      const expected = new Map(
        session.file_hashes
          .filter((entry) => entry.path !== "hashes.sha256")
          .map((entry) => [entry.path, entry.sha256]),
      );
      if (
        listed.size !== expected.size ||
        [...expected].some(([path, digest]) => listed.get(path) !== digest)
      ) {
        reasons.push("HASHES_DOCUMENT_MISMATCH");
      }
    } catch {
      reasons.push("HASHES_DOCUMENT_INVALID");
    }
  }

  return {
    verified: reasons.length === 0,
    hashes,
    sizes,
    total_bytes: total,
    reason_codes: [...new Set(reasons)].sort(),
  };
}
