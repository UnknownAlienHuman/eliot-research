import { Hono } from "hono";
import { AuthError, assertOrigin, authenticate } from "./auth";
import type { Actor } from "./auth";
import type { ApiError, MeResponse } from "./shared/api";

const app = new Hono<{ Bindings: Env; Variables: { actor: Actor } }>();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  await next();
});

app.use("*", async (c, next) => {
  c.set("actor", await authenticate(c.req.raw, c.env));
  assertOrigin(c.req.raw, c.env);
  await next();
});

app.get("/api/me", (c) => c.json({ actor: c.get("actor") } satisfies MeResponse));
app.get("/api/health", (c) => c.json({ service: "eliot-research", status: "ok", contour: "k0" }));
app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "This API route does not exist." } } satisfies ApiError, 404));
app.all("/mcp", (c) => c.json({ error: { code: "not_found", message: "This route does not exist." } } satisfies ApiError, 404));
app.all("*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: { code: "invalid", message: "This route only accepts reading." } } satisfies ApiError, 405);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof AuthError) {
    return c.json({ error: { code: error.code, message: error.message } } satisfies ApiError, error.status);
  }
  console.error("Request failed", error);
  return c.json({ error: { code: "unavailable", message: "Eliot could not complete this request. Try again." } } satisfies ApiError, 503);
});

export default app;
