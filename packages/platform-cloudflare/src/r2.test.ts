import { describe, expect, it } from "vitest";
import type { ObjectResidencyKey } from "@eliotr/contracts";
import {
  canonicalEvidenceObjectKey,
  canonicalNormalizedBundleKey,
  createR2EvidenceObjectStore,
  type Sha256DigestSink,
} from "./r2.js";

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly customMetadata: Record<string, string>;
  readonly httpMetadata: { readonly contentType?: string };
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes)))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function testDigestSink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let resolveDigest!: (value: ArrayBuffer) => void;
  let rejectDigest!: (reason: unknown) => void;
  const result = new Promise<ArrayBuffer>((resolve, reject) => { resolveDigest = resolve; rejectDigest = reject; });
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(chunk.slice()); },
      async close() {
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        try { resolveDigest(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(body))); }
        catch (error) { rejectDigest(error); }
      },
      abort(reason) { rejectDigest(reason); },
    }),
    digest: result,
  };
}

function bucket(): { readonly binding: R2Bucket; readonly objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  let sequence = 0;
  const binding = {
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : {
        key,
        size: object.bytes.byteLength,
        etag: object.etag,
        customMetadata: object.customMetadata,
        httpMetadata: object.httpMetadata,
      };
    },
    async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const object = objects.get(key);
      if (object === undefined) return null;
      const bytes = options?.range === undefined
        ? object.bytes
        : object.bytes.slice(options.range.offset, options.range.offset + options.range.length);
      return {
        key,
        size: bytes.byteLength,
        etag: object.etag,
        customMetadata: object.customMetadata,
        httpMetadata: object.httpMetadata,
        body: stream(bytes),
      };
    },
    async put(key: string, value: string | ReadableStream<Uint8Array>, options?: {
      onlyIf?: { etagDoesNotMatch?: string };
      sha256?: string;
      customMetadata?: Record<string, string>;
      httpMetadata?: { readonly contentType?: string };
    }) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : await new Response(value).bytes();
      if (options?.sha256 !== undefined && await digest(bytes) !== options.sha256) throw new Error("checksum mismatch");
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
    async delete(input: string | string[]) {
      for (const key of typeof input === "string" ? [input] : input) objects.delete(key);
    },
  } as unknown as R2Bucket;
  return { binding, objects };
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

describe("R2 immutable evidence storage", () => {
  it("uses the complete residency identity in the physical key", async () => {
    const first = await canonicalEvidenceObjectKey(residency(), "original", "a".repeat(64));
    const erasureChanged = await canonicalEvidenceObjectKey(
      residency({ erasure_domain_id: "erase-b" }),
      "original",
      "a".repeat(64),
    );
    const keyChanged = await canonicalEvidenceObjectKey(
      residency({ encryption_key_domain_id: "key-b" }),
      "original",
      "a".repeat(64),
    );
    expect(first).toMatch(/^objects\/[a-f0-9]{64}\/original\/[a-f0-9]{64}$/u);
    expect(new Set([first, erasureChanged, keyChanged]).size).toBe(3);
    expect(first).not.toContain("erase-a");
  });


  it("includes owner namespace and owner generation in normalized bundle identity", async () => {
    const residencyDigest = "d".repeat(64);
    const base = {
      owner_system_id: "owner-a",
      source_namespace_id: "namespace-a",
      source_owner_generation: "generation-a",
      source_logical_id: "source-a",
      source_revision_ref: "revision-a",
    } as const;
    const first = await canonicalNormalizedBundleKey(residencyDigest, base, "content.md");
    const namespaceChanged = await canonicalNormalizedBundleKey(
      residencyDigest,
      { ...base, source_namespace_id: "namespace-b" },
      "content.md",
    );
    const generationChanged = await canonicalNormalizedBundleKey(
      residencyDigest,
      { ...base, source_owner_generation: "generation-b" },
      "content.md",
    );
    expect(new Set([first, namespaceChanged, generationChanged]).size).toBe(3);
  });

  it("treats an identical conditional collision as idempotent", async () => {
    const fixture = bucket();
    const store = createR2EvidenceObjectStore(fixture.binding, { createSha256Sink: testDigestSink });
    const bytes = new TextEncoder().encode("immutable evidence");
    const sha256 = await digest(bytes);
    const write = {
      key: `objects/${"b".repeat(64)}/original/${sha256}`,
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: { source: "fixture" },
    } as const;
    const first = await store.putImmutable({ ...write, body: stream(bytes) });
    const repeated = await store.putImmutable({ ...write, body: stream(bytes) });
    expect(first.existed_identically).toBe(false);
    expect(repeated.existed_identically).toBe(true);
    expect(fixture.objects.size).toBe(1);
  });

  it("rejects identical bytes when immutable authority metadata differs", async () => {
    const fixture = bucket();
    const store = createR2EvidenceObjectStore(fixture.binding, { createSha256Sink: testDigestSink });
    const bytes = new TextEncoder().encode("same evidence");
    const sha256 = await digest(bytes);
    const key = `objects/${"f".repeat(64)}/original/${sha256}`;
    await store.putImmutable({
      key,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: { admission_receipt_ref: "receipt-a" },
    });
    await expect(store.putImmutable({
      key,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: { admission_receipt_ref: "receipt-b" },
    })).rejects.toMatchObject({ code: "R2_IMMUTABLE_KEY_CONFLICT" });
  });

  it("rejects different bytes at the same immutable key", async () => {
    const fixture = bucket();
    const store = createR2EvidenceObjectStore(fixture.binding, { createSha256Sink: testDigestSink });
    const first = new TextEncoder().encode("first");
    const second = new TextEncoder().encode("second");
    const key = `objects/${"c".repeat(64)}/original/${await digest(first)}`;
    await store.putImmutable({
      key,
      body: stream(first),
      expected_sha256: await digest(first),
      expected_size_bytes: first.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    });
    await expect(store.putImmutable({
      key,
      body: stream(second),
      expected_sha256: await digest(second),
      expected_size_bytes: second.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    })).rejects.toMatchObject({ code: "R2_IMMUTABLE_KEY_CONFLICT" });
  });


  it("refuses deletion without an explicit erasure authorization verifier", async () => {
    const fixture = bucket();
    const bytes = new TextEncoder().encode("erasable evidence");
    const sha256 = await digest(bytes);
    const key = `objects/${"e".repeat(64)}/original/${sha256}`;
    const store = createR2EvidenceObjectStore(fixture.binding, { createSha256Sink: testDigestSink });
    await store.putImmutable({
      key,
      body: stream(bytes),
      expected_sha256: sha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    });
    await expect(store.deleteForErasure(key, "erasure-receipt-a"))
      .rejects.toMatchObject({ code: "R2_DELETE_AUTHORIZATION_INVALID" });
    expect(fixture.objects.has(key)).toBe(true);

    const authorized = createR2EvidenceObjectStore(fixture.binding, {
      createSha256Sink: testDigestSink,
      authorizeErasure: async (candidateKey, authorizationRef) =>
        candidateKey === key && authorizationRef === "erasure-receipt-a",
    });
    await authorized.deleteForErasure(key, "erasure-receipt-a");
    expect(fixture.objects.has(key)).toBe(false);
  });

  it("never accepts a forged residency object digest", async () => {
    const fixture = bucket();
    const store = createR2EvidenceObjectStore(fixture.binding, { createSha256Sink: testDigestSink });
    const bytes = new TextEncoder().encode("content");
    await expect(store.putResidencyObject({
      residency_key: residency(),
      prefix: "original",
      body: stream(bytes),
      expected_sha256: await digest(bytes),
      expected_size_bytes: bytes.byteLength,
      content_type: "text/plain",
      custom_metadata: {},
    })).rejects.toMatchObject({ code: "R2_SHA256_INVALID" });
  });
});
