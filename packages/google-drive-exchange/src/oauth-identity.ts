import { object } from "./rest-transport.js";
import { GOOGLE_JWKS_URL, readOAuthJson } from "./oauth-transport.js";
import { oauthBase64, oauthClock, oauthFail, type GoogleOAuthIntent } from "./oauth-types.js";

function decode(text: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length > maximum * 2 || !/^[A-Za-z0-9_-]+$/u.test(text)) throw new Error();
  const bytes = Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (bytes.length > maximum || oauthBase64(bytes) !== text) throw new Error();
  return bytes;
}
function jsonPart(text: string | undefined, maximum: number): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decode(text, maximum)));
}
/** Only Google's fixed RS256 key endpoint. No JWT-directed URLs, tokeninfo calls or unverified identity port. */
export async function verifyGoogleIdentity(input: { token: string; accessToken: string; code: string; nonce: string;
  intent: GoogleOAuthIntent; signal: AbortSignal; fetchImpl: typeof fetch; now: () => number }): Promise<void> {
  const { token, accessToken, code, nonce, intent, signal, fetchImpl, now } = input;
  try {
    signal.throwIfAborted();
    if (typeof token !== "string" || token.length > 16384) throw new Error();
    const pieces = token.split("."); if (pieces.length !== 3) throw new Error();
    const header = object(jsonPart(pieces[0], 1024), ["alg", "kid"], ["typ"]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(header.kid)
        || (header.typ !== undefined && header.typ !== "JWT")) throw new Error();
    const claims = object(jsonPart(pieces[1], 8192), ["iss", "aud", "sub", "iat", "exp", "nonce", "email", "email_verified", "at_hash"],
      ["azp", "c_hash", "auth_time", "hd", "name", "given_name", "family_name", "picture", "locale", "nbf"]);
    const checkClaims = () => {
      const current = oauthClock(now) / 1000;
      const client = intent.configuration.oauth_client_id;
      if (!["https://accounts.google.com", "accounts.google.com"].includes(claims.iss as string)
          || !(claims.aud === client || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === client))
          || (claims.azp !== undefined && claims.azp !== client)
          || claims.sub !== intent.configuration.google_subject || claims.email !== intent.configuration.google_email
          || claims.email_verified !== true || claims.nonce !== nonce
          || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
          || (claims.exp as number) <= current || (claims.iat as number) > current + 60
          || (claims.iat as number) < intent.created_at_epoch_ms / 1000 - 60
          || (claims.exp as number) <= (claims.iat as number) || (claims.exp as number) - (claims.iat as number) > 7200
          || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > current))
          || oauthClock(now) >= intent.expires_at_epoch_ms) throw new Error();
    };
    checkClaims();
    const jwks = object(await readOAuthJson(GOOGLE_JWKS_URL, undefined, signal, fetchImpl), ["keys"]);
    if (!Array.isArray(jwks.keys) || jwks.keys.length < 1 || jwks.keys.length > 8) throw new Error();
    const seen = new Set<string>(); let selected: JsonWebKey | undefined;
    for (const entry of jwks.keys) {
      const key = object(entry, ["kty", "kid", "n", "e"], ["alg", "use", "key_ops"]);
      if (typeof key.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(key.kid) || seen.has(key.kid)
          || key.kty !== "RSA" || (key.alg !== undefined && key.alg !== "RS256") || (key.use !== undefined && key.use !== "sig")
          || (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "verify"))) throw new Error();
      seen.add(key.kid);
      if (key.kid === header.kid) {
        const modulus = decode(key.n, 512); const exponent = decode(key.e, 4);
        if (modulus.length < 256 || ((modulus[0] ?? 0) & 128) === 0 || exponent.length !== 3
            || exponent[0] !== 1 || exponent[1] !== 0 || exponent[2] !== 1) throw new Error();
        selected = { kty: "RSA", n: key.n as string, e: key.e as string, alg: "RS256", ext: true, key_ops: ["verify"] };
      }
    }
    if (!selected) throw new Error();
    const key = await crypto.subtle.importKey("jwk", selected, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signature = decode(pieces[2], 512);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature,
      new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`))) throw new Error();
    for (const [name, value] of [["at_hash", accessToken], ["c_hash", code]] as const) {
      if (claims[name] !== undefined) {
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
        if (claims[name] !== oauthBase64(digest.slice(0, 16))) throw new Error();
      }
    }
    signal.throwIfAborted(); checkClaims();
  } catch { return oauthFail("GOOGLE_OAUTH_IDENTITY_REJECTED"); }
}
