import { beforeAll, expect, it } from "vitest";
import { createCloudflareAccessVerifier, type AccessVerifier } from "@eliotr/cloudflare-access";
import { ROUTES } from "@eliotr/interfaces";
import { isAgentTaskHttpOperation } from "@eliotr/cloudflare-http-protocol/agent-task-inbox-input.js";
import { authorize } from "../src/http-request-auth.js";

const issuer = "https://agent-task-fixture.cloudflareaccess.com";
const audience = "agent-task-fixture";
const principal = "agent-task-fixture.access";
const routes = ROUTES.filter(route => isAgentTaskHttpOperation(route.operation));
const computerOperations = new Set([
  "computer-agent-qualifications.confirm",
  "research.computer-agent-dispatches.pull",
  "research.computer-agent-dispatches.accept",
  "research.computer-agent-dispatches.decline",
]);
const computerRoutes = ROUTES.filter(route => computerOperations.has(route.operation));
let verifier: AccessVerifier;
let sign: (servicePrincipal?: string) => Promise<string>;

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "agent-task-key",
    alg: "RS256", use: "sig", key_ops: ["verify"] };
  const now = Math.floor(Date.now() / 1000);
  sign = async servicePrincipal => {
    const header = encode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid })));
    const payload = encode(new TextEncoder().encode(JSON.stringify({ iss: issuer, aud: [audience], type: "app",
      sub: servicePrincipal === undefined ? "owner-fixture" : "", iat: now - 1, exp: now + 600,
      ...(servicePrincipal === undefined ? {} : { common_name: servicePrincipal }) })));
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${encode(new Uint8Array(signature))}`;
  };
  verifier = createCloudflareAccessVerifier({ team_domain: issuer, audience,
    allowed_service_principal_common_names: [principal] }, {
    fetch: async () => Response.json({ keys: [jwk] }),
  });
});

function request(path: string, token: string): Request {
  return new Request(`https://research.example${path}`, { method: "POST",
    headers: { "cf-access-jwt-assertion": token } });
}

it("classifies signed agent-task service JWTs for the existing project-grant authority", async () => {
  expect(routes).toHaveLength(4);
  const token = await sign(principal);
  for (const route of routes) {
    const incoming = request(route.path, token);
    const identity = await verifier.verify(incoming);
    expect(authorize(incoming, route, identity)).toMatchObject({ client_class: "trusted_agent",
      principal_ref: principal, access: { issuer, authentication_method: "service_token" } });
  }
});

it("preserves federation service classification for declared federation routes", async () => {
  const federationRoutes = ROUTES.filter(value => value.auth === "service" && value.operation.startsWith("federation."));
  expect(federationRoutes).toHaveLength(7);
  const token = await sign(principal);
  for (const route of federationRoutes) {
    const incoming = request(route.path, token);
    const identity = await verifier.verify(incoming);
    expect(authorize(incoming, route, identity).client_class).toBe("federation_client");
  }
});

it("classifies signed COMPUTER qualification and dispatch service JWTs for their authority", async () => {
  expect(computerRoutes).toHaveLength(4);
  const token = await sign(principal);
  for (const route of computerRoutes) {
    const incoming = request(route.path, token);
    const identity = await verifier.verify(incoming);
    expect(authorize(incoming, route, identity)).toMatchObject({ client_class: "trusted_agent",
      principal_ref: principal, access: { issuer, authentication_method: "service_token" } });
  }
});

it("rejects a validly signed service principal outside the application allowlist", async () => {
  const route = routes[0];
  if (route === undefined) throw new Error("Agent route missing");
  await expect(verifier.verify(request(route.path, await sign("foreign-agent.access"))))
    .rejects.toMatchObject({ code: "ACCESS_SERVICE_PRINCIPAL_DENIED" });
});

it("rejects an owner JWT on every service-only agent-task route", async () => {
  const token = await sign();
  for (const route of [...routes, ...computerRoutes]) {
    const incoming = request(route.path, token);
    const identity = await verifier.verify(incoming);
    expect(() => authorize(incoming, route, identity)).toThrowError(expect.objectContaining({
      code: "PRINCIPAL_CLASS_DENIED", status: 403,
    }));
  }
});
