import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scrubTokenEnv } from "./cloudflare-wrangler-oauth.mjs";

const executeFile = promisify(execFile);
const MAX_BODY = 16 * 1024 * 1024;
const TRAILER = "\nELIOTR_OWNER_HTTP:";

/** Official cloudflared owns login/cache/token injection; callers receive HTTP bytes only. */
export function createCloudflaredOwnerFetch({ origin, binary = "cloudflared", environment = process.env,
  timeoutMs = 15_000, execute = executeFile } = {}) {
  const pinned = new URL(origin);
  if (pinned.protocol !== "https:" || pinned.origin !== origin ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Invalid cloudflared owner HTTP configuration");
  }
  const env = scrubTokenEnv(environment);
  delete env.ELIOTR_ACCESS_SMOKE_COOKIE;
  return async (url, init = {}) => {
    const target = new URL(url);
    const headers = new globalThis.Headers(init.headers);
    if (target.origin !== origin || target.username || target.password || target.search || target.hash ||
        (init.method ?? "GET") !== "GET" || init.body !== undefined ||
        [...headers.keys()].some((key) => key !== "accept") ||
        (target.pathname.startsWith("/api/") && target.pathname !== "/api/v1/system/capabilities")) {
      throw new Error("cloudflared owner HTTP permits exact-origin readbacks only");
    }
    if (init.signal?.aborted) throw new Error("cloudflared owner HTTP aborted");
    const args = ["access", "curl", target.href, "--silent", "--show-error", "--no-location", "--compressed",
      "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))), "--connect-timeout", "10",
      "--max-filesize", String(MAX_BODY), "--request", "GET", "--output", "-",
      "--header", `Accept: ${headers.get("accept") ?? "*/*"}`,
      "--write-out", `${TRAILER}%{http_code}:%{content_type}\n`];
    let stdout;
    try {
      ({ stdout } = await execute(binary, args, { env, encoding: "buffer", shell: false, windowsHide: true,
        timeout: timeoutMs, maxBuffer: MAX_BODY + 1024, signal: init.signal }));
    } catch {
      throw new Error("cloudflared owner HTTP failed or exceeded its deadline");
    }
    if (!Buffer.isBuffer(stdout) || stdout.byteLength > MAX_BODY + 1024) {
      throw new Error("cloudflared owner HTTP response exceeds its limit");
    }
    const split = stdout.lastIndexOf(TRAILER);
    const metadata = split < 0 ? null : /^\nELIOTR_OWNER_HTTP:([2-5][0-9]{2}):([^\r\n]{0,256})\n$/u
      .exec(stdout.subarray(split).toString("utf8"));
    if (!metadata || split > MAX_BODY) throw new Error("cloudflared owner HTTP response is incomplete");
    const status = Number(metadata[1]);
    return new Response([204, 205, 304].includes(status) ? null : stdout.subarray(0, split), {
      status, headers: metadata[2] ? { "content-type": metadata[2] } : {},
    });
  };
}
