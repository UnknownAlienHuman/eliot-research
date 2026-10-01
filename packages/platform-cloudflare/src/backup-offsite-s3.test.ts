import { describe, expect, it } from "vitest";
import { createS3OffsiteCopyAdapter, signSigV4S3Request, type S3OffsiteCopyAdapterConfig } from "./backup-offsite-s3.js";

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly headers: Headers;
  readonly etag: string;
}

const fixtureTime = new Date("2026-10-01T00:00:00.000Z");
const ciphertext = new Uint8Array([0, 1, 2, 250, 255]);
const storedPart = {
  content_digest: "a".repeat(64),
  size_bytes: 19,
  key_generation: "keygen-7",
  epoch_id: "epoch-42",
  expires_at: "2026-10-02T00:00:00.000Z",
} as const;

function makeFetch(options: { readonly loseNextPutAck?: boolean } = {}): {
  readonly fetchImpl: typeof fetch;
  readonly objects: Map<string, StoredObject>;
  readonly calls: Array<{ readonly url: string; readonly init: RequestInit }>;
  corrupt(key: string): void;
} {
  const objects = new Map<string, StoredObject>();
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  let etagSequence = 0;
  let loseNextPutAck = options.loseNextPutAck ?? false;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const key = new URL(url).pathname.replace(/^\/[^/]+\//, "");
    const method = init.method ?? "GET";
    const existing = objects.get(key);
    if (method === "GET") {
      if (existing === undefined) return new Response("missing", { status: 404 });
      const headers = new Headers(existing.headers);
      headers.set("etag", existing.etag);
      headers.set("content-length", String(existing.bytes.byteLength));
      return new Response(existing.bytes.slice(), { status: 200, headers });
    }
    if (method === "HEAD") {
      if (existing === undefined) return new Response(null, { status: 404 });
      const headers = new Headers(existing.headers);
      headers.set("etag", existing.etag);
      headers.set("content-length", String(existing.bytes.byteLength));
      return new Response(null, { status: 200, headers });
    }
    if (method !== "PUT") throw new Error("unexpected method");
    const headers = new Headers(init.headers);
    if (headers.get("if-none-match") === "*" && existing !== undefined) return new Response(null, { status: 412 });
    if (headers.has("if-match") && (existing === undefined || headers.get("if-match") !== existing.etag)) return new Response(null, { status: 412 });
    const body = new Uint8Array(await new Response(init.body).arrayBuffer());
    const metadata = new Headers();
    for (const [header, value] of headers) if (header.startsWith("x-amz-meta-")) metadata.set(header, value);
    const record = { bytes: body, headers: metadata, etag: `"test-etag-${++etagSequence}"` };
    objects.set(key, record);
    if (loseNextPutAck) {
      loseNextPutAck = false;
      throw new TypeError("simulated transport failure; secret should not escape");
    }
    return new Response(null, { status: 200, headers: { etag: record.etag } });
  };
  return {
    fetchImpl,
    objects,
    calls,
    corrupt(key) {
      const object = objects.get(key);
      if (object === undefined) throw new Error("fixture object missing");
      const bytes = object.bytes.slice();
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      objects.set(key, { ...object, bytes });
    },
  };
}

function config(fetchImpl: typeof fetch, overrides: Partial<S3OffsiteCopyAdapterConfig> = {}): S3OffsiteCopyAdapterConfig {
  return {
    provider_kind: "cloudflare-r2",
    bucket_versioning: "disabled",
    endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    bucket: "eliotr-backup-test",
    region: "auto",
    endpoint_identity: "r2-endpoint-config-7",
    access_key_id: "AKIAIOSFODNN7EXAMPLE",
    secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    descriptor: {
      destination_id: "approved-destination-4",
      failure_domain: "account:independent-7",
      supports_deletion_journal: true,
      supports_expiry: true,
      retention_locked: false,
    },
    fetch_impl: fetchImpl,
    now: () => fixtureTime,
    ...overrides,
  };
}

const partRef = "offsite/epoch-42/0123456789abcdef/000001-abcdef";

describe("R2 S3-compatible offsite adapter", () => {
  it("matches the official AWS Signature V4 GET test vector", async () => {
    const authorization = await signSigV4S3Request({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: new Headers({ range: "bytes=0-9" }),
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      date: new Date("2013-05-24T00:00:00.000Z"),
    });
    expect(authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("signs requests with SigV4 and writes immutable typed ciphertext metadata", async () => {
    const fixture = makeFetch();
    const adapter = createS3OffsiteCopyAdapter(config(fixture.fetchImpl));
    const receipt = await adapter.put(partRef, ciphertext, storedPart);
    expect(receipt.ack_ref).toMatch(/^r2-etag:[a-f0-9]{64}$/);
    const first = fixture.calls[0];
    if (first === undefined) throw new Error("signed request was not captured");
    expect(new URL(first.url).hostname).toBe("0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    const headers = new Headers(first.init.headers);
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261001\/auto\/s3\/aws4_request,SignedHeaders=/);
    expect(headers.get("x-amz-date")).toBe("20261001T000000Z");
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("x-amz-meta-eliotr-record")).toBe("part");
    expect(headers.get("x-amz-meta-eliotr-content-digest")).toBe(storedPart.content_digest);
    expect(headers.get("x-amz-meta-eliotr-ciphertext-bytes")).toBe(String(ciphertext.byteLength));
    expect(headers.get("x-amz-meta-eliotr-ciphertext-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.calls.every((call) => new URL(call.url).protocol === "https:")).toBe(true);
    expect(first.init.redirect).toBe("manual");
    expect(first.init.cache).toBe("no-store");
  });

  it("reads back raw bytes and metadata, and reconciles a lost PUT acknowledgement exactly", async () => {
    const fixture = makeFetch({ loseNextPutAck: true });
    const adapter = createS3OffsiteCopyAdapter(config(fixture.fetchImpl));
    await expect(adapter.put(partRef, ciphertext, storedPart)).rejects.toMatchObject({ code: "BACKUP_OFFSITE_UNCERTAIN" });
    const retry = await adapter.put(partRef, ciphertext, storedPart);
    expect(retry.ack_ref).toMatch(/^r2-etag:/);
    const readback = await adapter.get(partRef);
    expect(readback).toEqual({ ciphertext, stored: storedPart });
    expect(fixture.calls.filter((call) => call.init.method === "PUT")).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.init.method === "PUT").every((call) => new Headers(call.init.headers).get("if-none-match") === "*")).toBe(true);
  });

  it("keeps signing credentials and transport error text out of adapter failures", async () => {
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const failingFetch: typeof fetch = async () => { throw new TypeError(`provider echoed ${secret}`); };
    const adapter = createS3OffsiteCopyAdapter(config(failingFetch));
    const failure = await adapter.put(partRef, ciphertext, storedPart).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "BACKUP_OFFSITE_UNCERTAIN" });
    const errorText = String(failure);
    expect(errorText).not.toContain(secret);
  });

  it("rejects divergent immutable replays and content tampering", async () => {
    const fixture = makeFetch();
    const adapter = createS3OffsiteCopyAdapter(config(fixture.fetchImpl));
    await adapter.put(partRef, ciphertext, storedPart);
    await expect(adapter.put(partRef, new Uint8Array([9, 9]), storedPart)).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    const key = partRef;
    fixture.corrupt(key);
    await expect(adapter.get(partRef)).rejects.toMatchObject({ code: "BACKUP_OBJECT_UNREADABLE" });
  });

  it("bounds downloaded ciphertext and rejects versioned or retained object responses", async () => {
    const metadata = new Headers({
      "etag": '"versioned-etag"',
      "x-amz-meta-eliotr-format": "1",
      "x-amz-meta-eliotr-record": "part",
      "x-amz-meta-eliotr-content-digest": storedPart.content_digest,
      "x-amz-meta-eliotr-size-bytes": String(storedPart.size_bytes),
      "x-amz-meta-eliotr-ciphertext-bytes": "32",
      "x-amz-meta-eliotr-ciphertext-sha256": "b".repeat(64),
      "x-amz-meta-eliotr-key-generation": storedPart.key_generation,
      "x-amz-meta-eliotr-epoch-id": storedPart.epoch_id,
      "x-amz-meta-eliotr-expires-at": storedPart.expires_at,
    });
    const oversizedFetch: typeof fetch = async () => new Response(new Uint8Array(32), { status: 200, headers: metadata });
    const bounded = createS3OffsiteCopyAdapter(config(oversizedFetch, { max_part_bytes: 16 }));
    await expect(bounded.get(partRef)).rejects.toMatchObject({ code: "BACKUP_OBJECT_UNREADABLE" });

    const unannouncedMetadata = new Headers(metadata);
    unannouncedMetadata.set("x-amz-meta-eliotr-ciphertext-bytes", "8");
    const oversizedStreamFetch: typeof fetch = async () => new Response(new Uint8Array(32), { status: 200, headers: unannouncedMetadata });
    const boundedStream = createS3OffsiteCopyAdapter(config(oversizedStreamFetch, { max_part_bytes: 16 }));
    await expect(boundedStream.get(partRef)).rejects.toMatchObject({ code: "BACKUP_OBJECT_UNREADABLE" });

    const versionedFetch: typeof fetch = async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: new Headers([...metadata, ["x-amz-version-id", "version-2"]]),
    });
    const versioned = createS3OffsiteCopyAdapter(config(versionedFetch));
    await expect(versioned.get(partRef)).rejects.toMatchObject({ code: "BACKUP_OFFSITE_INADMISSIBLE" });
  });

  it("writes a durable conditional tombstone before reporting deletion and refuses resurrection", async () => {
    const fixture = makeFetch();
    const adapter = createS3OffsiteCopyAdapter(config(fixture.fetchImpl));
    await adapter.put(partRef, ciphertext, storedPart);
    const deleted = await adapter.delete(partRef, "expiry:expiry-42");
    expect(deleted.journal_ref).toMatch(/^r2-tombstone:[a-f0-9]{64}$/);
    const key = partRef;
    expect(fixture.objects.get(key)?.headers.get("x-amz-meta-eliotr-record")).toBe("tombstone");
    expect(fixture.objects.get(key)?.bytes).toEqual(new TextEncoder().encode("ELIOTR_OFFSITE_TOMBSTONE_V1\n"));
    expect(fixture.calls.some((call) => call.init.method === "DELETE")).toBe(false);
    expect(fixture.calls.some((call) => call.init.method === "PUT" && new Headers(call.init.headers).has("if-match"))).toBe(true);
    expect(await adapter.get(partRef)).toBeNull();
    expect(await adapter.delete(partRef, "expiry:expiry-42")).toEqual(deleted);
    await expect(adapter.put(partRef, ciphertext, storedPart)).rejects.toMatchObject({ code: "BACKUP_RESURRECTION_REFUSED" });
    await expect(adapter.delete(partRef, "expiry:other")).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
  });

  it("fails closed on redirects, oversize bodies, and expired request deadlines without reflecting remote text", async () => {
    const secret = "NEVER-RETURN-THIS-REMOTE-BODY";
    const redirectAdapter = createS3OffsiteCopyAdapter(config(async () => new Response(secret, { status: 302, headers: { location: `https://attacker.invalid/${secret}` } })));
    await expect(redirectAdapter.get(partRef)).rejects.toThrow("offsite endpoint returned a redirect");
    const redirectError = await redirectAdapter.get(partRef).catch((error: unknown) => String(error));
    expect(redirectError).not.toContain(secret);

    const oversized = new Uint8Array(32);
    const boundedFixture = makeFetch();
    const smallAdapter = createS3OffsiteCopyAdapter(config(boundedFixture.fetchImpl, { max_part_bytes: 16 }));
    await expect(smallAdapter.put(partRef, oversized, storedPart)).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });

    const hangingFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new TypeError(secret)), { once: true });
    });
    const timeoutAdapter = createS3OffsiteCopyAdapter(config(hangingFetch, { timeout_ms: 100 }));
    const timeoutError = await timeoutAdapter.get(partRef).catch((error: unknown) => String(error));
    expect(timeoutError).toContain("offsite request exceeded its time bound");
    expect(timeoutError).not.toContain(secret);
  });

  it("rejects malformed endpoints and capability claims before network access", () => {
    const fixture = makeFetch();
    expect(() => createS3OffsiteCopyAdapter(config(fixture.fetchImpl, { endpoint: "http://attacker.invalid" }))).toThrow();
    expect(() => createS3OffsiteCopyAdapter(config(fixture.fetchImpl, {
      descriptor: { ...config(fixture.fetchImpl).descriptor, supports_deletion_journal: false },
    }))).toThrow();
    expect(fixture.calls).toHaveLength(0);
  });
});
