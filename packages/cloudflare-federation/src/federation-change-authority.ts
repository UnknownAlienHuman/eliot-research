import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import {
  federationAssertDatabase,
  federationCanonicalJson,
  federationDigest,
  federationIdentifier,
  federationVersionedRef,
  type FederationAuthorityBinding,
} from "./federation-d1-common.js";
import {
  decodeFederationCursorHmacKey,
  FederationRuntimeAuthorityError,
  federationRuntimeFail,
} from "./federation-runtime-common.js";

const CURSOR_PROTOCOL = "eliotr.federation-change-cursor.v1";
const MAX_PAGE_SIZE = 256;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TTL_MS = 15 * 60 * 1_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface FederationChangePageLike {
  readonly next_cursor: string;
  readonly changed_refs: readonly VersionedRef[];
}

export interface FederationChangeAuthorityLike {
  readAuthorized(
    binding: FederationAuthorityBinding,
    afterCursor: string,
    allowedScopeRefs: readonly VersionedRef[],
  ): Promise<FederationChangePageLike>;
}

export interface D1FederationChangeAuthorityOptions {
  readonly cursor_hmac_key: string;
  readonly deployment_generation: string;
  readonly now?: () => number;
  readonly cursor_ttl_ms?: number;
  readonly page_size?: number;
}

interface CursorPayload {
  readonly protocol: typeof CURSOR_PROTOCOL;
  readonly sequence: number;
  readonly change_ref: string | null;
  readonly authority_digest: string;
  readonly scope_digest: string;
  readonly deployment_generation: string;
  readonly issued_at: number;
  readonly expires_at: number;
}

interface ChangeRow {
  readonly sequence: number;
  readonly change_ref: string;
  readonly subject_ref: string;
  readonly subject_revision: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 8_192) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor is malformed",
    );
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (cause) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor is malformed",
      false,
      cause,
    );
  }
}

function validClock(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CONFIG_INVALID",
      "federation change cursor clock is invalid",
    );
  }
  return value;
}

function validTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TTL_MS ||
    value > MAX_TTL_MS
  ) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CONFIG_INVALID",
      "federation change cursor TTL is invalid",
    );
  }
  return value;
}

function validPageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CONFIG_INVALID",
      `federation change page size must be in [1, ${MAX_PAGE_SIZE}]`,
    );
  }
  return value;
}

async function authorityDigest(
  binding: FederationAuthorityBinding,
): Promise<string> {
  return federationDigest({
    requester_principal_ref: federationIdentifier(
      binding.requester_principal_ref,
      "requester principal",
    ),
    requester_credential_generation: federationIdentifier(
      binding.requester_credential_generation,
      "requester credential generation",
    ),
    server_principal_ref: federationIdentifier(
      binding.server_principal_ref,
      "server principal",
    ),
    server_credential_generation: federationIdentifier(
      binding.server_credential_generation,
      "server credential generation",
    ),
    bridge_generation: federationIdentifier(
      binding.bridge_generation,
      "bridge generation",
    ),
    client_fence_ref: federationIdentifier(
      binding.client_fence_ref,
      "client fence",
    ),
    allowed_reference_manifest_ref: federationVersionedRef(
      binding.allowed_reference_manifest_ref,
      "allowed reference manifest",
    ),
  });
}

async function scopeDigest(
  allowedScopeRefs: readonly VersionedRef[],
): Promise<string> {
  if (allowedScopeRefs.length !== 1) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_SCOPE_INVALID",
      "federation change replay requires the manifest's exact single scope",
    );
  }
  return federationDigest([
    federationVersionedRef(allowedScopeRefs[0], "allowed scope"),
  ]);
}

async function importHmacKey(raw: string): Promise<CryptoKey> {
  const bytes = decodeFederationCursorHmacKey(raw);
  try {
    return await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(bytes).buffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  } catch (cause) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CONFIG_INVALID",
      "federation cursor HMAC key could not be imported",
      false,
      cause,
    );
  } finally {
    bytes.fill(0);
  }
}

async function encodeCursor(
  key: CryptoKey,
  payload: CursorPayload,
): Promise<string> {
  const body = encoder.encode(federationCanonicalJson(payload));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body),
  );
  return `fc1.${base64Url(body)}.${base64Url(signature)}`;
}

function parsePayload(bytes: Uint8Array): CursorPayload {
  let value: unknown;
  try {
    const text = decoder.decode(bytes);
    value = JSON.parse(text) as unknown;
    if (federationCanonicalJson(value) !== text) {
      federationRuntimeFail(
        "FEDERATION_RUNTIME_CURSOR_INVALID",
        "federation change cursor payload is noncanonical",
      );
    }
  } catch (cause) {
    if (cause instanceof FederationRuntimeAuthorityError) throw cause;
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor payload is invalid",
      false,
      cause,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor payload is invalid",
    );
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "protocol",
    "sequence",
    "change_ref",
    "authority_digest",
    "scope_digest",
    "deployment_generation",
    "issued_at",
    "expires_at",
  ];
  if (
    Object.keys(record).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(record, key)) ||
    record.protocol !== CURSOR_PROTOCOL ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    (record.change_ref !== null && typeof record.change_ref !== "string") ||
    typeof record.authority_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.authority_digest) ||
    typeof record.scope_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.scope_digest) ||
    typeof record.deployment_generation !== "string" ||
    !Number.isSafeInteger(record.issued_at) ||
    !Number.isSafeInteger(record.expires_at)
  ) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor payload is invalid",
    );
  }
  if (
    ((record.sequence as number) === 0) !== (record.change_ref === null) ||
    (record.expires_at as number) <= (record.issued_at as number)
  ) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor position is invalid",
    );
  }
  return record as unknown as CursorPayload;
}

async function verifyCursor(
  key: CryptoKey,
  token: string,
  expectedAuthorityDigest: string,
  expectedScopeDigest: string,
  deploymentGeneration: string,
  now: number,
): Promise<CursorPayload> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "fc1") {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor is malformed",
    );
  }
  const body = decodeBase64Url(parts[1] ?? "");
  const signature = decodeBase64Url(parts[2] ?? "");
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature).buffer,
    Uint8Array.from(body).buffer,
  ).catch(() => false);
  if (!valid) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_INVALID",
      "federation change cursor signature is invalid",
    );
  }
  const payload = parsePayload(body);
  if (
    payload.authority_digest !== expectedAuthorityDigest ||
    payload.scope_digest !== expectedScopeDigest ||
    payload.deployment_generation !== deploymentGeneration
  ) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_AUTHORITY_MISMATCH",
      "federation change cursor belongs to another authority",
    );
  }
  if (payload.issued_at > now || payload.expires_at <= now) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_CURSOR_EXPIRED",
      "federation change cursor has expired",
    );
  }
  return payload;
}

function decodeChangeRow(row: ChangeRow): {
  readonly sequence: number;
  readonly changeRef: string;
  readonly subject: VersionedRef;
} {
  if (
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof row.change_ref !== "string" ||
    row.change_ref.length < 1
  ) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_READBACK_CORRUPT",
      "federation change row is malformed",
    );
  }
  const parsed = VersionedRefSchema.safeParse({
    id: row.subject_ref,
    revision: row.subject_revision,
  });
  if (!parsed.success) {
    federationRuntimeFail(
      "FEDERATION_RUNTIME_READBACK_CORRUPT",
      "federation change subject is malformed",
    );
  }
  return {
    sequence: row.sequence,
    changeRef: row.change_ref,
    subject: parsed.data,
  };
}

export function createD1FederationChangeAuthority(
  database: D1Database,
  options: D1FederationChangeAuthorityOptions,
): FederationChangeAuthorityLike {
  federationAssertDatabase(database);
  const deploymentGeneration = federationIdentifier(
    options.deployment_generation,
    "deployment generation",
  );
  const clock = options.now ?? Date.now;
  const ttl = validTtl(options.cursor_ttl_ms ?? DEFAULT_TTL_MS);
  const pageSize = validPageSize(options.page_size ?? MAX_PAGE_SIZE);
  let key: Promise<CryptoKey> | undefined;
  const cursorKey = (): Promise<CryptoKey> => {
    key ??= importHmacKey(options.cursor_hmac_key);
    return key;
  };

  return Object.freeze({
    async readAuthorized(
      binding: FederationAuthorityBinding,
      afterCursor: string,
      allowedScopeRefs: readonly VersionedRef[],
    ): Promise<FederationChangePageLike> {
      const now = validClock(clock());
      const currentKey = await cursorKey();
      const bindingDigest = await authorityDigest(binding);
      const allowedScopeDigest = await scopeDigest(allowedScopeRefs);
      const scope = federationVersionedRef(
        allowedScopeRefs[0],
        "allowed scope",
      );

      let sequence = 0;
      let changeRef: string | null = null;
      if (afterCursor !== "") {
        const decoded = await verifyCursor(
          currentKey,
          afterCursor,
          bindingDigest,
          allowedScopeDigest,
          deploymentGeneration,
          now,
        );
        sequence = decoded.sequence;
        changeRef = decoded.change_ref;
        if (sequence > 0) {
          let anchor: Pick<ChangeRow, "sequence" | "change_ref"> | null;
          try {
            anchor = await database.prepare(
              "SELECT sequence,change_ref FROM research_change_feed " +
              "WHERE sequence=?1 LIMIT 1",
            ).bind(sequence).first<Pick<ChangeRow, "sequence" | "change_ref">>();
          } catch (cause) {
            federationRuntimeFail(
              "FEDERATION_RUNTIME_READ_FAILED",
              "federation change cursor anchor read failed",
              true,
              cause,
            );
          }
          if (
            anchor === null ||
            anchor.sequence !== sequence ||
            anchor.change_ref !== changeRef
          ) {
            federationRuntimeFail(
              "FEDERATION_RUNTIME_CURSOR_STALE",
              "federation change cursor anchor is stale",
            );
          }
        }
      }

      let rows: readonly ChangeRow[];
      try {
        const result = await database.prepare(
          "SELECT sequence,change_ref,subject_ref,subject_revision " +
          "FROM research_change_feed WHERE sequence>?1 " +
          "AND visibility_snapshot_id=?2 AND visibility_snapshot_revision=?3 " +
          "AND (visibility_principal_ref IS NULL OR visibility_principal_ref=?4) " +
          "ORDER BY sequence ASC LIMIT ?5",
        ).bind(
          sequence,
          scope.id,
          scope.revision,
          binding.requester_principal_ref,
          pageSize + 1,
        ).all<ChangeRow>();
        if (result.success !== true || !Array.isArray(result.results)) {
          federationRuntimeFail(
            "FEDERATION_RUNTIME_READ_FAILED",
            "federation change query did not settle",
            true,
          );
        }
        rows = result.results;
      } catch (cause) {
        if (cause instanceof FederationRuntimeAuthorityError) throw cause;
        federationRuntimeFail(
          "FEDERATION_RUNTIME_READ_FAILED",
          "federation change query failed",
          true,
          cause,
        );
      }

      const decoded = rows.slice(0, pageSize).map(decodeChangeRow);
      const unique = new Map<string, VersionedRef>();
      for (const item of decoded) {
        const keyValue = `${item.subject.id}@${item.subject.revision}`;
        if (!unique.has(keyValue)) unique.set(keyValue, item.subject);
      }
      const last = decoded.at(-1);
      const nextSequence = last?.sequence ?? sequence;
      const nextChangeRef = last?.changeRef ?? changeRef;
      const payload: CursorPayload = {
        protocol: CURSOR_PROTOCOL,
        sequence: nextSequence,
        change_ref: nextChangeRef,
        authority_digest: bindingDigest,
        scope_digest: allowedScopeDigest,
        deployment_generation: deploymentGeneration,
        issued_at: now,
        expires_at: now + ttl,
      };
      return {
        next_cursor: await encodeCursor(currentKey, payload),
        changed_refs: [...unique.values()],
      };
    },
  });
}
