import { describe, expect, it } from "vitest";
import { WikiPublicationError } from "@eliotr/research";
import { readObject } from "@eliotr/cloudflare-wiki/wiki-publication-store-support";
import { createWikiReaderBucket } from "./wiki-reader-fixture.js";

const KEY = "wiki-test/reader-body";

function small(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function digestOf(text: string): Promise<string> {
  const digestBytes = new Uint8Array(small(text));
  const digest = await crypto.subtle.digest("SHA-256", digestBytes.buffer);
  return Array.from(new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failureOf(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  return promise.then(
    () => { throw new Error("expected readObject to fail"); },
    (error: unknown) => error as Record<string, unknown>,
  );
}

describe("Wiki bounded R2 readback", () => {
  it("returns the declared bytes with their digest when the object matches itself", async () => {
    const text = "# Wiki\n\nExact body.\n";
    const bytes = small(text);
    const bucket = createWikiReaderBucket([{ key: KEY, size: bytes.byteLength, chunks: [bytes] }]);

    const observed = await readObject(bucket, KEY, bytes.byteLength);

    expect(observed.sha256).toBe(await digestOf(text));
    expect(new TextDecoder().decode(observed.bytes)).toBe(text);
  });

  it("rejects an unreadable key instead of returning empty bytes", async () => {
    const bucket = createWikiReaderBucket([]);

    await expect(readObject(bucket, KEY, 1024)).rejects.toMatchObject({
      code: "WIKI_PUBLICATION_INCOMPLETE",
    });
  });

  it("rejects a present empty object as an incomplete publication", async () => {
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancels += 1; },
    }, { highWaterMark: 0 });
    const bucket = { get: async () => ({ key: KEY, size: 0, body }) };

    await expect(readObject(
      bucket as unknown as Parameters<typeof readObject>[0],
      KEY,
      1024,
    )).rejects.toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    expect(cancels).toBe(1);
  });

  it("gives the declared-size rejection precedence and does not wait for body cancellation", async () => {
    const bytes = small("wiki-boundary");
    let pulls = 0;
    let cancels = 0;
    let finishCancel: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull() { pulls += 1; },
      cancel() {
        cancels += 1;
        return new Promise<void>((resolve) => { finishCancel = resolve; });
      },
    }, { highWaterMark: 0 });
    const bucket = { get: async () => ({ key: KEY, size: bytes.byteLength, body }) };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      failureOf(readObject(
        bucket as unknown as Parameters<typeof readObject>[0],
        KEY,
        bytes.byteLength - 1,
      )).then((error) => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "pending" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "pending" }), 100);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);

    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error).toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
      }
      expect(cancels).toBe(1);
      expect(pulls).toBe(0);
      expect(body.locked).toBe(false);
    } finally {
      finishCancel?.();
    }
  });

  it("maps a byte-envelope overrun to an incomplete publication without adopting the donor cause", async () => {
    const delivered = small("declared-too-small");
    // The declared size is smaller than what the body actually delivers, so the
    // reader must fail on its own bound instead of accepting the extra bytes.
    const bucket = createWikiReaderBucket([{ key: KEY, size: 4, chunks: [delivered] }]);

    const failure = await failureOf(readObject(bucket, KEY, delivered.byteLength));

    expect(failure).toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    expect(failure.cause).toBeUndefined();
    expect(bucket.bodyOpens()).toBe(1);
    expect(bucket.cancels()).toBe(1);
  });

  it("maps an overrun without waiting for cancellation and releases the shared reader lock", async () => {
    let cancelled = false;
    let finishCancel: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
      cancel() {
        cancelled = true;
        return new Promise<void>((resolve) => { finishCancel = resolve; });
      },
    });
    const bucket = { get: async () => ({ key: KEY, size: 1, body }) };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      failureOf(readObject(
        bucket as unknown as Parameters<typeof readObject>[0],
        KEY,
        16,
      )).then((error) => ({ kind: "rejected" as const, error })),
      new Promise<{ kind: "pending" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "pending" }), 100);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);

    try {
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.error).toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
      }
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
      const reader = body.getReader();
      reader.releaseLock();
    } finally {
      finishCancel?.();
    }
  });

  it("rejects a body that ends short of its declared size without a retryable settlement", async () => {
    const delivered = small("short");
    const bucket = createWikiReaderBucket([
      { key: KEY, size: delivered.byteLength + 8, chunks: [delivered] },
    ]);

    const failure = await failureOf(readObject(bucket, KEY, delivered.byteLength + 8));

    expect(failure).toMatchObject({ code: "WIKI_IMMUTABLE_READBACK_MISMATCH", retryable: false });
  });

  it("treats a body that cannot deliver as an uncertain settlement the caller may retry", async () => {
    const bytes = small("unavailable");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("stream is unavailable"));
      },
    });
    const bucket = { get: async () => ({ key: KEY, size: bytes.byteLength, body }) };

    const failure = await failureOf(readObject(
      bucket as unknown as Parameters<typeof readObject>[0],
      KEY,
      bytes.byteLength,
    ));

    expect(failure).toMatchObject({ code: "WIKI_SETTLEMENT_UNCERTAIN", retryable: true });
  });

  it("preserves an existing Wiki domain failure from the stream", async () => {
    const domainFailure = new WikiPublicationError("WIKI_HEAD_CONFLICT", "original Wiki failure");
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(domainFailure); },
    });
    const bucket = { get: async () => ({ key: KEY, size: 1, body }) };

    const failure = await failureOf(readObject(
      bucket as unknown as Parameters<typeof readObject>[0],
      KEY,
      16,
    ));

    expect(failure).toBe(domainFailure);
  });

  it("maps an empty-chunk flood to an incomplete publication rather than uncertainty", async () => {
    // Empty chunks still consume the shared reader's chunk budget.
    const chunks = [
      ...Array.from({ length: 8_200 }, () => new Uint8Array()),
      small("x"),
    ];
    const bucket = createWikiReaderBucket([
      { key: KEY, size: 1, chunks, pullDriven: true },
    ]);

    const failure = await failureOf(readObject(bucket, KEY, 1));

    expect(failure).toMatchObject({ code: "WIKI_PUBLICATION_INCOMPLETE" });
    expect(failure.cause).toBeUndefined();
    expect(bucket.cancels()).toBe(1);
  });

  it("hands the caller a buffer the source can no longer mutate", async () => {
    const first = small("first-half");
    const second = small("-second-half");
    const bucket = createWikiReaderBucket([
      { key: KEY, size: first.byteLength + second.byteLength, chunks: [first, second] },
    ]);

    const observed = await readObject(bucket, KEY, first.byteLength + second.byteLength);
    const frozen = new TextDecoder().decode(observed.bytes);
    first.fill(0);
    second.fill(0);

    expect(frozen).toBe("first-half-second-half");
    expect(new TextDecoder().decode(observed.bytes)).toBe("first-half-second-half");
  });
});
