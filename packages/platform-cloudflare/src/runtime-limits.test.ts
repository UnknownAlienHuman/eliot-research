import { describe, expect, it } from "vitest";
import {
  RuntimeLimitError,
  assertWithinBytes,
  readRequestBodyWithinBytes,
  readResponseBodyWithinBytes,
  readStreamWithinBytes,
  serializeJsonWithinBytes,
  utf8ByteLength,
} from "./runtime-limits.js";

describe("runtime limits", () => {
  it("counts UTF-8 bytes instead of UTF-16 code units", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(() => serializeJsonWithinBytes("payload", { value: "é" }, 14)).not.toThrow();
    expect(() => serializeJsonWithinBytes("payload", { value: "é" }, 13)).toThrow(RuntimeLimitError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "rejects invalid measured byte values: %s",
    (actual) => {
      expect(() => assertWithinBytes("payload", actual, 10)).toThrow(RuntimeLimitError);
    },
  );

  it("rejects non-serializable JSON before publication", () => {
    expect(() => serializeJsonWithinBytes("payload", 1n, 100)).toThrowError(
      expect.objectContaining({ code: "JSON_SERIALIZATION_FAILED" }),
    );
    expect(() => serializeJsonWithinBytes("payload", undefined, 100)).toThrow(RuntimeLimitError);
  });

  it("stops reading as soon as a stream exceeds its byte envelope", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readStreamWithinBytes(stream, {
      label: "body",
      max_bytes: 6,
      max_chunks: 4,
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(cancelled).toBe(true);
  });

  it("rejects pathological tiny-chunk streams", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    await expect(readStreamWithinBytes(stream, {
      label: "body",
      max_bytes: 10,
      max_chunks: 2,
    })).rejects.toMatchObject({ code: "STREAM_CHUNK_LIMIT_EXCEEDED" });
  });

  it("uses Content-Length as an early rejection only and still counts streamed bytes", async () => {
    const declaredTooLarge = new Request("https://research.example/", {
      method: "POST",
      headers: { "content-length": "11" },
      body: "small",
    });
    await expect(readRequestBodyWithinBytes(declaredTooLarge, {
      label: "request",
      max_bytes: 10,
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    const invalidLength = new Request("https://research.example/", {
      method: "POST",
      headers: { "content-length": "1e2" },
      body: "small",
    });
    await expect(readRequestBodyWithinBytes(invalidLength, {
      label: "request",
      max_bytes: 100,
    })).rejects.toMatchObject({ code: "INVALID_CONTENT_LENGTH" });
  });
});

describe("bounded stream cleanup", () => {
  it.each([
    { chunks: [new Uint8Array(2)], max_bytes: 1, max_chunks: 2, code: "LIMIT_EXCEEDED" },
    { chunks: [new Uint8Array(1), new Uint8Array(1)], max_bytes: 10, max_chunks: 1,
      code: "STREAM_CHUNK_LIMIT_EXCEEDED" },
    { chunks: ["not bytes"], max_bytes: 10, max_chunks: 2, code: "STREAM_CHUNK_INVALID" },
  ])("rejects $code before source cancellation settles and releases its reader", async (scenario) => {
    let releaseCleanup: () => void = () => undefined;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cancellations = 0;
    const stream = new ReadableStream<unknown>({
      start(controller) { for (const chunk of scenario.chunks) controller.enqueue(chunk); },
      cancel() { cancellations += 1; return cleanup; },
    }, { highWaterMark: 0 });
    // The invalid-chunk case intentionally supplies a non-byte runtime stream.
    const result = readStreamWithinBytes(stream as ReadableStream<Uint8Array>, {
      label: "body", max_bytes: scenario.max_bytes, max_chunks: scenario.max_chunks,
    }).then(() => "unexpected success", (error: unknown) => error);
    try {
      // Native promise jobs drain before this timer; no wall-clock latency assertion.
      const pending = new Promise<"pending">((resolve) => { setTimeout(() => resolve("pending"), 0); });
      expect(await Promise.race([result, pending])).toMatchObject({ code: scenario.code });
      expect(cancellations).toBe(1);
      expect(stream.locked).toBe(false);
    } finally {
      releaseCleanup();
      await result;
    }
  });

  it.each(["throws", "rejects"])("preserves the original error when cleanup %s", async (mode) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2)); },
      cancel() {
        const error = new Error("synthetic cleanup failure");
        if (mode === "throws") throw error;
        return Promise.reject(error);
      },
    });
    await expect(readStreamWithinBytes(stream, { label: "body", max_bytes: 1 }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED", actual: 2, limit: 1 });
    expect(stream.locked).toBe(false);
  });

  it.each([
    { length: "11", code: "LIMIT_EXCEEDED" },
    { length: "1e2", code: "INVALID_CONTENT_LENGTH" },
    { length: "9007199254740992", code: "INVALID_CONTENT_LENGTH" },
  ])("cancels header-rejected responses without pulling bytes: $length", async ({ length, code }) => {
    let pulls = 0;
    let cancellations = 0;
    let releaseCleanup: () => void = () => undefined;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      pull() { pulls += 1; },
      cancel() { cancellations += 1; return cleanup; },
    }, { highWaterMark: 0 });
    const response = new Response(stream, { headers: { "content-length": length } });
    const result = readResponseBodyWithinBytes(response, { label: "response", max_bytes: 10 })
      .then(() => "unexpected success", (error: unknown) => error);
    try {
      const pending = new Promise<"pending">((resolve) => { setTimeout(() => resolve("pending"), 0); });
      expect(await Promise.race([result, pending])).toMatchObject({ code });
      expect(cancellations).toBe(1);
      expect(pulls).toBe(0);
      expect(stream.locked).toBe(false);
    } finally {
      releaseCleanup();
      await result;
    }
  });

  it("does not cancel or alter a successful bounded read", async () => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
      cancel() { cancellations += 1; },
    });
    const bytes = await readStreamWithinBytes(stream, { label: "body", max_bytes: 3, max_chunks: 2 });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(cancellations).toBe(0);
    expect(stream.locked).toBe(false);
  });

  it("cancels a header-rejected request body", async () => {
    const request = new Request("https://research.example/", {
      method: "POST", headers: { "content-length": "11" }, body: "small",
    });
    await expect(readRequestBodyWithinBytes(request, { label: "request", max_bytes: 10 }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(request.bodyUsed).toBe(true);
    expect(request.body?.locked).toBe(false);
  });

  it("preserves an upstream read error and releases the reader", async () => {
    const original = new Error("synthetic read failure");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(original); },
    });
    await expect(readStreamWithinBytes(stream, { label: "body", max_bytes: 1 }))
      .rejects.toBe(original);
    expect(stream.locked).toBe(false);
  });
});
