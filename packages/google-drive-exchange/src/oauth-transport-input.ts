import { GoogleCredentialError } from "./token-vault.js";
import { oauthIdentifier } from "./oauth-types.js";

export const GOOGLE_OAUTH_ISSUER = "https://accounts.google.com";

export type GoogleOAuthTransportInputErrorCode =
  | "GOOGLE_OAUTH_ORIGIN_REQUIRED"
  | "GOOGLE_OAUTH_ORIGIN_FORBIDDEN"
  | "GOOGLE_OAUTH_CSRF_REQUIRED"
  | "GOOGLE_OAUTH_INPUT_INVALID"
  | "GOOGLE_OAUTH_CALLBACK_INVALID";

export type GoogleOAuthTransportInputFailure = (
  code: GoogleOAuthTransportInputErrorCode,
  status: 400 | 403,
  message: string,
) => never;

export interface GoogleOAuthBeginTransportInput {
  readonly expected_origin: string;
  readonly operation_ref: string;
}

export interface GoogleOAuthCallbackTransportInput {
  readonly state: string;
  readonly iss?: string;
  readonly code?: string;
  readonly error?: string;
}

export interface GoogleOAuthBoundedBodyReader {
  (
    body: ReadableStream<Uint8Array> | null,
    options: { readonly label: string; readonly max_bytes: number },
  ): Promise<Uint8Array>;
}

/** Parses only the same-origin OAuth begin transport; authorization/configuration remain in Core. */
export async function parseGoogleOAuthBeginTransportInput(input: {
  readonly request: Request;
  readonly read_bounded_body: GoogleOAuthBoundedBodyReader;
  readonly fail: GoogleOAuthTransportInputFailure;
}): Promise<GoogleOAuthBeginTransportInput> {
  const { request, fail } = input;
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") {
    return fail("GOOGLE_OAUTH_ORIGIN_REQUIRED", 400, "Same-origin OAuth begin requires an Origin header");
  }
  if (origin !== expectedOrigin) {
    return fail("GOOGLE_OAUTH_ORIGIN_FORBIDDEN", 403, "Cross-origin OAuth begin is forbidden");
  }
  const referer = request.headers.get("referer");
  if (referer !== null && referer !== expectedOrigin && !referer.startsWith(`${expectedOrigin}/`)) {
    return fail("GOOGLE_OAUTH_ORIGIN_FORBIDDEN", 403, "Cross-origin OAuth begin is forbidden");
  }
  if (request.headers.get("x-eliotr-csrf") !== "1") {
    return fail("GOOGLE_OAUTH_CSRF_REQUIRED", 400, "OAuth begin requires the CSRF header");
  }
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json" || !request.body) {
    return fail("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin requires a JSON body");
  }
  const raw = await input.read_bounded_body(request.body, {
    label: "http.request.google-oauth-begin",
    max_bytes: 1024,
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return fail("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin body is not valid UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, "operation_ref")) {
    return fail("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin accepts only operation_ref");
  }
  let operationRef: string;
  try {
    operationRef = oauthIdentifier((value as Record<string, unknown>).operation_ref);
  } catch (error) {
    if (error instanceof GoogleCredentialError) {
      return fail("GOOGLE_OAUTH_INPUT_INVALID", 400, "OAuth begin operation_ref is invalid");
    }
    throw error;
  }
  return { expected_origin: expectedOrigin, operation_ref: operationRef };
}

const STATE = /^[A-Za-z0-9_-]{43}$/u;
const CALLBACK_ERROR = /^[a-z_]{1,64}$/u;
const CALLBACK_CODE = /^[\x21-\x7e]{1,4096}$/u;
const CALLBACK_SUCCESS_OPTIONAL = new Set(["scope", "authuser", "hd", "prompt"]);
const CALLBACK_ERROR_OPTIONAL = new Set(["error_description", "error_uri"]);
const CALLBACK_OPTIONAL = new Set([...CALLBACK_SUCCESS_OPTIONAL, ...CALLBACK_ERROR_OPTIONAL]);

/** Strictly parses Google's callback query before Core performs any D1 or provider work. */
export function parseGoogleOAuthCallbackTransportInput(input: {
  readonly request_url: string;
  readonly fail: GoogleOAuthTransportInputFailure;
}): GoogleOAuthCallbackTransportInput {
  const { fail } = input;
  const invalid = (): never => fail("GOOGLE_OAUTH_CALLBACK_INVALID", 400, "OAuth callback parameters are invalid");
  const url = new URL(input.request_url);
  const keys = [...url.searchParams.keys()];
  if (keys.length < 2 || keys.length > 9 || new Set(keys).size !== keys.length ||
      !keys.every((key) => key === "state" || key === "iss" || key === "code" || key === "error" || CALLBACK_OPTIONAL.has(key)) ||
      !keys.includes("state") || (keys.includes("code") === keys.includes("error"))) {
    return invalid();
  }
  const one = (key: string): string => {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] === undefined || values[0].length === 0 || /[\u0000-\u001f\u007f]/u.test(values[0])) {
      return invalid();
    }
    return values[0];
  };
  const state = one("state");
  const iss = keys.includes("iss") ? one("iss") : undefined;
  if (!STATE.test(state) || (iss !== undefined && iss !== GOOGLE_OAUTH_ISSUER)) return invalid();
  for (const key of CALLBACK_OPTIONAL) {
    if (!keys.includes(key)) continue;
    const value = one(key);
    if (key === "scope" && value.length > 4096) return invalid();
    if (key === "authuser" && !/^(?:0|[1-9][0-9]{0,2})$/u.test(value)) return invalid();
    if (key === "hd" && (value.length > 255 || !/^[A-Za-z0-9.-]+$/u.test(value))) return invalid();
    if (key === "prompt" && !/^(?:none|consent|select_account)$/u.test(value)) return invalid();
    if (key === "error_description" && value.length > 2048) return invalid();
    if (key === "error_uri") {
      if (value.length > 2048) return invalid();
      try {
        const uri = new URL(value);
        if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash) throw new Error();
      } catch {
        return invalid();
      }
    }
  }
  if (keys.includes("code")) {
    if ([...CALLBACK_ERROR_OPTIONAL].some((key) => keys.includes(key))) return invalid();
    const code = one("code");
    if (!CALLBACK_CODE.test(code)) return invalid();
    return { state, ...(iss === undefined ? {} : { iss }), code };
  }
  if ([...CALLBACK_SUCCESS_OPTIONAL].some((key) => keys.includes(key))) return invalid();
  const error = one("error");
  if (!CALLBACK_ERROR.test(error)) return invalid();
  return { state, ...(iss === undefined ? {} : { iss }), error };
}
