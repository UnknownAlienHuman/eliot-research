import type { VersionedRef } from "@eliotr/contracts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("unsupported canonical JSON value");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEvidenceJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalEvidenceJson(record[key])}`
  )).join(",")}}`;
}

export function evidenceUtf8Bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evidenceSha256Bytes(value: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

export function evidenceChecksumHex(value: ArrayBuffer): string {
  return hex(new Uint8Array(value));
}

export async function evidenceSha256(value: unknown): Promise<string> {
  return evidenceSha256Bytes(evidenceUtf8Bytes(canonicalEvidenceJson(value)));
}

export async function stableEvidenceId(prefix: string, ...parts: readonly string[]): Promise<string> {
  const digest = await evidenceSha256Bytes(evidenceUtf8Bytes([prefix, ...parts].join("\u0000")));
  return `${prefix}-${digest.slice(0, 48)}`;
}

export function assertEvidenceIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${label} is not a bounded identifier`);
  }
  return value;
}

export function assertEvidenceSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

export function assertEvidenceIso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is not an ISO timestamp`);
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError(`${label} is not canonical ISO-8601`);
  }
  return value;
}

export function assertEvidenceInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} is outside its safe integer range`);
  }
  return value;
}

export function evidenceRefKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

export function exactEvidenceRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}
