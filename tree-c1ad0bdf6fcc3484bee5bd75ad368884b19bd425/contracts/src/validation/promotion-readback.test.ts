import { describe, expect, it } from "vitest";
import type { BundleAdmissionReceipt } from "../normalized-bundle.js";
import {
  PromotionReadbackError,
  validateBundleReceiptStructure,
  validatePromotionStructure,
  type PromotionReadbackOperationView,
  type PromotionReceiptView,
} from "./promotion-readback.js";

const CONTENT_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);
const HASHES_SHA = "c".repeat(64);
const READBACK_SHA = "d".repeat(64);
const RESIDENCY_DIGEST = "e".repeat(64);

function operationView(): PromotionReadbackOperationView {
  return {
    staging_session_ref: "session-1",
    decision_receipt_ref: "decision-1",
    residency_key: {
      scope_domain_id: "scope-1",
      access_domain_id: "access-1",
      confidentiality_domain_id: "conf-1",
      encryption_key_domain_id: "enc-1",
      retention_domain_id: "ret-1",
      erasure_domain_id: "era-1",
      content_digest: { algorithm: "sha256", digest: CONTENT_SHA },
    },
    manifest: { content: { markdown_sha256: CONTENT_SHA } },
    operation_id: "op-1",
    manifest_sha256: MANIFEST_SHA,
    source_revision_ref: "rev-1",
    residency_key_digest: RESIDENCY_DIGEST,
  };
}

function promotionView(): PromotionReceiptView {
  return {
    protocol: "eliotr.bundle-promotion.v1",
    session_id: "session-1",
    admission_receipt_ref: "decision-1",
    canonical_manifest_ref: "ns/op/manifest.json",
    readback_digest: READBACK_SHA,
    promoted_objects: [
      {
        logical_path: "content.md",
        canonical_key: "staging/content.md",
        sha256: CONTENT_SHA,
        size_bytes: 128,
        etag: "etag-content",
      },
      {
        logical_path: "hashes.sha256",
        canonical_key: "staging/hashes.sha256",
        sha256: HASHES_SHA,
        size_bytes: 256,
        etag: "etag-hashes",
        version: "v-hashes",
      },
      {
        logical_path: "manifest.json",
        canonical_key: "ns/op/manifest.json",
        sha256: MANIFEST_SHA,
        size_bytes: 512,
        etag: "etag-manifest",
      },
    ],
  };
}

const deps = {
  residencyDigestFor: async (residency: { content_digest: { digest: string } }): Promise<string> => {
    const digest = residency.content_digest.digest;
    return `${digest.slice(8)}${digest.slice(0, 8)}`;
  },
  mediaTypeFor: (logicalPath: string): string => {
    if (logicalPath.endsWith(".md")) return "text/markdown; charset=utf-8";
    if (logicalPath.endsWith(".json")) return "application/json; charset=utf-8";
    if (logicalPath.endsWith(".sha256")) return "text/plain; charset=utf-8";
    return "application/octet-stream";
  },
};

function receiptBase(): BundleAdmissionReceipt {
  return {
    operation_id: "op-1",
    manifest_sha256: MANIFEST_SHA,
    source_revision_ref: "rev-1",
    normalized_artifact_ref: "ns/op/manifest.json",
    object_residency_key_digest: RESIDENCY_DIGEST,
    decision: "ADMITTED",
    reason_codes: ["INGEST_OK"],
    readback_sha256: READBACK_SHA,
    committed_at: "2026-09-05T12:00:00.000Z",
  };
}

async function readbackFailure(attempt: () => unknown): Promise<PromotionReadbackError> {
  try {
    await attempt();
  } catch (cause) {
    expect(cause).toBeInstanceOf(PromotionReadbackError);
    return cause as PromotionReadbackError;
  }
  throw new Error("expected a promotion readback failure");
}

describe("promotion readback validators", () => {
  it("derives canonical readbacks and the promotion reference on the happy path", async () => {
    const result = await validatePromotionStructure(operationView(), promotionView(), deps);
    expect(result.promotionRef).toBe(`promotion:session-1:${READBACK_SHA.slice(0, 24)}`);
    expect(result.contentKey).toBe("staging/content.md");
    expect(result.readbacks).toHaveLength(3);
    expect(result.readbacks[0]).toEqual({
      logical_path: "content.md",
      canonical_key: "staging/content.md",
      residency_key_digest: `${CONTENT_SHA.slice(8)}${CONTENT_SHA.slice(0, 8)}`,
      sha256: CONTENT_SHA,
      size_bytes: 128,
      etag: "etag-content",
      content_type: "text/markdown; charset=utf-8",
    });
    expect(result.readbacks[1]?.version).toBe("v-hashes");
    expect(result.readbacks[2]?.content_type).toBe("application/json; charset=utf-8");
  });

  it("rejects a promotion that does not match the admitted operation", async () => {
    for (const mutate of [
      (promotion: PromotionReceiptView) => ({ ...promotion, protocol: "wrong.protocol.v1" }),
      (promotion: PromotionReceiptView) => ({ ...promotion, session_id: "other-session" }),
      (promotion: PromotionReceiptView) => ({ ...promotion, admission_receipt_ref: "other-decision" }),
      (promotion: PromotionReceiptView) => ({ ...promotion, promoted_objects: promotion.promoted_objects.slice(0, 2) }),
    ]) {
      const failure = await readbackFailure(() => validatePromotionStructure(operationView(), mutate(promotionView()), deps));
      expect(failure.code).toBe("INGEST_AUTHORITY_CONFLICT");
      expect(failure.message).toBe("promotion receipt does not match admitted operation");
    }
  });

  it("rejects malformed promotion digests and manifest references", async () => {
    const badDigest = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      { ...promotionView(), readback_digest: "not-a-digest" },
      deps,
    ));
    expect(badDigest.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
    expect(badDigest.message).toBe("promotion readback digest is not a lowercase SHA-256 digest");

    const badRef = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      { ...promotionView(), canonical_manifest_ref: "not a valid ref!" },
      deps,
    ));
    expect(badRef.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
    expect(badRef.message).toBe("canonical manifest ref is invalid");
  });

  it("rejects malformed promoted paths, keys, digests and sizes", async () => {
    const cases: ReadonlyArray<readonly [string, (object: { logical_path: string; canonical_key: string; sha256: string; size_bytes: number }) => Record<string, unknown>, string]> = [
      ["promoted logical path is invalid", (object) => ({ ...object, logical_path: "/absolute" }), "content.md"],
      ["promoted canonical key is invalid", (object) => ({ ...object, canonical_key: "/leading-slash" }), "content.md"],
      ["promoted object digest is invalid", (object) => ({ ...object, sha256: "xyz" }), "content.md"],
      ["promoted object size is invalid", (object) => ({ ...object, size_bytes: 0 }), "content.md"],
    ];
    for (const [message, mutate] of cases) {
      const promotion = promotionView();
      const target = promotion.promoted_objects.find((entry) => entry.logical_path === "content.md");
      if (target === undefined) throw new Error("fixture is missing content.md");
      const failure = await readbackFailure(() => validatePromotionStructure(
        operationView(),
        {
          ...promotion,
          promoted_objects: promotion.promoted_objects.map((entry) =>
            entry.logical_path === "content.md" ? { ...entry, ...mutate(entry) } : entry,
          ),
        },
        deps,
      ));
      expect(failure.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
      expect(failure.message).toBe(message);
    }
  });

  it("rejects malformed, oversized and control-character readback tokens", async () => {
    const withEtag = (etag: unknown) => {
      const promotion = promotionView();
      return {
        ...promotion,
        promoted_objects: promotion.promoted_objects.map((entry) =>
          entry.logical_path === "content.md" ? { ...entry, etag: etag as string } : entry,
        ),
      };
    };
    for (const etag of ["", "has\u0007control"]) {
      const failure = await readbackFailure(() => validatePromotionStructure(operationView(), withEtag(etag), deps));
      expect(failure.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
      expect(failure.message).toBe("promoted object ETag is invalid");
    }
    const oversize = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      withEtag("x".repeat(513)),
      deps,
    ));
    expect(oversize.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
    expect(oversize.message).toBe("promoted object ETag escapes its readback byte limit");

    const promotion = promotionView();
    const badVersion = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      {
        ...promotion,
        promoted_objects: promotion.promoted_objects.map((entry) =>
          entry.logical_path === "hashes.sha256" ? { ...entry, version: "v\u0000bad" } : entry,
        ),
      },
      deps,
    ));
    expect(badVersion.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
    expect(badVersion.message).toBe("promoted object version is invalid");
  });

  it("rejects unordered promotions and repeated paths or keys", async () => {
    const promotion = promotionView();
    const unordered = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      { ...promotion, promoted_objects: [...promotion.promoted_objects].reverse() },
      deps,
    ));
    expect(unordered.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(unordered.message).toBe("promotion receipt is not canonically ordered");

    const duplicateKey = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      {
        ...promotion,
        promoted_objects: promotion.promoted_objects.map((entry) =>
          entry.logical_path === "hashes.sha256" ? { ...entry, canonical_key: "staging/content.md" } : entry,
        ),
      },
      deps,
    ));
    expect(duplicateKey.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(duplicateKey.message).toBe("promotion receipt repeats a logical path or key");
  });

  it("rejects promotions missing required files", async () => {
    const promotion = promotionView();
    const withoutHashes = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      {
        ...promotion,
        promoted_objects: [
          ...promotion.promoted_objects.filter((entry) => entry.logical_path !== "hashes.sha256"),
          {
            logical_path: "zzz-notes.md",
            canonical_key: "staging/zzz-notes.md",
            sha256: "f".repeat(64),
            size_bytes: 64,
            etag: "etag-asset",
          },
        ],
      },
      deps,
    ));
    expect(withoutHashes.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(withoutHashes.message).toBe("promotion is missing hashes.sha256");
  });

  it("rejects residency, media-type and content-digest mismatches", async () => {
    const residency = await readbackFailure(() => {
      const promotion = promotionView();
      return validatePromotionStructure(
        operationView(),
        {
          ...promotion,
          promoted_objects: promotion.promoted_objects.map((entry) =>
            entry.logical_path === "content.md" ? { ...entry, residency_key_digest: "0".repeat(64) } : entry,
          ),
        },
        deps,
      );
    });
    expect(residency.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(residency.message).toBe("promoted residency digest differs from admitted authority");

    const media = await readbackFailure(() => {
      const promotion = promotionView();
      return validatePromotionStructure(
        operationView(),
        {
          ...promotion,
          promoted_objects: promotion.promoted_objects.map((entry) =>
            entry.logical_path === "content.md" ? { ...entry, content_type: "application/octet-stream" } : entry,
          ),
        },
        deps,
      );
    });
    expect(media.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(media.message).toBe("promoted media type is not canonical for its path");

    const content = await readbackFailure(() => validatePromotionStructure(
      { ...operationView(), manifest: { content: { markdown_sha256: "9".repeat(64) } } },
      promotionView(),
      deps,
    ));
    expect(content.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(content.message).toBe("promoted content digest differs from manifest");
  });

  it("rejects a manifest mapping that disagrees with the promotion", async () => {
    const promotion = promotionView();
    const failure = await readbackFailure(() => validatePromotionStructure(
      operationView(),
      {
        ...promotion,
        promoted_objects: promotion.promoted_objects.map((entry) =>
          entry.logical_path === "manifest.json" ? { ...entry, canonical_key: "staging/other.json" } : entry,
        ),
      },
      deps,
    ));
    expect(failure.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(failure.message).toBe("promotion canonical manifest mapping is inconsistent");
  });

  it("enriches an omitted readback set and rejects receipt identity mismatches", async () => {
    const operation = operationView();
    const promotion = promotionView();
    const { readbacks } = await validatePromotionStructure(operation, promotion, deps);

    const enriched = validateBundleReceiptStructure(operation, promotion, receiptBase(), readbacks);
    expect(enriched.promoted_objects).toEqual(readbacks);

    const exact = validateBundleReceiptStructure(
      operation,
      promotion,
      { ...receiptBase(), promoted_objects: [...readbacks] },
      readbacks,
    );
    expect(exact.promoted_objects).toEqual(readbacks);

    const mismatch = await readbackFailure(async () => validateBundleReceiptStructure(
      operation,
      promotion,
      { ...receiptBase(), operation_id: "other-op" },
      readbacks,
    ));
    expect(mismatch.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(mismatch.message).toBe("bundle admission receipt does not match promotion authority");
  });

  it("rejects malformed receipts, empty readbacks and caller-supplied drift", async () => {
    const operation = operationView();
    const promotion = promotionView();
    const { readbacks } = await validatePromotionStructure(operation, promotion, deps);

    const malformed = await readbackFailure(async () => validateBundleReceiptStructure(
      operation,
      promotion,
      { ...receiptBase(), decision: "MAYBE" } as unknown as BundleAdmissionReceipt,
      readbacks,
    ));
    expect(malformed.code).toBe("INGEST_AUTHORITY_INPUT_INVALID");
    expect(malformed.message).toBe("bundle admission receipt failed strict validation");

    const empty = await readbackFailure(async () => validateBundleReceiptStructure(
      operation,
      promotion,
      receiptBase(),
      [],
    ));
    expect(empty.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(empty.message).toBe("admitted bundle has no durable promotion readbacks");

    const drifted = readbacks.map((entry, index) =>
      index === 0 ? { ...entry, etag: "tampered" } : entry,
    );
    const drift = await readbackFailure(async () => validateBundleReceiptStructure(
      operation,
      promotion,
      { ...receiptBase(), promoted_objects: drifted },
      readbacks,
    ));
    expect(drift.code).toBe("INGEST_AUTHORITY_CONFLICT");
    expect(drift.message).toBe("bundle admission receipt readbacks differ from promotion authority");
  });
});
