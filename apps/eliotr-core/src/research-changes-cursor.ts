import type { ResearchChangeKind } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";

const CURSOR_PROTOCOL = "eliotr.research-changes.cursor.v1";
const MAX_CURSOR_TTL_MS = 86_400_000;
const MAX_CURSOR_BYTES = 4_096;
const CLOCK_SKEW_MS = 60_000;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,511}$/u;
const SAFE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:._/@%+-]{0,255}$/u;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u;

export const RESEARCH_CHANGE_KINDS = [
  "WIKI_PUBLISHED",
  "SOURCE_ADMITTED",
  "SOURCE_UPDATED",
  "ARTIFACT_DRAFTED",
  "RESEARCH_COMPLETED",
  "ERASURE_COMPLETED",
] as const satisfies readonly ResearchChangeKind[];
const KIND_SET = new Set<string>(RESEARCH_CHANGE_KINDS);

export interface ResearchChangesCursorAuthority {
  readonly protocol: typeof CURSOR_PROTOCOL;
  readonly principal_ref: string;
  readonly client_class: "owner_pwa";
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly kinds: readonly ResearchChangeKind[];
}

interface CursorPayload extends ResearchChangesCursorAuthority {
  readonly sequence: number;
  readonly change_ref: string;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

export interface ResearchChangesCursorCodec {
  ready(): Promise<void>;
  sign(input: { readonly sequence: number; readonly change_ref: string }): Promise<string>;
  verify(token: string): Promise<{ readonly sequence: number; readonly change_ref: string }>;
}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function exactRecord(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor payload is invalid");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor payload is invalid");
  }
  return record;
}

export function validResearchChangesIdentity(
  value: unknown,
  label: string,
  code = "RESEARCH_CHANGES_INPUT_INVALID",
  status = 400,
): string {
  if (typeof value !== "string" || !SAFE_IDENTITY.test(value)) {
    fail(code, `${label} is invalid`, status);
  }
  return value;
}

export function normalizeResearchChangeKinds(
  raw: unknown,
  code = "RESEARCH_CHANGES_INPUT_INVALID",
): readonly ResearchChangeKind[] {
  if (!Array.isArray(raw) || raw.length > RESEARCH_CHANGE_KINDS.length) {
    fail(code, "change kinds are invalid");
  }
  const kinds: ResearchChangeKind[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !KIND_SET.has(item) || seen.has(item)) {
      fail(code, "change kinds are invalid");
    }
    seen.add(item);
    kinds.push(item as ResearchChangeKind);
  }
  return kinds.sort();
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unbase64url(value: string, code: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) fail(code, "base64url value is invalid");
  try {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    fail(code, "base64url value is invalid");
  }
}

async function importKey(raw: string | undefined): Promise<CryptoKey> {
  if (raw === undefined || !BASE64URL_32_BYTES.test(raw)) {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "RESEARCH_CHANGES_CURSOR_KEY must encode 32 bytes", 503, true);
  }
  const bytes = unbase64url(raw, "RESEARCH_CHANGES_CONFIG_INVALID");
  if (bytes.byteLength !== 32) {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "research changes cursor key has invalid length", 503, true);
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(bytes).buffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  } catch {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "research changes cursor key cannot be imported", 503, true);
  } finally {
    bytes.fill(0);
  }
}

function payloadJson(payload: CursorPayload): string {
  return JSON.stringify({
    protocol: CURSOR_PROTOCOL,
    sequence: payload.sequence,
    change_ref: payload.change_ref,
    principal_ref: payload.principal_ref,
    client_class: payload.client_class,
    credential_generation: payload.credential_generation,
    deployment_generation: payload.deployment_generation,
    kinds: payload.kinds,
    issued_at_ms: payload.issued_at_ms,
    expires_at_ms: payload.expires_at_ms,
  });
}

function decodePayload(bytes: Uint8Array): CursorPayload {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor payload is invalid"); }
  const record = exactRecord(parsed, [
    "protocol", "sequence", "change_ref", "principal_ref", "client_class",
    "credential_generation", "deployment_generation", "kinds", "issued_at_ms", "expires_at_ms",
  ]);
  return {
    protocol: record.protocol as typeof CURSOR_PROTOCOL,
    sequence: record.sequence as number,
    change_ref: record.change_ref as string,
    principal_ref: record.principal_ref as string,
    client_class: record.client_class as "owner_pwa",
    credential_generation: record.credential_generation as string,
    deployment_generation: record.deployment_generation as string,
    kinds: normalizeResearchChangeKinds(record.kinds, "RESEARCH_CHANGES_CURSOR_INVALID"),
    issued_at_ms: record.issued_at_ms as number,
    expires_at_ms: record.expires_at_ms as number,
  };
}

function sameAuthority(left: CursorPayload, right: ResearchChangesCursorAuthority): boolean {
  return left.principal_ref === right.principal_ref &&
    left.client_class === right.client_class &&
    left.credential_generation === right.credential_generation &&
    left.deployment_generation === right.deployment_generation &&
    JSON.stringify(left.kinds) === JSON.stringify(right.kinds);
}

export function createResearchChangesCursorCodec(input: {
  readonly key: string | undefined;
  readonly authority: Omit<ResearchChangesCursorAuthority, "protocol">;
  readonly now: number;
  readonly ttl_ms?: number;
}): ResearchChangesCursorCodec {
  const ttl = input.ttl_ms ?? MAX_CURSOR_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > MAX_CURSOR_TTL_MS ||
      !Number.isSafeInteger(input.now) || input.now < 0) {
    fail("RESEARCH_CHANGES_CONFIG_INVALID", "research changes cursor configuration is invalid", 503, true);
  }
  const authority: ResearchChangesCursorAuthority = { protocol: CURSOR_PROTOCOL, ...input.authority };
  const keyPromise = importKey(input.key);
  return {
    async ready() { await keyPromise; },
    async sign(position) {
      if (!Number.isSafeInteger(position.sequence) || position.sequence < 1 || !SAFE_REF.test(position.change_ref)) {
        fail("RESEARCH_CHANGES_READBACK_CORRUPT", "change cursor position is invalid", 409);
      }
      const payload: CursorPayload = {
        ...authority,
        ...position,
        issued_at_ms: input.now,
        expires_at_ms: input.now + ttl,
      };
      const bytes = new TextEncoder().encode(payloadJson(payload));
      const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyPromise, bytes));
      return `${base64url(bytes)}.${base64url(signature)}`;
    },
    async verify(token) {
      const pieces = token.split(".");
      if (pieces.length !== 2 || pieces[0] === undefined || pieces[1] === undefined) {
        fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor is malformed");
      }
      const bytes = unbase64url(pieces[0], "RESEARCH_CHANGES_CURSOR_INVALID");
      const signature = unbase64url(pieces[1], "RESEARCH_CHANGES_CURSOR_INVALID");
      if (bytes.byteLength > MAX_CURSOR_BYTES || signature.byteLength !== 32 ||
          !await crypto.subtle.verify("HMAC", await keyPromise, signature, bytes)) {
        fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor signature is invalid");
      }
      const payload = decodePayload(bytes);
      const structurallyValid = payload.protocol === CURSOR_PROTOCOL &&
        Number.isSafeInteger(payload.sequence) && payload.sequence > 0 && SAFE_REF.test(payload.change_ref) &&
        SAFE_IDENTITY.test(payload.principal_ref) && payload.client_class === "owner_pwa" &&
        SAFE_IDENTITY.test(payload.credential_generation) && SAFE_IDENTITY.test(payload.deployment_generation) &&
        Number.isSafeInteger(payload.issued_at_ms) && Number.isSafeInteger(payload.expires_at_ms) &&
        payload.issued_at_ms <= input.now + CLOCK_SKEW_MS && payload.expires_at_ms > input.now &&
        payload.expires_at_ms > payload.issued_at_ms && payload.expires_at_ms - payload.issued_at_ms <= ttl &&
        base64url(new TextEncoder().encode(payloadJson(payload))) === pieces[0];
      if (!structurallyValid) {
        fail("RESEARCH_CHANGES_CURSOR_INVALID", "changes cursor payload is invalid");
      }
      if (!sameAuthority(payload, authority)) {
        fail("RESEARCH_CHANGES_CURSOR_BINDING_MISMATCH", "changes cursor belongs to another authority", 409);
      }
      return { sequence: payload.sequence, change_ref: payload.change_ref };
    },
  };
}
