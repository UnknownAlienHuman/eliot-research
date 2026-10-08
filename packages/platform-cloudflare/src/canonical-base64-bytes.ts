/**
 * Bounded canonical RFC 4648 standard Base64 for byte payloads stored in
 * explicitly named `*_base64` TEXT columns. Lengths and digests belong to the
 * decoded bytes, never to this encoded representation.
 */
export interface CanonicalBase64DecodeOptions {
  readonly max_bytes: number;
  readonly expected_bytes?: number;
}

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const ENCODE_CHUNK_BYTES = 16_383; // Multiple of three and bounded for argument spreading.

function maxEncodedLength(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("Base64 byte bound must be a non-negative safe integer");
  }
  const length = Math.ceil(maxBytes / 3) * 4;
  if (!Number.isSafeInteger(length)) throw new RangeError("Base64 encoded bound exceeds the safe integer range");
  return length;
}

function binaryString(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += ENCODE_CHUNK_BYTES) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + ENCODE_CHUNK_BYTES)));
  }
  return chunks.join("");
}

/** Encode bytes as padded standard Base64, rejecting input above `maxBytes`. */
export function encodeCanonicalBase64Bytes(bytes: Uint8Array, maxBytes: number): string {
  const encodedBound = maxEncodedLength(maxBytes);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) {
    throw new RangeError("Base64 byte input exceeds its declared bound");
  }
  const encoded = btoa(binaryString(bytes));
  if (encoded.length > encodedBound || !CANONICAL_BASE64.test(encoded)) {
    throw new TypeError("Base64 encoder did not produce canonical RFC 4648 text");
  }
  return encoded;
}

/**
 * Decode padded standard Base64 after bounding its encoded length. Re-encoding
 * the decoded bytes rejects noncanonical pad bits and alternate spellings.
 */
export function decodeCanonicalBase64Bytes(value: string, options: CanonicalBase64DecodeOptions): Uint8Array {
  const encodedBound = maxEncodedLength(options.max_bytes);
  const expectedBytes = options.expected_bytes;
  if (expectedBytes !== undefined &&
      (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > options.max_bytes)) {
    throw new RangeError("Expected Base64 byte length is outside the declared bound");
  }
  if (typeof value !== "string" || value.length > encodedBound || value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    throw new TypeError("Base64 text is malformed, non-standard, or exceeds its declared bound");
  }

  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new TypeError("Base64 text cannot be decoded");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength > options.max_bytes ||
      (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) ||
      encodeCanonicalBase64Bytes(bytes, options.max_bytes) !== value) {
    throw new TypeError("Base64 decoded bytes do not match their canonical length or spelling");
  }
  return bytes;
}
