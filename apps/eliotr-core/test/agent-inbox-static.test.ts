import { describe, expect, it } from "vitest";
import { fetchStaticAsset } from "../src/agent-inbox-static.js";

describe("agent inbox static security boundary", () => {
  it.each(["/agent-inbox", "/agent-inbox/", "/agent-inbox/app.js", "/agent-inbox/missing"])(
    "protects %s while retaining the Assets status and body",
    async (path) => {
      const request = new Request(`https://example.invalid${path}`);
      const original = new Response("asset", { status: 404, headers: {
        "Set-Cookie": "unexpected=value", "Content-Type": "text/plain",
      } });
      const response = await fetchStaticAsset(request, { ASSETS: {
        fetch: async () => original,
        connect: () => { throw new Error("socket is outside this asset fixture"); },
      } }, new URL(request.url));
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("asset");
      expect(response.headers.get("Content-Type")).toBe("text/plain");
      expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Set-Cookie")).toBeNull();
    },
  );

  it.each(["/", "/agent-inbox-other", "/agent-inbox.js"])("preserves neighboring asset %s", async (path) => {
    const request = new Request(`https://example.invalid${path}`);
    const original = new Response("ordinary", { headers: { "Cache-Control": "public", "Set-Cookie": "ordinary=value" } });
    const response = await fetchStaticAsset(request, { ASSETS: {
      fetch: async () => original,
      connect: () => { throw new Error("socket is outside this asset fixture"); },
    } }, new URL(request.url));
    expect(response).toBe(original);
    expect(response.headers.get("Content-Security-Policy")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBe("ordinary=value");
  });
});
