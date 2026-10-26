import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OwnerActor } from "./shared/api";

export type Actor = OwnerActor;

export class AuthError extends Error {
  readonly status: 403 | 503;
  constructor(readonly code: "invalid" | "unavailable", message: string) {
    super(message);
    this.name = "AuthError";
    this.status = code === "invalid" ? 403 : 503;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
let cachedKeys: { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

export async function authenticate(request: Request, env: Env): Promise<Actor> {
  if (env.ELIOT_LOCAL_DEV === "1") {
    // Local workerd also populates request.cf; cf-ray is added at the Cloudflare edge.
    if (!LOOPBACK.has(new URL(request.url).hostname) || request.headers.has("cf-ray")) {
      throw new AuthError("invalid", "Local development access is only available on localhost.");
    }
    return { type: "owner", id: "local-owner", authentication: "local" };
  }

  const team = env.ELIOT_ACCESS_TEAM_DOMAIN.trim();
  const audience = env.ELIOT_ACCESS_AUD.trim();
  const ownerEmail = env.ELIOT_OWNER_EMAIL.trim();
  const ownerToken = env.ELIOT_OWNER_SERVICE_TOKEN.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team)
    || !audience || (!ownerEmail && !ownerToken)) {
    throw new AuthError("unavailable", "Eliot sign-in is not configured.");
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token !== token.trim() || token.length > 16_384) {
    throw new AuthError("invalid", "Sign in with Cloudflare Access to use Eliot.");
  }
  const issuer = `https://${team}`;
  if (cachedKeys?.issuer !== issuer) {
    cachedKeys = { issuer, keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5_000 }) };
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, cachedKeys.keys, {
      issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp"],
    }));
  } catch (error) {
    const unavailable = error instanceof TypeError
      || (error instanceof Error && ["JWKSTimeout", "JWKSInvalid"].includes(error.name));
    throw new AuthError(unavailable ? "unavailable" : "invalid", unavailable
      ? "Eliot could not verify sign-in. Try again."
      : "This sign-in session is invalid. Sign in again.");
  }
  if (payload.type !== undefined && payload.type !== "app") {
    throw new AuthError("invalid", "This sign-in session is invalid. Sign in again.");
  }
  if (ownerEmail && payload.email === ownerEmail) {
    return { type: "owner", id: ownerEmail, email: ownerEmail, authentication: "access" };
  }
  if (ownerToken && payload.common_name === ownerToken) {
    return { type: "owner", id: ownerToken, authentication: "service-token" };
  }
  throw new AuthError("invalid", "This account is not the Eliot owner.");
}

export function assertOrigin(request: Request, env: Env): void {
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (!upgrade && ["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (!env.ELIOT_ORIGIN || request.headers.get("origin") !== env.ELIOT_ORIGIN) {
    throw new AuthError("invalid", "This request was blocked because its origin could not be verified.");
  }
}
