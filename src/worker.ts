interface Env {
  ASSETS: Fetcher;
}

const IMMUTABLE_ASSET = /\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

function applySecurityHeaders(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(payload: unknown, status = 200): Response {
  return applySecurityHeaders(
    Response.json(payload, { status }),
    "private, no-store",
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
      const response = json({
        service: "eliot-research",
        status: "ok",
        architecture: "replacement-stage-0",
      });
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "not_found" }, 404);
    }

    const asset = await env.ASSETS.fetch(request);
    const cacheControl = IMMUTABLE_ASSET.test(url.pathname)
      ? "public, max-age=31536000, immutable"
      : "private, no-store";
    return applySecurityHeaders(asset, cacheControl);
  },
} satisfies ExportedHandler<Env>;
