import { AccessVerificationError } from "./access.js";

export const OWNER_E2E_ISSUER = ["https://owner-e2e", ".cloudflareaccess.com"].join("");
export const OWNER_E2E_AUDIENCE = "owner-e2e-audience";
export const OWNER_E2E_CERTS_PATH = "/cdn-cgi/access/certs";

type OwnerE2EEnvironment = Readonly<{
  ENVIRONMENT: string;
  ACCESS_TEAM_DOMAIN?: string | undefined;
  ACCESS_AUDIENCE?: string | undefined;
  ACCESS_TEST_JWKS_URL?: string | undefined;
}>;

function failConfig(message: string): never {
  throw new AccessVerificationError("ACCESS_CONFIG_INVALID", message, true);
}

function validatedLoopbackJwksUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { failConfig("Access test JWKS URL is malformed"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" ||
      url.password !== "" || url.pathname !== OWNER_E2E_CERTS_PATH || url.search !== "" ||
      url.hash !== "") {
    failConfig("Access test JWKS URL must be loopback http://127.0.0.1:<port>/cdn-cgi/access/certs");
  }
  const port = Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    failConfig("Access test JWKS port is outside its allowed range");
  }
  return url;
}

export function resolveOwnerE2ETestFetch<Environment extends OwnerE2EEnvironment>(
  env: Environment,
  certsUrl: string,
): typeof fetch | undefined {
  const override = env.ACCESS_TEST_JWKS_URL;
  if (override === undefined || override === "") return undefined;
  if (env.ENVIRONMENT !== "development") {
    failConfig("Access test JWKS override is development-only; staging/production must use the real network verifier");
  }
  if (env.ACCESS_TEAM_DOMAIN !== OWNER_E2E_ISSUER || env.ACCESS_AUDIENCE !== OWNER_E2E_AUDIENCE) {
    failConfig("Access test JWKS override outside the exact owner-e2e profile is denied");
  }
  if (certsUrl !== `${OWNER_E2E_ISSUER}${OWNER_E2E_CERTS_PATH}`) {
    failConfig("Access test profile expects the exact controlled certs URL");
  }
  const target = validatedLoopbackJwksUrl(override);
  const destination = target.toString();
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requested = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (requested !== certsUrl) {
      throw new AccessVerificationError("ACCESS_JWKS_UNAVAILABLE",
        "Access test fetch denies non-certs requests", true);
    }
    void init;
    const response = await globalThis.fetch(destination);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new AccessVerificationError("ACCESS_JWKS_UNAVAILABLE",
        "Access test JWKS redirect denied", true);
    }
    return response;
  };
}
