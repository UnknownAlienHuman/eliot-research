import { describe, expect, it } from "vitest";
import {
  RuntimeLimitError,
  assertWithinBytes,
  readRequestBodyWithinBytes,
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
