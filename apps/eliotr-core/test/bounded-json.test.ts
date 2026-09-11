import { describe, expect, it } from "vitest";
import { readJsonBodyWithinBytes } from "../src/bounded-json.js";

function streamed(
  bytes: Uint8Array,
  input: { readonly contentType?: string; readonly contentLength?: string } = {},
): Request {
  const headers = new Headers({
    "content-type": input.contentType ?? "application/json",
  });
  if (input.contentLength !== undefined) headers.set("content-length", input.contentLength);
  return new Request("https://research.example/test", {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded JSON request reader", () => {
  it("accepts the exact byte ceiling and rejects max+1 actual bytes", async () => {
    const bytes = new TextEncoder().encode('{"a":1}');
    await expect(readJsonBodyWithinBytes(streamed(bytes), bytes.byteLength))
      .resolves.toEqual({ a: 1 });
    await expect(readJsonBodyWithinBytes(streamed(bytes), bytes.byteLength - 1))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("rejects understated Content-Length, malformed UTF-8 and wrong media type", async () => {
    const bytes = new TextEncoder().encode("{}");
    await expect(readJsonBodyWithinBytes(
      streamed(bytes, { contentLength: "1" }),
      16,
    )).rejects.toMatchObject({ code: "REQUEST_CONTENT_LENGTH_MISMATCH" });
    await expect(readJsonBodyWithinBytes(
      streamed(new Uint8Array([0xc3, 0x28])),
      16,
    )).rejects.toMatchObject({ code: "REQUEST_BODY_INVALID" });
    await expect(readJsonBodyWithinBytes(
      streamed(bytes, { contentType: "text/plain" }),
      16,
    )).rejects.toMatchObject({ code: "REQUEST_MEDIA_TYPE_INVALID", status: 415 });
  });
});
