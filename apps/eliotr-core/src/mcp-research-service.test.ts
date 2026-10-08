import { describe, expect, it } from "vitest";
import type { AccessIdentity } from "@eliotr/cloudflare-access";
import type { McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";
import type { Env } from "./env.js";
import { createManagedOAuthOwnerContext } from "./mcp-research-service.js";

const issuer = "https://research-team-example.cloudflareaccess.com";
const deployment = "deployment-1";

function fixture(overrides: {
  readonly identity?: Partial<AccessIdentity>;
  readonly actor?: Partial<NonNullable<McpToolCallContext["verified_actor"]>>;
  readonly principal_ref?: string;
  readonly deployment_generation?: string;
  readonly signal?: AbortSignal;
} = {}) {
  const identity: AccessIdentity = {
    principal_ref: "alice@example.com",
    credential_generation: "cf-access-jwt:key-1:100",
    authentication_method: "cloudflare_access",
    issuer,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides.identity,
  };
  const tool: McpToolCallContext = {
    principal_ref: overrides.principal_ref ?? identity.principal_ref,
    trace_id: "mcp-trace-1",
    deployment_generation: overrides.deployment_generation ?? deployment,
    verified_actor: {
      actor_ref: identity.principal_ref,
      credential_generation: identity.credential_generation,
      authentication_method: identity.authentication_method,
      expires_at: identity.expires_at,
      auth_profile: "managed-oauth",
      deployment_generation: deployment,
      ...overrides.actor,
    },
    verified_access: identity,
  };
  const request = new Request("https://mcp.example/mcp", {
    method: "POST",
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
  const env = { MCP_ACCESS_TEAM_DOMAIN: issuer, DEPLOYMENT_GENERATION: deployment } as Env;
  return { env, request, tool, identity };
}

describe("Managed OAuth owner context bridge", () => {
  it("maps the verified subject to the existing owner_pwa identity and binds the explicit project", () => {
    const state = fixture();
    const context = createManagedOAuthOwnerContext(state.env, state.request, state.tool, {
      project_id: "project-1", idempotency_key: "run-1",
    });
    expect(context).toMatchObject({
      principal_ref: "alice@example.com",
      client_class: "owner_pwa",
      credential_generation: state.identity.credential_generation,
      trace_id: "mcp-trace-1",
      access: {
        principal_ref: "alice@example.com",
        issuer,
        authentication_method: "cloudflare_access",
      },
    });
    expect(context.request.headers.get("idempotency-key")).toBe("run-1");
    expect(context.request.headers.get("x-eliotr-client-grant")).toBeNull();
  });

  it.each([
    ["actor substitution", { principal_ref: "mcp-actor-fake" }],
    ["deployment substitution", { deployment_generation: "other-deployment" }],
  ])("rejects %s", (_label, changes) => {
    const state = fixture(changes);
    expect(() => createManagedOAuthOwnerContext(state.env, state.request, state.tool, { project_id: "project-1" }))
      .toThrow(/current verified MCP user identity/u);
  });

  it.each([
    ["wrong issuer", { issuer: "https://attacker-example.cloudflareaccess.com" }],
    ["service token", { authentication_method: "service_token" as const }],
    ["expired claim", { expires_at: new Date(Date.now() - 1000).toISOString() }],
  ])("rejects %s", (_label, identity) => {
    const state = fixture({ identity });
    expect(() => createManagedOAuthOwnerContext(state.env, state.request, state.tool, { project_id: "project-1" }))
      .toThrow(/current verified MCP user identity/u);
  });

  it("requires a project and denies a cancelled or conflicting request", () => {
    const missingProject = fixture();
    expect(() => createManagedOAuthOwnerContext(missingProject.env, missingProject.request, missingProject.tool, {}))
      .toThrow(/project_id/u);

    const abort = new AbortController(); abort.abort();
    const cancelled = fixture({ signal: abort.signal });
    expect(() => createManagedOAuthOwnerContext(cancelled.env, cancelled.request, cancelled.tool, { project_id: "project-1" }))
      .toThrow(/current verified MCP user identity/u);

    const conflict = fixture();
    const conflictingRequest = new Request(conflict.request.url, {
      method: "POST", headers: { "idempotency-key": "header-key" },
    });
    expect(() => createManagedOAuthOwnerContext(conflict.env, conflictingRequest, conflict.tool, {
      project_id: "project-1", idempotency_key: "body-key",
    })).toThrow(/conflict/u);
  });
});
