import { describe, expect, it } from "vitest";
import type { ObjectResidencyKey } from "@eliotr/contracts";
import {
  bundleFixture,
  fakeBucket,
  stagingTestPort,
  testDigestSink,
  uploadAll,
} from "./ingest-test-fixture.js";
import { promotionKey, readPromotionReceipt } from "./ingest-state.js";
import type { BundlePromotionReceipt } from "./ingest-types.js";
import { canonicalJson, contentType } from "./ingest-validation.js";
import {
  canonicalEvidenceObjectKey,
  createR2EvidenceObjectStore,
  objectResidencyKeyDigest,
  sha256Utf8,
} from "./r2.js";

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function residency(overrides: Partial<ObjectResidencyKey> = {}): ObjectResidencyKey {
  return {
    scope_domain_id: "scope-a",
    access_domain_id: "access-a",
    confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-a",
    retention_domain_id: "retention-a",
    erasure_domain_id: "erase-a",
    content_digest: { algorithm: "sha256", digest: "a".repeat(64) },
    ...overrides,
  };
}

async function putPromotionReceipt(
  bucket: R2Bucket,
  sessionId: string,
  receipt: BundlePromotionReceipt,
): Promise<void> {
  const text = canonicalJson(receipt);
  const receiptDigest = await sha256Utf8(text);
  await bucket.put(promotionKey(sessionId), text, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: receiptDigest,
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { eliotr_sha256: receiptDigest, eliotr_immutable: "true" },
  });
}

describe("ER-14 N1 per-file promotion readbacks", () => {
  it("captures the R2 versioned identity on fresh and reconciled writes", async () => {
    const fixture = fakeBucket();
    const store = createR2EvidenceObjectStore(fixture.binding, {
      createSha256Sink: testDigestSink,
    });
    const bytes = new TextEncoder().encode("versioned evidence");
    const sha256 = await digest(bytes);
    const key = `objects/${"b".repeat(64)}/original/${sha256}`;
    const first = await store.putImmutable({
      key,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    });
    expect(first.existed_identically).toBe(false);
    expect(typeof first.version).toBe("string");
    expect(first.version).toBe(fixture.objects.get(key)?.etag);

    const repeated = await store.putImmutable({
      key,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    });
    expect(repeated.existed_identically).toBe(true);
    expect(repeated.version).toBe(first.version);
    expect(fixture.objects.size).toBe(1);
  });

  it("omits version when the bucket issues no versioned identity", async () => {
    const objects = new Map<
      string,
      {
        readonly bytes: Uint8Array;
        readonly etag: string;
        readonly customMetadata: Record<string, string>;
        readonly httpMetadata: { readonly contentType?: string };
      }
    >();
    let sequence = 0;
    const binding = {
      async get(key: string) {
        const object = objects.get(key);
        if (object === undefined) return null;
        return {
          key,
          size: object.bytes.byteLength,
          etag: object.etag,
          customMetadata: object.customMetadata,
          httpMetadata: object.httpMetadata,
          body: stream(object.bytes),
        };
      },
      async put(
        key: string,
        value: ReadableStream<Uint8Array>,
        options?: {
          customMetadata?: Record<string, string>;
          httpMetadata?: { readonly contentType?: string };
        },
      ) {
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        const etag = `etag-${++sequence}`;
        const stored = {
          bytes,
          etag,
          customMetadata: options?.customMetadata ?? {},
          httpMetadata: options?.httpMetadata ?? {},
        };
        objects.set(key, stored);
        return {
          key,
          size: bytes.byteLength,
          etag,
          customMetadata: stored.customMetadata,
          httpMetadata: stored.httpMetadata,
        };
      },
    } as unknown as R2Bucket;
    const store = createR2EvidenceObjectStore(binding, {
      createSha256Sink: testDigestSink,
    });
    const bytes = new TextEncoder().encode("unversioned evidence");
    const sha256 = await digest(bytes);
    const receipt = await store.putImmutable({
      key: `objects/${"c".repeat(64)}/original/${sha256}`,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    });
    expect(receipt.version).toBe(undefined);
  });

  it("promotion persists per-file residency digest, media type and version", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = stagingTestPort(work, evidence);
    const prepared = await port.prepare({
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-n1",
      idempotency_key: "bundle-n1",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    const promoted = await port.promote(session.session_id, "admission-receipt-n1");
    expect(promoted.promoted_objects).toHaveLength(3);
    for (const entry of promoted.promoted_objects) {
      const expectedDigest = await objectResidencyKeyDigest({
        ...fixture.residency,
        content_digest: { algorithm: "sha256", digest: entry.sha256 },
      });
      expect(entry.residency_key_digest).toBe(expectedDigest);
      expect(entry.content_type).toBe(contentType(entry.logical_path));
      expect(typeof entry.version).toBe("string");
      expect(entry.version).toBe(evidence.objects.get(entry.canonical_key)?.etag);
    }
    expect(new Set(promoted.promoted_objects.map((entry) => entry.residency_key_digest)).size).toBe(3);
    const reread = await readPromotionReceipt(work.binding, session.session_id);
    expect(reread?.promoted_objects).toEqual(promoted.promoted_objects);
  });

  it("mandatory negative: identical bytes under another erasure or encryption domain diverge", async () => {
    const bytes = new TextEncoder().encode("same normalized bytes");
    const content = await digest(bytes);
    const base = residency();
    const first = await canonicalEvidenceObjectKey(base, "original", content);
    const erasureChanged = await canonicalEvidenceObjectKey(
      residency({ erasure_domain_id: "erase-b" }),
      "original",
      content,
    );
    const keyChanged = await canonicalEvidenceObjectKey(
      residency({ encryption_key_domain_id: "key-b" }),
      "original",
      content,
    );
    expect(new Set([first, erasureChanged, keyChanged]).size).toBe(3);
  });

  it("mandatory negative: a lost write acknowledgement reconciles to one canonical winner", async () => {
    const fixture = fakeBucket({ throw_after_put_prefix: "objects/" });
    const store = createR2EvidenceObjectStore(fixture.binding, {
      createSha256Sink: testDigestSink,
    });
    const bytes = new TextEncoder().encode("lost-ack evidence");
    const sha256 = await digest(bytes);
    const write = {
      key: `objects/${"d".repeat(64)}/original/${sha256}`,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    } as const;
    const recovered = await store.putImmutable({ ...write, body: stream(bytes) });
    expect(recovered.existed_identically).toBe(true);
    const winner = await store.putImmutable({ ...write, body: stream(bytes) });
    expect(winner.existed_identically).toBe(true);
    expect(winner.etag).toBe(recovered.etag);
    expect(winner.version).toBe(recovered.version);
    expect(fixture.objects.size).toBe(1);
  });

  it("fail-closed: a non-canonical promotion media type is rejected", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = stagingTestPort(work, evidence);
    const prepared = await port.prepare({
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-n1-neg",
      idempotency_key: "bundle-n1-neg",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    const promoted = await port.promote(session.session_id, "admission-receipt-n1-neg");
    const victim = promoted.promoted_objects[0];
    if (victim === undefined) throw new Error("promotion has no objects");
    const tampered: BundlePromotionReceipt = {
      ...promoted,
      promoted_objects: promoted.promoted_objects.map((entry, index) =>
        index === 0
          ? { ...entry, content_type: "application/octet-stream" }
          : entry,
      ),
    };
    const hostile = fakeBucket();
    await putPromotionReceipt(hostile.binding, session.session_id, tampered);
    expect(victim.content_type).not.toBe("application/octet-stream");
    await expect(readPromotionReceipt(hostile.binding, session.session_id)).rejects.toMatchObject({
      name: "IngestStorageError",
    });
  });

  it("fail-closed: malformed residency digest, version, and unknown fields are rejected", async () => {
    const work = fakeBucket();
    const evidence = fakeBucket();
    const fixture = await bundleFixture();
    const port = stagingTestPort(work, evidence);
    const prepared = await port.prepare({
      manifest: fixture.manifest,
      residency_key: fixture.residency,
      file_hashes: fixture.hashes,
      total_bytes: fixture.totalBytes,
      idempotency_scope: "principal-n1-neg2",
      idempotency_key: "bundle-n1-neg2",
    });
    const session = prepared.session;
    if (session === undefined) throw new Error("prepare did not return a session");
    await uploadAll(port, session, fixture.files);
    const promoted = await port.promote(session.session_id, "admission-receipt-n1-neg2");

    const badDigest: BundlePromotionReceipt = {
      ...promoted,
      promoted_objects: promoted.promoted_objects.map((entry, index) =>
        index === 0 ? { ...entry, residency_key_digest: "not-a-digest" } : entry,
      ),
    };
    const badVersion: BundlePromotionReceipt = {
      ...promoted,
      promoted_objects: promoted.promoted_objects.map((entry, index) =>
        index === 0 ? { ...entry, version: "  " } : entry,
      ),
    };
    const unknownField = {
      ...promoted,
      promoted_objects: promoted.promoted_objects.map((entry, index) =>
        index === 0 ? { ...entry, promotion_fork: true } : entry,
      ),
    } as unknown as BundlePromotionReceipt;

    for (const candidate of [badDigest, badVersion, unknownField]) {
      const hostile = fakeBucket();
      await putPromotionReceipt(hostile.binding, session.session_id, candidate);
      await expect(readPromotionReceipt(hostile.binding, session.session_id)).rejects.toMatchObject({
        name: "IngestStorageError",
      });
    }
  });
});
