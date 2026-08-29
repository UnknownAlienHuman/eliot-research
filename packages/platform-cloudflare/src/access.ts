import { readResponseBodyWithinBytes, utf8ByteLength } from "./runtime-limits.js";

export interface AccessIdentity {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly authentication_method: "cloudflare_access" | "service_token";
  readonly expires_at: string;
}
export interface AccessVerifier { verify(request: Request): Promise<AccessIdentity>; }
export const AUTHORIZATION_HEADER_NEVER_LOGGED = true as const;

export type AccessVerificationErrorCode =
  | "ACCESS_CONFIG_INVALID" | "ACCESS_JWT_MISSING" | "ACCESS_JWT_TOO_LARGE"
  | "ACCESS_JWT_MALFORMED" | "ACCESS_JWT_ALGORITHM_DENIED"
  | "ACCESS_JWT_KEY_ID_MISSING" | "ACCESS_JWKS_UNAVAILABLE" | "ACCESS_JWKS_INVALID"
  | "ACCESS_JWT_KEY_UNKNOWN" | "ACCESS_JWT_SIGNATURE_INVALID"
  | "ACCESS_JWT_ISSUER_INVALID" | "ACCESS_JWT_AUDIENCE_INVALID"
  | "ACCESS_JWT_SUBJECT_INVALID" | "ACCESS_JWT_EXPIRED"
  | "ACCESS_JWT_NOT_YET_VALID" | "ACCESS_JWT_ISSUED_IN_FUTURE"
  | "ACCESS_JWT_TYPE_INVALID" | "ACCESS_SERVICE_PRINCIPAL_DENIED";
export class AccessVerificationError extends Error {
  public readonly code: AccessVerificationErrorCode;
  public readonly retryable: boolean;
  public constructor(code: AccessVerificationErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AccessVerificationError";
    this.code = code;
    this.retryable = retryable;
  }
}
export interface CloudflareAccessVerifierConfig {
  readonly team_domain: string;
  readonly audience: string;
  readonly allowed_service_principal_common_names?: readonly string[];
  readonly clock_skew_seconds?: number;
  readonly max_token_bytes?: number;
  readonly max_jwks_bytes?: number;
  readonly max_jwks_keys?: number;
  readonly jwks_cache_ttl_seconds?: number;
  readonly unknown_kid_refresh_cooldown_seconds?: number;
}
export interface CloudflareAccessVerifierDependencies {
  readonly fetch?: typeof fetch;
  readonly subtle?: SubtleCrypto;
  readonly now?: () => number;
}
interface Config {
  readonly issuer: string;
  readonly audience: string;
  readonly allowedServiceNames: ReadonlySet<string> | undefined;
  readonly skew: number;
  readonly maxToken: number;
  readonly maxJwks: number;
  readonly maxKeys: number;
  readonly cacheTtlMs: number;
  readonly unknownKidCooldownMs: number;
}
interface JwtPayload {
  readonly iss: string;
  readonly aud: readonly string[];
  readonly sub: string;
  readonly common_name?: string;
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
  readonly type?: string;
}
interface ParsedJwt {
  readonly kid: string;
  readonly payload: JwtPayload;
  readonly signingInput: Uint8Array;
  readonly signature: Uint8Array;
}
interface AccessJwk extends JsonWebKey { readonly kid: string; }
interface KeyCache { readonly keys: ReadonlyMap<string, CryptoKey>; readonly expiresAt: number; }

const MAX_ID_BYTES = 512;
const MAX_NUMERIC_DATE = 8_640_000_000_000;
const DEFAULTS = {
  skew: 60,
  maxToken: 16 * 1024,
  maxJwks: 256 * 1024,
  maxKeys: 16,
  cacheTtl: 300,
  unknownKidCooldown: 30,
} as const;
function fail(code: AccessVerificationErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new AccessVerificationError(code, message, retryable, cause);
}
function integer(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("ACCESS_CONFIG_INVALID", `${label} is outside its allowed integer range`);
  }
  return value;
}
function identifier(value: unknown, label: string, code: AccessVerificationErrorCode): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      utf8ByteLength(value) > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(code, `${label} is missing or invalid`);
  }
  return value;
}
function config(input: CloudflareAccessVerifierConfig): Config {
  if (typeof input.team_domain !== "string") fail("ACCESS_CONFIG_INVALID", "team_domain must be a string");
  let team: URL;
  try { team = new URL(input.team_domain); }
  catch (error) { fail("ACCESS_CONFIG_INVALID", "team_domain is not a valid URL", false, error); }
  if (team.protocol !== "https:" || team.username !== "" || team.password !== "" ||
      team.pathname !== "/" || team.search !== "" || team.hash !== "" ||
      !team.hostname.endsWith(".cloudflareaccess.com")) {
    fail("ACCESS_CONFIG_INVALID", "team_domain must be an HTTPS Cloudflare Access team origin");
  }
  const audience = identifier(input.audience, "audience", "ACCESS_CONFIG_INVALID");
  let allowedServiceNames: ReadonlySet<string> | undefined;
  if (input.allowed_service_principal_common_names !== undefined) {
    allowedServiceNames = new Set(input.allowed_service_principal_common_names.map((name) =>
      identifier(name, "service principal common name", "ACCESS_CONFIG_INVALID")));
  }
  return {
    issuer: team.origin,
    audience,
    allowedServiceNames,
    skew: integer(input.clock_skew_seconds ?? DEFAULTS.skew, "clock_skew_seconds", 0, 300),
    maxToken: integer(input.max_token_bytes ?? DEFAULTS.maxToken, "max_token_bytes", 1024, 64 * 1024),
    maxJwks: integer(input.max_jwks_bytes ?? DEFAULTS.maxJwks, "max_jwks_bytes", 1024, 1024 * 1024),
    maxKeys: integer(input.max_jwks_keys ?? DEFAULTS.maxKeys, "max_jwks_keys", 1, 64),
    cacheTtlMs: integer(input.jwks_cache_ttl_seconds ?? DEFAULTS.cacheTtl,
      "jwks_cache_ttl_seconds", 1, 3600) * 1000,
    unknownKidCooldownMs: integer(input.unknown_kid_refresh_cooldown_seconds ??
      DEFAULTS.unknownKidCooldown, "unknown_kid_refresh_cooldown_seconds", 1, 300) * 1000,
  };
}
function base64Url(value: string, label: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail("ACCESS_JWT_MALFORMED", `${label} is not canonical base64url`);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(padded); }
  catch (error) { fail("ACCESS_JWT_MALFORMED", `${label} is not decodable base64url`, false, error); }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function jsonRecord(segment: string, label: string): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(base64Url(segment, label)); }
  catch (error) {
    if (error instanceof AccessVerificationError) throw error;
    fail("ACCESS_JWT_MALFORMED", `${label} is not valid UTF-8`, false, error);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { fail("ACCESS_JWT_MALFORMED", `${label} is not valid JSON`, false, error); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("ACCESS_JWT_MALFORMED", `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}
function numericDate(value: unknown, label: string, required: boolean): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_NUMERIC_DATE) {
    fail("ACCESS_JWT_MALFORMED", `${label} must be a valid NumericDate`);
  }
  return value;
}
function audiences(value: unknown): readonly string[] {
  const result = typeof value === "string" ? [value] : value;
  if (!Array.isArray(result) || result.length === 0 || result.some((entry) =>
    typeof entry !== "string" || entry.length === 0 || entry !== entry.trim() ||
    utf8ByteLength(entry) > MAX_ID_BYTES)) {
    fail("ACCESS_JWT_MALFORMED", "JWT audience must contain bounded identifiers");
  }
  return result as readonly string[];
}
function parseJwt(token: string, maxBytes: number): ParsedJwt {
  if (token !== token.trim()) fail("ACCESS_JWT_MALFORMED", "Access JWT contains surrounding whitespace");
  if (utf8ByteLength(token) > maxBytes) fail("ACCESS_JWT_TOO_LARGE", "Access JWT exceeds its byte limit");
  const segments = token.split(".");
  if (segments.length !== 3) fail("ACCESS_JWT_MALFORMED", "Access JWT must contain three segments");
  const [headerPart, payloadPart, signaturePart] = segments;
  if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    fail("ACCESS_JWT_MALFORMED", "Access JWT segments are missing");
  }
  const header = jsonRecord(headerPart, "JWT header");
  if (header.alg !== "RS256") fail("ACCESS_JWT_ALGORITHM_DENIED", "Access JWT algorithm must be RS256");
  if (header.typ !== undefined && header.typ !== "JWT") fail("ACCESS_JWT_MALFORMED", "JWT typ must be JWT");
  const kid = identifier(header.kid, "JWT key ID", "ACCESS_JWT_KEY_ID_MISSING");
  const raw = jsonRecord(payloadPart, "JWT payload");
  if (typeof raw.sub !== "string" || raw.sub !== raw.sub.trim() ||
      utf8ByteLength(raw.sub) > MAX_ID_BYTES || /[\u0000-\u001f\u007f]/.test(raw.sub)) {
    fail("ACCESS_JWT_SUBJECT_INVALID", "Access JWT subject is invalid");
  }
  const commonName = raw.common_name === undefined ? undefined :
    identifier(raw.common_name, "JWT common_name", "ACCESS_JWT_SUBJECT_INVALID");
  if (raw.sub.length === 0 && commonName === undefined) {
    fail("ACCESS_JWT_SUBJECT_INVALID", "Service-token JWT requires signed common_name");
  }
  const exp = numericDate(raw.exp, "JWT exp", true);
  const iat = numericDate(raw.iat, "JWT iat", true);
  if (exp === undefined || iat === undefined) fail("ACCESS_JWT_MALFORMED", "JWT exp and iat are required");
  const nbf = numericDate(raw.nbf, "JWT nbf", false);
  if (raw.type !== undefined && typeof raw.type !== "string") {
    fail("ACCESS_JWT_MALFORMED", "JWT type must be a string when present");
  }
  return {
    kid,
    payload: {
      iss: identifier(raw.iss, "JWT issuer", "ACCESS_JWT_MALFORMED"),
      aud: audiences(raw.aud),
      sub: raw.sub,
      exp,
      iat,
      ...(commonName === undefined ? {} : { common_name: commonName }),
      ...(nbf === undefined ? {} : { nbf }),
      ...(typeof raw.type === "string" ? { type: raw.type } : {}),
    },
    signingInput: new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    signature: base64Url(signaturePart, "JWT signature"),
  };
}
function jwks(value: unknown, maxKeys: number): readonly AccessJwk[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("ACCESS_JWKS_INVALID", "Access JWKS response must be an object", true);
  }
  const candidates = (value as Record<string, unknown>).keys;
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > maxKeys) {
    fail("ACCESS_JWKS_INVALID", "Access JWKS key count is invalid", true);
  }
  const seen = new Set<string>();
  return candidates.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      fail("ACCESS_JWKS_INVALID", "Access JWKS contains a non-object key", true);
    }
    const key = candidate as JsonWebKey;
    const kid = identifier((candidate as Record<string, unknown>).kid, "JWKS kid", "ACCESS_JWKS_INVALID");
    if (seen.has(kid)) fail("ACCESS_JWKS_INVALID", "Access JWKS contains duplicate kid", true);
    seen.add(kid);
    if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string" ||
        key.n.length === 0 || key.e.length === 0 || (key.alg !== undefined && key.alg !== "RS256") ||
        (key.use !== undefined && key.use !== "sig") ||
        (key.key_ops !== undefined && !key.key_ops.includes("verify"))) {
      fail("ACCESS_JWKS_INVALID", "Access JWKS contains an unsupported signing key", true);
    }
    return { ...key, kid, alg: "RS256", use: "sig" };
  });
}
function validateClaims(payload: JwtPayload, expected: Config, nowMs: number): void {
  if (payload.iss !== expected.issuer) fail("ACCESS_JWT_ISSUER_INVALID", "Access JWT issuer mismatch");
  if (!payload.aud.includes(expected.audience)) fail("ACCESS_JWT_AUDIENCE_INVALID", "Access JWT audience mismatch");
  if (payload.type !== undefined && payload.type !== "app") {
    fail("ACCESS_JWT_TYPE_INVALID", "Access JWT is not an application token");
  }
  const now = Math.floor(nowMs / 1000);
  if (payload.exp <= now - expected.skew) fail("ACCESS_JWT_EXPIRED", "Access JWT has expired");
  if (payload.nbf !== undefined && payload.nbf > now + expected.skew) {
    fail("ACCESS_JWT_NOT_YET_VALID", "Access JWT is not valid yet");
  }
  if (payload.iat > now + expected.skew) fail("ACCESS_JWT_ISSUED_IN_FUTURE", "Access JWT was issued in the future");
  if (payload.exp <= payload.iat || (payload.nbf !== undefined && payload.exp <= payload.nbf)) {
    fail("ACCESS_JWT_MALFORMED", "Access JWT time ordering is invalid");
  }
}
export function createCloudflareAccessVerifier(
  input: CloudflareAccessVerifierConfig,
  dependencies: CloudflareAccessVerifierDependencies = {},
): AccessVerifier {
  const expected = config(input);
  const fetchFn = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const subtle = dependencies.subtle ?? globalThis.crypto.subtle;
  const clock = dependencies.now ?? Date.now;
  const certsUrl = `${expected.issuer}/cdn-cgi/access/certs`;
  let cache: KeyCache | undefined;
  let inFlight: Promise<KeyCache> | undefined;
  let lastRefresh = Number.NEGATIVE_INFINITY;
  const now = (): number => {
    const value = clock();
    if (!Number.isFinite(value) || value < 0) fail("ACCESS_CONFIG_INVALID", "clock returned invalid time");
    return value;
  };
  const load = async (): Promise<KeyCache> => {
    let response: Response;
    try {
      response = await fetchFn(certsUrl, { method: "GET", headers: { accept: "application/json" }, redirect: "error" });
    } catch (error) { fail("ACCESS_JWKS_UNAVAILABLE", "Access JWKS request failed", true, error); }
    if (!response.ok) fail("ACCESS_JWKS_UNAVAILABLE", "Access JWKS returned non-success status", true);
    const media = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (media !== undefined && media !== "application/json") {
      fail("ACCESS_JWKS_INVALID", "Access JWKS returned non-JSON content", true);
    }
    let body: Uint8Array;
    try {
      body = await readResponseBodyWithinBytes(response, {
        label: "access_jwks", max_bytes: expected.maxJwks, max_chunks: 256,
      });
    } catch (error) { fail("ACCESS_JWKS_INVALID", "Access JWKS exceeds runtime envelope", true, error); }
    let document: unknown;
    try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch (error) { fail("ACCESS_JWKS_INVALID", "Access JWKS is not UTF-8 JSON", true, error); }
    const keys = new Map<string, CryptoKey>();
    for (const jwk of jwks(document, expected.maxKeys)) {
      let key: CryptoKey;
      try {
        key = await subtle.importKey("jwk", jwk,
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      } catch (error) { fail("ACCESS_JWKS_INVALID", "Access JWKS key import failed", true, error); }
      keys.set(jwk.kid, key);
    }
    return { keys, expiresAt: now() + expected.cacheTtlMs };
  };
  const refresh = async (): Promise<KeyCache> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = load();
    try {
      cache = await inFlight;
      lastRefresh = now();
      return cache;
    } finally { inFlight = undefined; }
  };
  const keyFor = async (kid: string): Promise<CryptoKey> => {
    const current = now();
    let refreshed = false;
    if (cache === undefined || cache.expiresAt <= current) { await refresh(); refreshed = true; }
    const currentKey = cache?.keys.get(kid);
    if (currentKey !== undefined) return currentKey;
    if (!refreshed && current - lastRefresh >= expected.unknownKidCooldownMs) await refresh();
    const key = cache?.keys.get(kid);
    if (key === undefined) fail("ACCESS_JWT_KEY_UNKNOWN", "Access JWT references unknown signing key", true);
    return key;
  };
  return {
    async verify(request: Request): Promise<AccessIdentity> {
      const assertion = request.headers.get("cf-access-jwt-assertion");
      if (assertion === null || assertion.length === 0) {
        fail("ACCESS_JWT_MISSING", "Missing required Cloudflare Access JWT");
      }
      const parsed = parseJwt(assertion, expected.maxToken);
      const key = await keyFor(parsed.kid);
      let valid: boolean;
      try {
        valid = await subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key,
          parsed.signature, parsed.signingInput);
      } catch (error) {
        fail("ACCESS_JWT_SIGNATURE_INVALID", "Access JWT signature verification failed", false, error);
      }
      if (!valid) fail("ACCESS_JWT_SIGNATURE_INVALID", "Access JWT signature is invalid");
      const current = now();
      validateClaims(parsed.payload, expected, current);
      const service = parsed.payload.sub.length === 0;
      const principal = service ? parsed.payload.common_name : parsed.payload.sub;
      if (principal === undefined) fail("ACCESS_JWT_SUBJECT_INVALID", "Access JWT has no principal");
      if (service && expected.allowedServiceNames !== undefined &&
          !expected.allowedServiceNames.has(principal)) {
        fail("ACCESS_SERVICE_PRINCIPAL_DENIED", "Service principal is not in the application allowlist");
      }
      return {
        principal_ref: principal,
        credential_generation: `cf-access-jwt:${parsed.kid}:${parsed.payload.iat}`,
        authentication_method: service ? "service_token" : "cloudflare_access",
        expires_at: new Date(parsed.payload.exp * 1000).toISOString(),
      };
    },
  };
}
