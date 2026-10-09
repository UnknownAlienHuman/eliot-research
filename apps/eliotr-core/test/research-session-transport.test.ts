import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { AccessVerificationError, type AccessVerifier } from "@eliotr/cloudflare-access";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";

// This file isolates the outer Access/SDK boundary; canonical bootstrap has its own native D1/DO case.
vi.mock("../src/research-session-bootstrap.js", () => ({ bootstrapResearchSession: vi.fn(async () => null) }));

function transportFixture(response = new Response("[]", { headers: { "content-type": "application/json" } })) {
  const fetch = vi.fn(async (_request: Request) => response);
  const idFromName = vi.fn((name: string) => ({ name }));
  const runtime = { ...env, RESEARCH_SESSION: {
    idFromName, get: vi.fn(() => ({ fetch })),
  } } as unknown as Env;
  const verify = vi.fn(async () => ({
    principal_ref: "owner-transport", credential_generation: "credential-transport",
    authentication_method: "cloudflare_access" as const, expires_at: "2027-01-01T00:00:00.000Z",
  }));
  const send = (path: string, accessVerifier: AccessVerifier = { verify }, headers?: HeadersInit) =>
    handleHttp(new Request(`https://research.example${path}`, headers === undefined ? {} : { headers }), runtime,
      {} as ExecutionContext, { accessVerifier });
  return { runtime, fetch, idFromName, verify, send, response };
}

describe("Research SDK routing through the Access boundary", () => {
  it("forwards history through the official SDK with server identity and no caller lifecycle props", async () => {
    const fixture = transportFixture();
    const result = await fixture.send("/agents/research-session/run-transport/get-messages", undefined, {
      "x-research-principal": "forged-owner", "x-research-credential": "forged-credential",
      "x-research-deployment": "forged-deployment", "x-research-extra": "forged",
      "x-research-access-expires-at": "2099-01-01T00:00:00.000Z",
      "x-agents-lifecycle-props": "forged-props",
    });
    expect(result).toBe(fixture.response);
    expect(fixture.idFromName).toHaveBeenCalledWith("run-transport");
    const forwarded = fixture.fetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("x-research-principal")).toBe("owner-transport");
    expect(forwarded?.headers.get("x-research-credential")).toBe("credential-transport");
    expect(forwarded?.headers.get("x-research-deployment")).toBe(fixture.runtime.DEPLOYMENT_GENERATION);
    expect(forwarded?.headers.get("x-research-access-expires-at")).toBe("2027-01-01T00:00:00.000Z");
    expect(forwarded?.headers.has("x-research-extra")).toBe(false);
    expect(forwarded?.headers.has("x-agents-lifecycle-props")).toBe(false);
    expect(fixture.verify.mock.invocationCallOrder[0]).toBeLessThan(fixture.idFromName.mock.invocationCallOrder[0] ?? 0);
  });

  it("rejects missing Access and service principals before touching the DO namespace", async () => {
    const fixture = transportFixture();
    const denied = await fixture.send("/agents/research-session/run-transport", {
      verify: async () => { throw new AccessVerificationError("ACCESS_JWT_MISSING", "Access token is required"); },
    });
    expect(denied.status).toBe(401);
    const service = await fixture.send("/agents/research-session/run-transport", {
      verify: async () => ({ principal_ref: "service", credential_generation: "service-credential",
        authentication_method: "service_token", expires_at: "2027-01-01T00:00:00.000Z" }),
    });
    expect(service.status).toBe(403);
    expect(fixture.idFromName).not.toHaveBeenCalled();
  });

  it("rejects foreign namespaces and ambiguous session locators without static fallback", async () => {
    const fixture = transportFixture();
    expect((await fixture.send("/agents/other/run-transport")).status).toBe(404);
    expect((await fixture.send("/agents/research-session/run-transport?session_id=foreign")).status).toBe(400);
    expect((await fixture.send("/agents/research-session/run%2Dtransport")).status).toBe(400);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("preserves the native WebSocket upgrade response", async () => {
    const sockets = new WebSocketPair();
    sockets[1].accept();
    const fixture = transportFixture(new Response(null, { status: 101, webSocket: sockets[0] }));
    const response = await fixture.send("/agents/research-session/run-transport", undefined, { upgrade: "websocket" });
    expect(response).toBe(fixture.response);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(sockets[0]);
    sockets[1].close();
  });
});
