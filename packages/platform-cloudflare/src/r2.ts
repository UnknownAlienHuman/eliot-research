import type { ObjectResidencyKey } from "@eliotr/contracts";
import { serializeObjectResidencyKey } from "@eliotr/domain";
import { RUNTIME_LIMITS, assertWithinBytes } from "./runtime-limits.js";

export interface ImmutableObjectWrite {
  readonly key: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly expected_sha256: string;
  readonly content_type: string;
  readonly custom_metadata: Readonly<Record<string, string>>;
}

export interface ImmutableObjectReceipt {
  readonly key: string;
  readonly expected_sha256: string;
  readonly readback_sha256: string;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface EvidenceObjectStore {
  putImmutable(write: ImmutableObjectWrite): Promise<ImmutableObjectReceipt>;
  open(key: string, range?: { offset: number; length: number }): Promise<R2ObjectBody | null>;
  deleteForErasure(key: string, erasureAuthorizationRef: string): Promise<void>;
}

export function canonicalEvidenceObjectKey(
  residency: ObjectResidencyKey,
  prefix: string,
  contentDigest: string,
): string {
  const domain = encodeURIComponent(serializeObjectResidencyKey(residency));
  return `objects/${domain}/${prefix}/${contentDigest}`;
}

export async function bufferBounded(body: ReadableStream<Uint8Array>, limit = RUNTIME_LIMITS.buffered_r2_bytes): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    assertWithinBytes("buffered R2 object", total, limit);
    parts.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
