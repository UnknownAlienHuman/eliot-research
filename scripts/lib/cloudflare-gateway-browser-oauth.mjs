import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

// Cloudflare's public-client PKCE flow. Credentials live only in this process.
// https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
const REDIRECT_URI = "http://127.0.0.1:8977/oauth/callback";
const SCOPE = "aig.read";
const TIMEOUT_MS = 10 * 60 * 1000;

export class GatewayBrowserOAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GatewayBrowserOAuthError";
    this.code = "GATEWAY_BROWSER_OAUTH_FAILED";
  }
}

function fail(message) {
  throw new GatewayBrowserOAuthError(message);
}

function equalState(actual, expected) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false;
  const bytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return bytes.length === expectedBytes.length && timingSafeEqual(bytes, expectedBytes);
}

async function boundedTokenResponse(response) {
  if (!response.ok) fail(`Cloudflare OAuth token exchange returned HTTP ${response.status}`);
  if (!response.body) fail("Cloudflare OAuth token response is empty");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) fail("Cloudflare OAuth token response exceeds the limit");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    fail("Cloudflare OAuth returned an invalid token response");
  }
}

/** Account-private visibility, token_endpoint_auth_method=none (PKCE), AI Gateway Read. */
export async function readGatewayBrowserOAuthBearer(clientId) {
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(clientId)) {
    fail("--gateway-oauth-client-id must be the public ID of a Cloudflare PKCE client");
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = new URL("https://dash.cloudflare.com/oauth2/auth");
  authorization.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI,
    scope: SCOPE, state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();

  let acceptCode;
  let rejectCode;
  const receivedCode = new Promise((resolve, reject) => {
    acceptCode = resolve;
    rejectCode = reject;
  });
  // A timeout can occur while the browser handoff is being printed.
  void receivedCode.catch(() => {});
  let consumed = false;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (request.method !== "GET" || request.headers.host !== "127.0.0.1:8977" ||
        typeof request.url !== "string" || request.url.length > 8192) {
      response.writeHead(400).end("Invalid callback.");
      return;
    }
    const url = new URL(request.url, REDIRECT_URI);
    if (url.origin === "http://127.0.0.1:8977" && url.pathname === "/oauth/complete" && !url.search) {
      response.end("Cloudflare authorization received. Return to Eliot Research setup.");
      return;
    }
    if (url.origin !== "http://127.0.0.1:8977" || url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found.");
      return;
    }
    if (consumed || url.searchParams.getAll("state").length !== 1 ||
        !equalState(url.searchParams.get("state"), state)) {
      response.writeHead(400).end("Invalid or expired OAuth state.");
      return;
    }
    consumed = true;
    const codes = url.searchParams.getAll("code");
    if (url.searchParams.has("error") || codes.length !== 1 ||
        !/^[!-~]{1,4096}$/u.test(codes[0])) {
      response.writeHead(400).end("Cloudflare authorization was not completed.");
      rejectCode(new GatewayBrowserOAuthError("Cloudflare authorization was denied or incomplete"));
      return;
    }
    response.writeHead(303, { Location: "/oauth/complete" }).end();
    acceptCode(codes[0]);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", () => reject(new GatewayBrowserOAuthError("Local OAuth callback could not start on 127.0.0.1:8977")));
      server.listen(8977, "127.0.0.1", resolve);
    });
    timer = setTimeout(() => rejectCode(new GatewayBrowserOAuthError("Cloudflare browser authorization timed out")), TIMEOUT_MS);
    process.stderr.write(`Authorize AI Gateway Read for this setup session:\n${authorization.href}\n`);
    const code = await receivedCode;
    let token;
    try {
      const response = await fetch("https://dash.cloudflare.com/oauth2/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
          redirect_uri: REDIRECT_URI, code, code_verifier: verifier }),
      });
      token = await boundedTokenResponse(response);
    } catch (error) {
      if (error instanceof GatewayBrowserOAuthError) throw error;
      fail("Cloudflare OAuth token exchange did not complete");
    }
    if (token === null || typeof token !== "object" || Array.isArray(token) ||
        typeof token.access_token !== "string" || !/^[!-~]{20,8192}$/u.test(token.access_token) ||
        typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer" ||
        !Number.isSafeInteger(token.expires_in) || token.expires_in < 60 ||
        (token.scope !== undefined && (typeof token.scope !== "string" ||
          token.scope.trim().split(/\s+/u).some((scope) => scope !== SCOPE)))) {
      fail("Cloudflare OAuth did not grant the requested short-lived read credential");
    }
    return token.access_token;
  } finally {
    clearTimeout(timer);
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  }
}
