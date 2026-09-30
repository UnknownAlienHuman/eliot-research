import type { Env } from "./env.js";

const AGENT_INBOX_PREFIX = "/agent-inbox/";
const AGENT_INBOX_CSP = [
  "default-src 'none'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "manifest-src 'none'",
  "worker-src 'none'",
  "require-trusted-types-for 'script'",
].join("; ");

/**
 * Preserve ordinary static responses exactly. The public computer-agent shell
 * receives a no-store, non-embeddable browser boundary without widening Access
 * or changing API authentication.
 */
export async function fetchStaticAsset(
  request: Request,
  env: Pick<Env, "ASSETS">,
  url: URL,
): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!url.pathname.startsWith(AGENT_INBOX_PREFIX)) return response;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Content-Security-Policy", AGENT_INBOX_CSP);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Permissions-Policy", [
    "camera=()", "microphone=()", "geolocation=()", "display-capture=()",
    "clipboard-read=()", "clipboard-write=()", "payment=()", "usb=()",
    "serial=()", "hid=()", "interest-cohort=()",
  ].join(", "));
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.delete("Set-Cookie");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
