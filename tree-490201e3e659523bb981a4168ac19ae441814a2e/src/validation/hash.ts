import { ObjectResidencyKeySchema, type ObjectResidencyKey } from "../residency.js";

const OBJECT_RESIDENCY_SERIALIZATION_VERSION = "object-residency-key.v1";

function serializeObjectResidencyKeyForDigest(key: ObjectResidencyKey): string {
  return [
    OBJECT_RESIDENCY_SERIALIZATION_VERSION,
    key.scope_domain_id,
    key.access_domain_id,
    key.confidentiality_domain_id,
    key.encryption_key_domain_id,
    key.retention_domain_id,
    key.erasure_domain_id,
    key.content_digest.algorithm,
    key.content_digest.digest,
  ].map(encodeURIComponent).join("/");
}

function bytesToHex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Utf8(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function objectResidencyKeyDigest(residency: ObjectResidencyKey): Promise<string> {
  const parsed = ObjectResidencyKeySchema.parse(residency);
  return sha256Utf8(serializeObjectResidencyKeyForDigest(parsed));
}
