import {
  canonicalNormalizedBundleKey,
  objectResidencyKeyDigest,
  sha256Utf8,
  type EvidenceObjectStore,
  type Sha256DigestSinkFactory,
} from "./r2.js";
import {
  promotionKey,
  readPromotionReceipt,
} from "./ingest-state.js";
import {
  assertStagingObject,
  writeImmutableJsonCandidate,
} from "./ingest-storage.js";
import type {
  BundlePromotionReceipt,
  InternalStagedBundleSession,
  PromotedObjectReceipt,
} from "./ingest-types.js";
import { verifyStagedBundle } from "./ingest-verification.js";
import {
  PROMOTION_PROTOCOL,
  canonicalJson,
  contentType,
  fail,
  iso,
} from "./ingest-validation.js";

const MAX_TERMINAL_DOCUMENT_BYTES = 1024 * 1024;

function stablePayload(receipt: BundlePromotionReceipt): unknown {
  return {
    protocol: receipt.protocol,
    session_id: receipt.session_id,
    admission_receipt_ref: receipt.admission_receipt_ref,
    canonical_manifest_ref: receipt.canonical_manifest_ref,
    promoted_objects: receipt.promoted_objects.map((entry) => ({
      logical_path: entry.logical_path,
      canonical_key: entry.canonical_key,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
    })),
  };
}

export async function promoteStagedSession(input: {
  readonly work_bucket: R2Bucket;
  readonly evidence_store: EvidenceObjectStore;
  readonly session: InternalStagedBundleSession;
  readonly admission_receipt_ref: string;
  readonly now: () => number;
  readonly create_sha256_sink?: Sha256DigestSinkFactory;
}): Promise<BundlePromotionReceipt> {
  const verification = await verifyStagedBundle({
    bucket: input.work_bucket,
    session: input.session,
    ...(input.create_sha256_sink === undefined
      ? {}
      : { create_sha256_sink: input.create_sha256_sink }),
  });
  if (!verification.verified) {
    fail(
      "PROMOTION_INTEGRITY_FAILURE",
      `bundle cannot be promoted: ${verification.reason_codes.join(",")}`,
    );
  }

  const identity = {
    owner_system_id: input.session.manifest.origin.owner_system_id,
    source_namespace_id: input.session.manifest.origin.source_namespace_id,
    source_owner_generation: input.session.manifest.origin.source_owner_generation,
    source_logical_id: input.session.manifest.source.logical_id,
    source_revision_ref: input.session.manifest.origin.source_revision_ref,
  };
  const promoted: PromotedObjectReceipt[] = [];

  for (const upload of input.session.uploads) {
    const object = await input.work_bucket.get(upload.staging_key);
    const expectedSize = verification.sizes[upload.path];
    if (object === null || expectedSize === undefined) {
      fail(
        "PROMOTION_INTEGRITY_FAILURE",
        `staging file ${upload.path} disappeared during promotion`,
        true,
      );
    }
    await assertStagingObject(object, input.session, upload, expectedSize);
    const residencyDigest = await objectResidencyKeyDigest({
      ...input.session.residency_key,
      content_digest: { algorithm: "sha256", digest: upload.expected_sha256 },
    });
    const key = await canonicalNormalizedBundleKey(residencyDigest, identity, upload.path);
    const receipt = await input.evidence_store.putImmutable({
      key,
      body: object.body,
      expected_sha256: upload.expected_sha256,
      expected_size_bytes: expectedSize,
      content_type: contentType(upload.path),
      custom_metadata: {
        admission_receipt_ref: input.admission_receipt_ref,
        source_namespace_id: input.session.manifest.origin.source_namespace_id,
        source_owner_generation: input.session.manifest.origin.source_owner_generation,
      },
    });
    promoted.push({
      logical_path: upload.path,
      canonical_key: receipt.key,
      sha256: receipt.readback_sha256,
      size_bytes: receipt.size_bytes,
      etag: receipt.etag,
      existed_identically: receipt.existed_identically,
    });
  }

  promoted.sort((left, right) => left.logical_path.localeCompare(right.logical_path));
  const canonicalManifestRef = promoted.find((entry) =>
    entry.logical_path === "manifest.json")?.canonical_key;
  if (canonicalManifestRef === undefined) {
    fail("PROMOTION_INTEGRITY_FAILURE", "promoted bundle has no canonical manifest");
  }
  const provisional: BundlePromotionReceipt = {
    protocol: PROMOTION_PROTOCOL,
    session_id: input.session.session_id,
    admission_receipt_ref: input.admission_receipt_ref,
    canonical_manifest_ref: canonicalManifestRef,
    readback_digest: "0".repeat(64),
    promoted_objects: promoted,
    promoted_at: iso(input.now()),
  };
  const candidate: BundlePromotionReceipt = {
    ...provisional,
    readback_digest: await sha256Utf8(canonicalJson(stablePayload(provisional))),
  };
  await writeImmutableJsonCandidate(
    input.work_bucket,
    promotionKey(input.session.session_id),
    candidate,
    MAX_TERMINAL_DOCUMENT_BYTES,
  );
  const winner = await readPromotionReceipt(
    input.work_bucket,
    input.session.session_id,
    input.admission_receipt_ref,
    input.session,
  );
  if (winner === null) {
    fail("STAGING_STATE_CONFLICT", "promotion receipt is missing after immutable publication", true);
  }
  return winner;
}
