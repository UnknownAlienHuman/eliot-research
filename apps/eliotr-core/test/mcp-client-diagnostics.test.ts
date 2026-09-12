import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";
import {
  MCP_DIAGNOSTIC_TTL_MS,
  McpClientDiagnosticServiceError,
  createD1McpClientDiagnosticService,
} from "@eliotr/cloudflare-workspace-mcp";

const runtime = env as unknown as {
  readonly CORE_DB: D1Database;
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

const BASE_TIME = Date.parse("2026-09-12T12:00:00.000Z");
const DEPLOYMENT_GENERATION = "diagnostic-deployment-v1";
const AUTH_PROFILE = "managed-oauth" as const;

async function prepareDatabase(): Promise<void> {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
}

function identifier(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function contextFor(
  tag: string,
  nowMilliseconds: number,
  overrides: {
    readonly actor_ref?: string;
    readonly principal_ref?: string;
    readonly trace_id?: string;
    readonly deployment_generation?: string;
    readonly auth_profile?: "service-token" | "managed-oauth";
    readonly authentication_method?: "cloudflare_access" | "service_token";
    readonly expires_at?: string;
  } = {},
): McpToolCallContext {
  const actorRef = overrides.actor_ref ?? identifier(`mcp-actor-${tag}`);
  const authProfile = overrides.auth_profile ?? AUTH_PROFILE;
  const authenticationMethod = overrides.authentication_method ?? "cloudflare_access";
  const deploymentGeneration = overrides.deployment_generation ?? DEPLOYMENT_GENERATION;
  const expiresAt = overrides.expires_at ?? new Date(nowMilliseconds + 60 * 60 * 1000).toISOString();
  return Object.freeze({
    principal_ref: overrides.principal_ref ?? actorRef,
    trace_id: overrides.trace_id ?? identifier(`trace-${tag}`),
    deployment_generation: deploymentGeneration,
    verified_actor: Object.freeze({
      actor_ref: actorRef,
      credential_generation: identifier(`mcp-credential-${tag}`),
      authentication_method: authenticationMethod,
      expires_at: expiresAt,
      auth_profile: authProfile,
      deployment_generation: deploymentGeneration,
    }),
  });
}

function ownerFor(tag: string): { readonly principal_ref: string; readonly credential_generation: string } {
  return Object.freeze({
    principal_ref: identifier(`owner-${tag}`),
    credential_generation: `owner-credential-${tag}`,
  });
}

function serviceFor(
  now: { value: number },
  database: D1Database = runtime.CORE_DB,
) {
  return createD1McpClientDiagnosticService(database, {
    now: () => now.value,
    auth_profile: AUTH_PROFILE,
    deployment_generation: DEPLOYMENT_GENERATION,
  });
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

function databaseWithLostRunAcknowledgement(database: D1Database, sqlFragment: string): D1Database {
  let armed = true;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!armed || !sql.includes(sqlFragment)) return prepared;
        return new Proxy(prepared, {
          get(statement, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") {
              const value = Reflect.get(statement, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statement) : value;
            }
            return (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return new Proxy(bound, {
                get(boundStatement, boundProperty, boundReceiver) {
                  if (boundProperty !== "run") {
                    const value = Reflect.get(boundStatement, boundProperty, boundReceiver);
                    return typeof value === "function" ? value.bind(boundStatement) : value;
                  }
                  return async (): Promise<never> => {
                    armed = false;
                    await bound.run();
                    throw new Error("lost acknowledgement");
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as unknown as D1Database;
}

function databaseWithClockAdvanceAfterFirst(
  database: D1Database,
  sqlFragment: string,
  advance: () => void,
): D1Database {
  let armed = true;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!armed || !sql.includes(sqlFragment)) return prepared;
        return new Proxy(prepared, {
          get(statement, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") {
              const value = Reflect.get(statement, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statement) : value;
            }
            return (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return new Proxy(bound, {
                get(boundStatement, boundProperty, boundReceiver) {
                  if (boundProperty !== "first") {
                    const value = Reflect.get(boundStatement, boundProperty, boundReceiver);
                    return typeof value === "function" ? value.bind(boundStatement) : value;
                  }
                  return async <T = Record<string, unknown>>(): Promise<T | null> => {
                    const result = await bound.first<T>();
                    armed = false;
                    advance();
                    return result;
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as unknown as D1Database;
}

function databaseWithClockAdvanceAfterRun(
  database: D1Database,
  sqlFragment: string,
  advance: () => void,
): D1Database {
  let armed = true;
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!armed || !sql.includes(sqlFragment)) return prepared;
        return new Proxy(prepared, {
          get(statement, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") {
              const value = Reflect.get(statement, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statement) : value;
            }
            return (...values: unknown[]) => {
              const bound = statement.bind(...values);
              return new Proxy(bound, {
                get(boundStatement, boundProperty, boundReceiver) {
                  if (boundProperty !== "run") {
                    const value = Reflect.get(boundStatement, boundProperty, boundReceiver);
                    return typeof value === "function" ? value.bind(boundStatement) : value;
                  }
                  return async (): Promise<unknown> => {
                    const result = await bound.run();
                    armed = false;
                    advance();
                    return result;
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as unknown as D1Database;
}

describe("D1 MCP client diagnostics", () => {
  it("issues, isolates, consumes once, and keeps confirmed history", async () => {
    await prepareDatabase();
    const now = { value: BASE_TIME };
    const owner = ownerFor("success");
    const service = serviceFor(now);
    const issued = await service.issue(owner);

    expect(issued.status).toBe("ISSUED");
    expect(issued.challenge_token).toMatch(/^[a-f0-9]{64}$/u);
    const stored = await runtime.CORE_DB.prepare(
      "SELECT token_sha256,state,owner_principal_ref,owner_credential_generation FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1",
    ).bind(issued.challenge_id).first<{
      readonly token_sha256: string;
      readonly state: string;
      readonly owner_principal_ref: string;
      readonly owner_credential_generation: string;
    }>();
    expect(stored).toMatchObject({
      state: "ISSUED",
      owner_principal_ref: owner.principal_ref,
      owner_credential_generation: owner.credential_generation,
    });
    expect(stored?.token_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored?.token_sha256).not.toBe(issued.challenge_token);

    const latest = await service.latest(owner);
    expect(latest).toMatchObject({ status: "ISSUED", challenge_id: issued.challenge_id });
    expect(latest === null || !("challenge_token" in latest)).toBe(true);
    expect(await service.latest(ownerFor("other-owner"))).toBeNull();

    const ownerAndActorDiffer = contextFor("success", now.value);
    expect(ownerAndActorDiffer.principal_ref).not.toBe(owner.principal_ref);
    const consumed = await service.consume({
      challenge_id: issued.challenge_id,
      challenge_token: issued.challenge_token,
    }, ownerAndActorDiffer);
    expect(consumed).toMatchObject({
      status: "CONFIRMED",
      challenge_id: issued.challenge_id,
      auth_profile: AUTH_PROFILE,
      deployment_generation: DEPLOYMENT_GENERATION,
      trace_id: ownerAndActorDiffer.trace_id,
    });
    expect(Object.keys(consumed).sort()).toEqual([
      "auth_profile",
      "challenge_id",
      "deployment_generation",
      "observation_ref",
      "observed_at",
      "protocol",
      "status",
      "trace_id",
    ]);
    expect("verified_actor_ref" in consumed).toBe(false);
    expect("challenge_token" in consumed).toBe(false);

    now.value = Date.parse(issued.expires_at) + 1;
    await expect(service.latest(owner)).resolves.toMatchObject({ status: "CONFIRMED" });
  });

  it("derives expiration without mutating the issued row", async () => {
    await prepareDatabase();
    const now = { value: BASE_TIME + 10_000 };
    const owner = ownerFor("expiry");
    const service = serviceFor(now);
    const issued = await service.issue(owner);
    now.value = Date.parse(issued.expires_at);

    await expectCode(service.consume(
      { challenge_id: issued.challenge_id, challenge_token: issued.challenge_token },
      contextFor("expiry", now.value),
    ), "MCP_DIAGNOSTIC_CHALLENGE_EXPIRED");
    await expect(service.latest(owner)).resolves.toMatchObject({
      status: "EXPIRED",
      challenge_id: issued.challenge_id,
    });
    const row = await runtime.CORE_DB.prepare(
      "SELECT state,observation_ref FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1",
    ).bind(issued.challenge_id).first<{ readonly state: string; readonly observation_ref: string | null }>();
    expect(row).toEqual({ state: "ISSUED", observation_ref: null });
  });

  it("rejects actor, profile, and deployment mismatches before the write", async () => {
    await prepareDatabase();
    const now = { value: BASE_TIME + 20_000 };
    const owner = ownerFor("context");
    const service = serviceFor(now);
    const issued = await service.issue(owner);
    const input = { challenge_id: issued.challenge_id, challenge_token: issued.challenge_token };

    await expectCode(service.consume(input, contextFor("actor-mismatch", now.value, {
      principal_ref: "mcp-outer-principal-mismatch",
    })), "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID");
    await expectCode(service.consume(input, contextFor("profile-mismatch", now.value, {
      auth_profile: "service-token",
      authentication_method: "service_token",
    })), "MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH");
    await expectCode(service.consume(input, contextFor("deployment-mismatch", now.value, {
      deployment_generation: "diagnostic-deployment-stale",
    })), "MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH");
    await expectCode(service.consume(input, contextFor("expired-actor", now.value, {
      expires_at: new Date(now.value).toISOString(),
    })), "MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED");

    const row = await runtime.CORE_DB.prepare(
      "SELECT state,observation_ref FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1",
    ).bind(issued.challenge_id).first<{ readonly state: string; readonly observation_ref: string | null }>();
    expect(row).toEqual({ state: "ISSUED", observation_ref: null });
  });

  it("settles concurrent consume as one confirmation and rejects replay", async () => {
    await prepareDatabase();
    const now = { value: BASE_TIME + 30_000 };
    const owner = ownerFor("race");
    const service = serviceFor(now);
    const issued = await service.issue(owner);
    const input = { challenge_id: issued.challenge_id, challenge_token: issued.challenge_token };
    const firstContext = contextFor("race-a", now.value);
    const secondContext = contextFor("race-b", now.value);
    const outcomes = await Promise.allSettled([
      service.consume(input, firstContext),
      service.consume(input, secondContext),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(McpClientDiagnosticServiceError);
    expect(rejected?.reason).toMatchObject({ code: "MCP_DIAGNOSTIC_CHALLENGE_REPLAY", status: 409 });
    await expectCode(service.consume(input, firstContext), "MCP_DIAGNOSTIC_CHALLENGE_REPLAY");
    const row = await runtime.CORE_DB.prepare(
      "SELECT state,observation_ref,verified_actor_ref FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1",
    ).bind(issued.challenge_id).first<{ readonly state: string; readonly observation_ref: string | null; readonly verified_actor_ref: string | null }>();
    expect(row?.state).toBe("CONFIRMED");
    expect(row?.observation_ref).toMatch(/^mcp-diagnostic-observation-/u);
    expect([firstContext.principal_ref, secondContext.principal_ref]).toContain(row?.verified_actor_ref);
  });

  it("reconciles lost issue and consume acknowledgements through real D1 readback", async () => {
    await prepareDatabase();
    const now = { value: BASE_TIME + 40_000 };
    const issueOwner = ownerFor("lost-issue");
    const flakyIssueDb = databaseWithLostRunAcknowledgement(
      runtime.CORE_DB,
      "INSERT INTO mcp_client_diagnostic_challenge",
    );
    const issueService = serviceFor(now, flakyIssueDb);
    const issued = await issueService.issue(issueOwner);
    const issuedRow = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count,token_sha256 FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1",
    ).bind(issued.challenge_id).first<{ readonly count: number; readonly token_sha256: string }>();
    expect(issuedRow?.count).toBe(1);
    expect(issuedRow?.token_sha256).not.toBe(issued.challenge_token);

    const consumeOwner = ownerFor("lost-consume");
    const normalService = serviceFor(now);
    const consumeIssued = await normalService.issue(consumeOwner);
    const flakyConsumeDb = databaseWithLostRunAcknowledgement(
      runtime.CORE_DB,
      "UPDATE mcp_client_diagnostic_challenge SET state='CONFIRMED'",
    );
    const consumeService = serviceFor(now, flakyConsumeDb);
    const context = contextFor("lost-consume", now.value);
    await expect(consumeService.consume({
      challenge_id: consumeIssued.challenge_id,
      challenge_token: consumeIssued.challenge_token,
    }, context)).resolves.toMatchObject({
      status: "CONFIRMED",
      challenge_id: consumeIssued.challenge_id,
      trace_id: context.trace_id,
    });
    await expect(consumeService.latest(consumeOwner)).resolves.toMatchObject({
      status: "CONFIRMED",
      challenge_id: consumeIssued.challenge_id,
    });
  });

  it("rechecks time after awaited D1/crypto seams before confirming or returning", async () => {
    await prepareDatabase();
    const now = { value: BASE_TIME + 50_000 };
    const owner = ownerFor("clock-cross-consume");
    const normalService = serviceFor(now);
    const issued = await normalService.issue(owner);
    const delayedReadDb = databaseWithClockAdvanceAfterFirst(
      runtime.CORE_DB,
      "SELECT challenge_id,token_sha256",
      () => { now.value = Date.parse(issued.expires_at) + 1; },
    );
    const delayedService = serviceFor(now, delayedReadDb);
    await expectCode(delayedService.consume({
      challenge_id: issued.challenge_id,
      challenge_token: issued.challenge_token,
    }, contextFor("clock-cross-consume", BASE_TIME + 50_000)), "MCP_DIAGNOSTIC_CHALLENGE_EXPIRED");
    await expect(runtime.CORE_DB.prepare(
      "SELECT state,observation_ref FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1 LIMIT 1",
    ).bind(issued.challenge_id).first()).resolves.toEqual({ state: "ISSUED", observation_ref: null });

    now.value = BASE_TIME + 60_000;
    const issueOwner = ownerFor("clock-cross-issue");
    const delayedIssueDb = databaseWithClockAdvanceAfterRun(
      runtime.CORE_DB,
      "INSERT INTO mcp_client_diagnostic_challenge",
      () => { now.value += MCP_DIAGNOSTIC_TTL_MS + 1; },
    );
    const delayedIssueService = serviceFor(now, delayedIssueDb);
    await expectCode(delayedIssueService.issue(issueOwner), "MCP_DIAGNOSTIC_CHALLENGE_EXPIRED");
    await expect(delayedIssueService.latest(issueOwner)).resolves.toMatchObject({ status: "EXPIRED" });
  });

  it("keeps the configured five minute lifetime", async () => {
    expect(MCP_DIAGNOSTIC_TTL_MS).toBe(5 * 60 * 1000);
  });
});
