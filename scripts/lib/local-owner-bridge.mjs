import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readOwnerIdentity, validateWorkerOrigin } from "./local-owner-login.mjs";

const MAX_BODY = 8 * 1024 * 1024;
const SCRIPT = `const secret=location.hash.slice(1);history.replaceState(null,"",location.pathname);
const status=document.getElementById("status");
document.getElementById("connect").onclick=async()=>{try{
const r=await fetch("/__local/pair",{method:"POST",headers:{"X-Eliotr-Pair":secret},credentials:"same-origin"});
if(!r.ok)throw Error();location.replace("/");}catch{status.textContent="Pairing expired or denied. Restart pnpm local:owner.";}};
document.getElementById("logout").onclick=async()=>{await fetch("/__local/logout",{method:"POST"});
status.textContent="Local session closed. Restart pnpm local:owner to sign in again.";};`;
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Eliot local owner session</title><h1>Local owner session</h1>
<p>This pairs this browser with the Access login started in your terminal. It does not grant source access.</p>
<a href="/">Return to Eliot</a> <button id="connect">Open Eliot</button> <button id="logout">Sign out locally</button>
<p id="status">Use the one-time link printed by pnpm local:owner.</p><script>${SCRIPT}</script></html>`;
const CSP = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const equal = (a, b) => typeof a === "string" && typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function headers(response, type = "application/json; charset=utf-8") {
  response.setHeader("content-type", type);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}
function problem(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  headers(response); response.statusCode = status;
  response.end(JSON.stringify({ type: `urn:eliotr:problem:${code.toLowerCase()}`, title: code,
    code, status, trace_id: `local-${randomBytes(12).toString("hex")}`, retryable: status === 503 }));
}
async function boundedBody(stream, signal, maxBytes = MAX_BODY) {
  const chunks = []; let size = 0;
  const abort = () => stream.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("body limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener("abort", abort); }
}
async function responseBody(upstream, maxBytes) {
  const reader = upstream.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0; const chunks = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(chunks);
      size += item.value.byteLength;
      if (size > maxBytes) throw new Error("response limit");
      chunks.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** A local developer tool only. No bridge code or alternate identity issuer enters the Worker bundle. */
export async function startOwnerBridge({ workerOrigin, token, generation, port = 8787,
  fetchImpl = fetch, now = Date.now, lifetimeMs = 15 * 60 * 1000, timeoutMs = 15000 } = {}) {
  validateWorkerOrigin(workerOrigin);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 ||
      !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 900000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error("Invalid local bridge limits");
  // The running Worker verifies signature, issuer, audience, owner class and time. No token claims are trusted here.
  const identity = await readOwnerIdentity(workerOrigin, token, generation, { fetchImpl, now });
  const expiresAt = Math.min(Date.parse(identity.expires_at), now() + lifetimeMs);
  let bearer = token; let pairing = randomBytes(32).toString("base64url"); let session = null;
  const pairingExpires = Math.min(expiresAt, now() + 60000);
  const cookieName = `eliotr_local_${randomBytes(12).toString("hex")}`;
  let origin; let closing = false; let active = 0;
  const invalidate = () => { bearer = null; session = null; pairing = null; };
  const cookie = (value, age) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`;
  const authenticated = (request) => {
    if (now() >= expiresAt) invalidate();
    if (!bearer || !session) return false;
    const values = (request.headers.cookie ?? "").split(";").map((part) => part.trim())
      .filter((part) => part.startsWith(`${cookieName}=`)).map((part) => part.slice(cookieName.length + 1));
    return values.length === 1 && equal(values[0], session);
  };
  const handler = async (request, response) => {
    if (closing || active >= 16) return problem(response, 503, "LOCAL_SESSION_BUSY");
    active += 1;
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.once("close", disconnected);
    try {
      const headerCount = (name) => request.rawHeaders.filter((_, index) => index % 2 === 0)
        .filter((key) => key.toLowerCase() === name).length;
      // Exact Host and Origin prevent DNS rebinding and same-site cross-port credential use.
      if (request.socket.remoteAddress !== "127.0.0.1" || headerCount("host") !== 1 ||
          request.headers.host !== new URL(origin).host || ["origin", "cookie", "x-eliotr-pair"].some((key) => headerCount(key) > 1) ||
          (request.headers.origin !== undefined && request.headers.origin !== origin) ||
          (request.headers["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])) ||
          !request.url?.startsWith("/") || request.url.startsWith("//") || /[\\\u0000-\u0020\u007f]/u.test(request.url) || request.url.length > 4096) {
        return problem(response, 403, "LOCAL_ORIGIN_DENIED");
      }
      const url = new URL(request.url, origin);
      if (url.origin !== origin) return problem(response, 403, "LOCAL_ORIGIN_DENIED");
      if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(request.method)) return problem(response, 405, "LOCAL_METHOD_DENIED");
      const mutation = !["GET", "HEAD"].includes(request.method);
      if (mutation && request.headers.origin !== origin) return problem(response, 403, "LOCAL_ORIGIN_REQUIRED");
      // Never accept caller assertions, bearer headers or forwarded network identity.
      if (Object.keys(request.headers).some((key) => key === "authorization" || key.startsWith("cf-") || key.startsWith("x-forwarded-"))) {
        return problem(response, 403, "LOCAL_CREDENTIAL_SUBSTITUTION");
      }
      const length = request.headers["content-length"];
      if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY)) return problem(response, 413, "LOCAL_BODY_LIMIT");
      if (!mutation && (Number(length ?? 0) !== 0 || request.headers["transfer-encoding"])) return problem(response, 400, "LOCAL_UNEXPECTED_BODY");
      if (url.pathname.startsWith("/__local")) {
        if (url.search || url.hash) return problem(response, 400, "LOCAL_QUERY_DENIED");
        if (url.pathname === "/__local/" && request.method === "GET") {
          headers(response, "text/html; charset=utf-8"); response.setHeader("content-security-policy", CSP);
          return response.end(PAGE);
        }
        if (url.pathname === "/__local/pair" && request.method === "POST") {
          if ((await boundedBody(request, controller.signal, 0)).length || !pairing || now() >= pairingExpires ||
              !equal(request.headers["x-eliotr-pair"], pairing)) return problem(response, 403, "LOCAL_PAIRING_DENIED");
          pairing = null;
          const current = await readOwnerIdentity(workerOrigin, bearer, generation, { fetchImpl, now });
          if (current.principal_ref !== identity.principal_ref || current.credential_generation !== identity.credential_generation) {
            invalidate(); return problem(response, 401, "LOCAL_IDENTITY_CHANGED");
          }
          if (!bearer || now() >= expiresAt || closing) return problem(response, 401, "LOCAL_SESSION_EXPIRED");
          session = randomBytes(32).toString("base64url");
          headers(response); response.setHeader("set-cookie", cookie(session, Math.max(1, Math.floor((expiresAt - now()) / 1000))));
          response.statusCode = 204; return response.end();
        }
        if (url.pathname === "/__local/logout" && request.method === "POST") {
          if (!authenticated(request)) return problem(response, 401, "LOCAL_SESSION_REQUIRED");
          invalidate(); headers(response); response.setHeader("set-cookie", cookie("", 0));
          response.statusCode = 204; return response.end();
        }
        return problem(response, 404, "LOCAL_ROUTE_NOT_FOUND");
      }
      if (!authenticated(request)) return problem(response, 401, "LOCAL_SESSION_REQUIRED");
      const body = mutation ? await boundedBody(request, controller.signal) : undefined;
      const forwarded = new globalThis.Headers();
      for (const name of ["accept", "content-type", "idempotency-key", "range", "if-none-match"]) {
        if (typeof request.headers[name] === "string") forwarded.set(name, request.headers[name]);
      }
      forwarded.set("cf-access-jwt-assertion", bearer);
      // Fixed destination, no redirects and no forwarded cookie. The Worker authenticates every API request.
      const upstream = await fetchImpl(`${workerOrigin}${url.pathname}${url.search}`, {
        method: request.method, headers: forwarded, body, redirect: "manual", signal: controller.signal,
      });
      if (upstream.redirected || (upstream.status >= 300 && upstream.status < 400 && upstream.status !== 304)) {
        return problem(response, 502, "LOCAL_REDIRECT_DENIED");
      }
      if (upstream.status === 401) { invalidate(); return problem(response, 401, "LOCAL_SESSION_REJECTED"); }
      const bytes = await responseBody(upstream, MAX_BODY);
      // A logout or expiry racing the read must not return previously-authorized private content.
      if (!authenticated(request)) return problem(response, 401, "LOCAL_SESSION_EXPIRED");
      headers(response, upstream.headers.get("content-type") ?? "application/octet-stream");
      response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      for (const name of ["content-range", "accept-ranges", "etag"]) {
        if (upstream.headers.has(name)) response.setHeader(name, upstream.headers.get(name));
      }
      response.statusCode = upstream.status; response.end(bytes);
    } catch { problem(response, 502, "LOCAL_REQUEST_FAILED"); }
    finally { clearTimeout(timer); response.removeListener("close", disconnected); active -= 1; }
  };
  const server = createServer({ maxHeaderSize: 32768, requestTimeout: 20000, headersTimeout: 10000 },
    (request, response) => { void handler(request, response); });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const expiryTimer = setTimeout(invalidate, Math.max(1, expiresAt - now())); expiryTimer.unref();
  const close = async () => {
    closing = true; invalidate(); clearTimeout(expiryTimer);
    const done = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections(); await done;
  };
  return { origin, pairingUrl: `${origin}/__local/#${pairing}`, identity, expiresAt, close };
}
