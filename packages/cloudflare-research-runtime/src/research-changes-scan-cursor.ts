import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import {
  normalizeResearchChangeKinds,
  type ResearchChangesCursorAuthority,
} from "./research-changes-cursor.js";
import type { ResearchChangesScanAnchor } from "./research-changes-scan.js";

const PROTOCOL = "eliotr.research-changes.scan.cursor.v2";
const VERSION = 2;
const PADDED_BYTES = 2_560;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_BYTES = 1 + NONCE_BYTES + PADDED_BYTES + TAG_BYTES;
const MAX_TTL_MS = 86_400_000;
const CLOCK_SKEW_MS = 60_000;
const REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,255}$/u;
const encoder = new TextEncoder();
const domain = encoder.encode(PROTOCOL);
type Authority = Omit<ResearchChangesCursorAuthority, "protocol">;

export interface ResearchChangesScanPosition extends ResearchChangesScanAnchor {
  readonly direction: "FORWARD" | "LATEST";
  readonly remaining_limit: number | null;
  readonly forward_anchor: ResearchChangesScanAnchor | null;
}

interface Payload extends Authority, ResearchChangesScanPosition {
  readonly protocol: typeof PROTOCOL;
  readonly page_limit: number;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}
function invalid(): never { return fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes scan cursor is invalid"); }
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) invalid();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const value = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - text.length % 4) % 4));
    bytes = Uint8Array.from(value, (character) => character.charCodeAt(0));
  } catch { return invalid(); }
  if (encode(bytes) !== text) invalid();
  return bytes;
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) invalid();
  return record;
}
function anchor(value: unknown): ResearchChangesScanAnchor {
  const record = exact(value, ["sequence", "change_ref"]);
  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1 ||
      typeof record.change_ref !== "string" || !REF.test(record.change_ref) ||
      record.change_ref.includes("..") || record.change_ref.includes("\\")) invalid();
  return { sequence: record.sequence as number, change_ref: record.change_ref };
}
function json(payload: Payload): string {
  return JSON.stringify({
    protocol: PROTOCOL,
    sequence: payload.sequence, change_ref: payload.change_ref,
    direction: payload.direction, remaining_limit: payload.remaining_limit, forward_anchor: payload.forward_anchor,
    principal_ref: payload.principal_ref, client_class: payload.client_class,
    credential_generation: payload.credential_generation, deployment_generation: payload.deployment_generation,
    kinds: payload.kinds, page_limit: payload.page_limit,
    issued_at_ms: payload.issued_at_ms, expires_at_ms: payload.expires_at_ms,
  });
}
function padded(payload: Payload): Uint8Array<ArrayBuffer> {
  const text = encoder.encode(json(payload));
  if (text.length > PADDED_BYTES - 4) {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "changes scan cursor exceeds its fixed payload bound", 503, true);
  }
  const bytes = new Uint8Array(PADDED_BYTES);
  new DataView(bytes.buffer).setUint32(0, text.length);
  bytes.set(text, 4);
  return bytes;
}
function readPayload(bytes: Uint8Array): Payload {
  if (bytes.length !== PADDED_BYTES) invalid();
  const length = new DataView(Uint8Array.from(bytes).buffer).getUint32(0);
  if (length === 0 || length > PADDED_BYTES - 4 || bytes.subarray(length + 4).some((value) => value !== 0)) invalid();
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, length + 4))); }
  catch { return invalid(); }
  const record = exact(raw, ["protocol", "sequence", "change_ref", "direction", "remaining_limit", "forward_anchor",
    "principal_ref", "client_class", "credential_generation", "deployment_generation", "kinds", "page_limit", "issued_at_ms", "expires_at_ms"]);
  const position = anchor({ sequence: record.sequence, change_ref: record.change_ref });
  if (record.protocol !== PROTOCOL || (record.direction !== "FORWARD" && record.direction !== "LATEST") ||
      record.client_class !== "owner_pwa" || typeof record.principal_ref !== "string" || !IDENTITY.test(record.principal_ref) ||
      typeof record.credential_generation !== "string" || !IDENTITY.test(record.credential_generation) ||
      typeof record.deployment_generation !== "string" || !IDENTITY.test(record.deployment_generation) ||
      !Number.isSafeInteger(record.page_limit) || (record.page_limit as number) < 1 || (record.page_limit as number) > 100 ||
      !Number.isSafeInteger(record.issued_at_ms) || (record.issued_at_ms as number) < 0 ||
      !Number.isSafeInteger(record.expires_at_ms)) invalid();
  const forwardAnchor = record.forward_anchor === null ? null : anchor(record.forward_anchor);
  if (record.direction === "FORWARD") {
    if (record.remaining_limit !== null || forwardAnchor !== null) invalid();
  } else if (!Number.isSafeInteger(record.remaining_limit) || (record.remaining_limit as number) < 1 ||
      (record.remaining_limit as number) > (record.page_limit as number) ||
      forwardAnchor === null || forwardAnchor.sequence < position.sequence) invalid();
  const payload: Payload = {
    protocol: PROTOCOL, ...position, direction: record.direction,
    remaining_limit: record.remaining_limit as number | null, forward_anchor: forwardAnchor,
    principal_ref: record.principal_ref, client_class: "owner_pwa",
    credential_generation: record.credential_generation, deployment_generation: record.deployment_generation,
    kinds: normalizeResearchChangeKinds(record.kinds, "RESEARCH_CHANGES_CURSOR_INVALID"),
    page_limit: record.page_limit as number, issued_at_ms: record.issued_at_ms as number, expires_at_ms: record.expires_at_ms as number,
  };
  if (json(payload) !== new TextDecoder().decode(bytes.subarray(4, length + 4))) invalid();
  return payload;
}

async function importKeys(raw: string | undefined): Promise<{ readonly aes: CryptoKey; readonly mac: CryptoKey }> {
  if (raw === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(raw)) {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "RESEARCH_CHANGES_CURSOR_KEY must encode 32 bytes", 503, true);
  }
  let material: Uint8Array<ArrayBuffer>;
  try { material = decode(raw); }
  catch { return fail("RESEARCH_CHANGES_CONFIG_INVALID", "changes scan cursor key is invalid", 503, true); }
  if (material.length !== 32) fail("RESEARCH_CHANGES_CONFIG_INVALID", "changes scan cursor key length is invalid", 503, true);
  try {
    const key = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
    const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: domain, info: encoder.encode("encryption") },
      key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const mac = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: domain, info: encoder.encode("authentication") },
      key, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign", "verify"]);
    return { aes, mac };
  } catch { return fail("RESEARCH_CHANGES_CONFIG_INVALID", "changes scan cursor key derivation is unavailable", 503, true); }
  finally { material.fill(0); }
}

export function isResearchChangesScanCursor(token: string): boolean {
  const part = token.split(".")[0];
  return part !== undefined && part.length <= 4_096 && decode(part)[0] === VERSION;
}

export function createResearchChangesScanCursorCodec(input: {
  readonly key: string | undefined;
  readonly authority: Authority;
  readonly page_limit: number;
  readonly now: number;
  readonly ttl_ms?: number;
}): {
  sign(position: ResearchChangesScanPosition): Promise<string>;
  verify(token: string): Promise<ResearchChangesScanPosition>;
} {
  const ttl = input.ttl_ms ?? MAX_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > MAX_TTL_MS ||
      !Number.isSafeInteger(input.now) || input.now < 0 || input.now > Number.MAX_SAFE_INTEGER - ttl || !Number.isSafeInteger(input.page_limit) ||
      input.page_limit < 1 || input.page_limit > 100) {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "changes scan cursor configuration is invalid", 503, true);
  }
  let keyPromise: ReturnType<typeof importKeys> | undefined;
  const keys = (): ReturnType<typeof importKeys> => keyPromise ??= importKeys(input.key);
  return {
    async sign(position) {
      const payload: Payload = { protocol: PROTOCOL, ...input.authority, ...position, page_limit: input.page_limit,
        issued_at_ms: input.now, expires_at_ms: input.now + ttl };
      const bytes = padded(payload);
      // Validate our own position/shape through the same canonical decoder before issuance.
      readPayload(bytes);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const { aes, mac } = await keys();
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: domain }, aes, bytes));
      const sealed = new Uint8Array(SEALED_BYTES);
      sealed[0] = VERSION; sealed.set(nonce, 1); sealed.set(ciphertext, 1 + NONCE_BYTES);
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", mac, sealed));
      return `${encode(sealed)}.${encode(signature)}`;
    },
    async verify(token) {
      if (token.length > 4_096) invalid();
      const pieces = token.split(".");
      if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) invalid();
      const sealed = decode(pieces[0]), signature = decode(pieces[1]);
      if (sealed.length !== SEALED_BYTES || sealed[0] !== VERSION || signature.length !== 32) invalid();
      const { aes, mac } = await keys();
      if (!await crypto.subtle.verify("HMAC", mac, signature, sealed)) invalid();
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(1, 1 + NONCE_BYTES),
          additionalData: domain }, aes, sealed.subarray(1 + NONCE_BYTES)));
      } catch { return invalid(); }
      const payload = readPayload(bytes);
      if (payload.issued_at_ms > input.now + CLOCK_SKEW_MS || payload.expires_at_ms <= input.now ||
          payload.expires_at_ms <= payload.issued_at_ms || payload.expires_at_ms - payload.issued_at_ms > ttl) invalid();
      if (payload.principal_ref !== input.authority.principal_ref || payload.client_class !== input.authority.client_class ||
          payload.credential_generation !== input.authority.credential_generation ||
          payload.deployment_generation !== input.authority.deployment_generation ||
          JSON.stringify(payload.kinds) !== JSON.stringify(input.authority.kinds) || payload.page_limit !== input.page_limit) {
        fail("RESEARCH_CHANGES_CURSOR_BINDING_MISMATCH", "changes scan cursor belongs to another authority or window", 409);
      }
      return { sequence: payload.sequence, change_ref: payload.change_ref, direction: payload.direction,
        remaining_limit: payload.remaining_limit, forward_anchor: payload.forward_anchor };
    },
  };
}
