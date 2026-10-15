import { reset } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";
import {
  createComputerAgentConnectionService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-connection-store";
import {
  ComputerAgentQualificationError,
  createComputerAgentQualificationService,
  preflightComputerAgentQualificationChallenge,
  requireComputerAgentQualificationChallengeReady,
  type ComputerAgentDiagnosticServiceFactory,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";
import {
  createD1McpClientDiagnosticService,
  createWorkspaceMcpDiagnosticConsume,
  GeminiMcpToolError,
  McpClientDiagnosticServiceError,
} from "@eliotr/cloudflare-workspace-mcp";
import { runScheduledDoctor } from "../src/doctor.js";
import { callMcpDoctorDelivery } from "../src/mcp-doctor-delivery.js";
import { readDoctorMcpSinkState, recordDoctorDeliveryReceipt } from "../src/doctor-delivery.js";
import type { Env } from "../src/env.js";
import { db, principal, runtime, setupOrientationDatabase } from "./orientation-fixture.js";

const CONNECTION_ID = "codex";
const ISSUER = "https://doctor-mcp.cloudflareaccess.com";
const AGENT = "codex-agent.access";
const AGENT_CREDENTIAL = "doctor-mcp-codex-credential-v1";
const REPOSITORY = "owner/repo";
const TOKEN_ONLY_DIGEST = "e028d5a38ec213392b472b071f1284deda0e575b2925e5b74c4a05b485200e7c";
const TOKEN_ONLY_INCIDENT = `doctor-health-${TOKEN_ONLY_DIGEST}`;
const TOKEN_ONLY_DELIVERY = `doctor-${TOKEN_ONLY_DIGEST}`;
const cleanupIncidentIds = new Set<string>([TOKEN_ONLY_INCIDENT]);

let nowMs = Date.now();
const now = () => nowMs;

function ownerContext(key: string): AuthenticatedRequestContext {
  const expiresAt = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString();
  return {
    request: new Request("https://research.example/api/v1/system/computer-agents", {
      method: "POST",
      headers: { "Idempotency-Key": key },
    }),
    principal_ref: principal,
    client_class: "owner_pwa",
    credential_generation: "doctor-mcp-owner-credential",
    trace_id: `doctor-mcp-${key}`,
    access: {
      principal_ref: principal,
      credential_generation: "doctor-mcp-owner-credential",
      authentication_method: "cloudflare_access",
      expires_at: expiresAt,
    },
  };
}

function agentContext(subject = AGENT): AuthenticatedRequestContext {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  return {
    request: new Request("https://mcp.example/mcp", { method: "POST" }),
    principal_ref: subject,
    client_class: "trusted_agent",
    credential_generation: AGENT_CREDENTIAL,
    trace_id: "doctor-mcp-delivery-test",
    access: {
      principal_ref: subject,
      credential_generation: AGENT_CREDENTIAL,
      authentication_method: "service_token",
      issuer: ISSUER,
      expires_at: expiresAt,
    },
  };
}

function mcpContext(): McpToolCallContext {
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  return {
    principal_ref: AGENT,
    trace_id: "doctor-mcp-qualification-test",
    deployment_generation: runtime.DEPLOYMENT_GENERATION,
    verified_actor: {
      actor_ref: AGENT,
      credential_generation: AGENT_CREDENTIAL,
      authentication_method: "service_token",
      expires_at: expiresAt,
      auth_profile: "service-token",
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
    },
    verified_access: {
      principal_ref: AGENT,
      credential_generation: AGENT_CREDENTIAL,
      authentication_method: "service_token",
      issuer: ISSUER,
      expires_at: expiresAt,
    },
  };
}

function doctorEnv(values: Partial<Env> = {}): Env {
  return {
    ...runtime,
    MCP_ACCESS_AUTH_PROFILE: "service-token",
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "doctor-mcp-client.access",
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: [],
    ELIOTR_DOCTOR_AGENT_CONNECTION_ID: CONNECTION_ID,
    ELIOTR_DOCTOR_GITHUB_REPOSITORY: REPOSITORY,
    ...values,
  } as unknown as Env;
}

function fakeAI(answer: string) {
  return { run: vi.fn(async (_model: unknown, _input: unknown, _options: unknown) => ({ response: answer })) };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function prepareQualifiedConnection(): Promise<void> {
  const connection = await createComputerAgentConnectionService({
    database: db,
    trusted_issuers: [ISSUER],
    now,
  }).put(ownerContext("connection"), CONNECTION_ID, {
    display_name: "Codex doctor delivery",
    contour: "OPENAI_DOT",
    actor: { issuer: ISSUER, authentication_method: "service_token", subject: AGENT },
    transport_capabilities: ["MCP_WRITE"],
    computer_capabilities: [],
    task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
    expected_revision: 0,
  });
  expect(connection).toMatchObject({ connection_id: CONNECTION_ID, revision: 1, state: "ENABLED" });

  const diagnosticFactory: ComputerAgentDiagnosticServiceFactory = (input) =>
    createD1McpClientDiagnosticService(input.database, {
      now: input.now,
      auth_profile: input.auth_profile,
      deployment_generation: input.deployment_generation,
    });
  const isDiagnosticError = (error: unknown): error is McpClientDiagnosticServiceError =>
    error instanceof McpClientDiagnosticServiceError;
  const qualifications = createComputerAgentQualificationService({
    database: db,
    deployment_generation: runtime.DEPLOYMENT_GENERATION,
    mcp_auth_profile: "service-token",
    now,
    create_diagnostic_service: diagnosticFactory,
    is_diagnostic_error: isDiagnosticError,
  });
  const challenge = await qualifications.issue(ownerContext("qualification"), CONNECTION_ID, "MCP_WRITE");
  const diagnosticConsume = createWorkspaceMcpDiagnosticConsume({
    database: db,
    auth_profile: "service-token",
    deployment_generation: runtime.DEPLOYMENT_GENERATION,
    preflight_computer_agent_qualification: (input, context) => {
      if (context.verified_actor === undefined) return Promise.resolve(false);
      return preflightComputerAgentQualificationChallenge({
        database: db,
        challenge_id: input.challenge_id,
        transport: "MCP_WRITE",
        issuer: context.verified_access?.issuer,
        subject: context.principal_ref,
        deployment_generation: runtime.DEPLOYMENT_GENERATION,
        now,
      });
    },
    require_computer_agent_qualification_current: async (input, context) => {
      const actor = context.verified_actor;
      if (actor === undefined) return;
      await requireComputerAgentQualificationChallengeReady({
        database: db,
        challenge_id: input.challenge_id,
        transport: "MCP_WRITE",
        credential_generation: actor.credential_generation,
        deployment_generation: runtime.DEPLOYMENT_GENERATION,
        now,
      });
    },
    translate_computer_agent_qualification_error: (error) => error instanceof ComputerAgentQualificationError
      ? new GeminiMcpToolError(error.code, "Computer-agent qualification is not current", error.retryable)
      : undefined,
  });
  await diagnosticConsume({ challenge_id: challenge.challenge_id, challenge_token: challenge.challenge_token }, mcpContext());
}

async function prepareOtherConnection(): Promise<void> {
  await createComputerAgentConnectionService({
    database: db,
    trusted_issuers: [ISSUER],
    now,
  }).put(ownerContext("other-connection"), "other-agent", {
    display_name: "Other MCP agent",
    contour: "OTHER",
    actor: { issuer: ISSUER, authentication_method: "service_token", subject: "other-agent.access" },
    transport_capabilities: ["MCP_WRITE"],
    computer_capabilities: [],
    task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
    expected_revision: 0,
  });
}

async function insertDelivery(digest: string, code: string,
  severity: "WARNING" | "CRITICAL", createdAt: string): Promise<{ incidentId: string; deliveryId: string }> {
  const incidentId = `doctor-health-${digest}`;
  const deliveryId = `doctor-${digest}`;
  const marker = `[eliotr-doctor:${digest}]`;
  await db.prepare("DELETE FROM doctor_delivery_outbox WHERE incident_id=?1").bind(incidentId).run();
  await db.prepare("DELETE FROM incident WHERE incident_id=?1").bind(incidentId).run();
  await db.prepare(
    "INSERT INTO incident(incident_id,severity,kind,state,details_ref,created_at,resolved_at) " +
    "VALUES(?1,?2,?3,'OPEN',?4,?5,NULL)",
  ).bind(incidentId, severity, `DOCTOR_HEALTH_${code}`, `health-code:${code}:${digest.slice(0, 32)}`, createdAt).run();
  await db.prepare(
    "INSERT INTO doctor_delivery_outbox(delivery_id,incident_id,sink_ref,marker,state,diagnosis_state," +
    "diagnosis,created_at,updated_at) VALUES(?1,?2,'github-issue',?3,?4,'COMPLETE',?5,?6,?6)",
  ).bind(deliveryId, incidentId, marker, "PENDING", "Native diagnosis for the fixture incident.", createdAt).run();
  cleanupIncidentIds.add(incidentId);
  return { incidentId, deliveryId };
}

function revokeConnectionBeforeOutboxUpdate(env: Env, marker: string): {
  readonly env: Env;
  readonly wasInjected: () => boolean;
} {
  const originalDatabase = env.CORE_DB;
  let injected = false;
  const database = new Proxy(originalDatabase, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes(marker)) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                run: async () => {
                  if (!injected) {
                    injected = true;
                    await createComputerAgentConnectionService({
                      database: db,
                      trusted_issuers: [ISSUER],
                      now,
                    }).disable(ownerContext("disable-between-preflight-and-update"), CONNECTION_ID, {
                      expected_revision: 1,
                    });
                  }
                  return bound.run();
                },
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  return { env: { ...env, CORE_DB: database }, wasInjected: () => injected };
}

describe("doctor MCP system delivery", () => {
  beforeEach(async () => {
    await reset();
    await setupOrientationDatabase();
    nowMs = Date.now();
    await prepareQualifiedConnection();
  });

  afterAll(async () => {
    for (const incidentId of cleanupIncidentIds) {
      await db.prepare("DELETE FROM doctor_delivery_outbox WHERE incident_id=?1").bind(incidentId).run();
      await db.prepare("DELETE FROM incident WHERE incident_id=?1").bind(incidentId).run();
    }
  });

  it("diagnoses the token-only incident and supersedes it when the selected MCP connection is ready", async () => {
    const ai = fakeAI("Optional GitHub delivery is unconfigured; native doctor remains available.");
    const unconfiguredEnv = doctorEnv({
      AI: ai as unknown as Env["AI"],
      ELIOTR_DOCTOR_AGENT_CONNECTION_ID: undefined,
    });
    const unconfigured = await runScheduledDoctor(unconfiguredEnv, { now: () => nowMs });
    expect(unconfigured.github_sink).toBe("UNCONFIGURED");
    expect(unconfigured.health_status).toBe("DEGRADED");
    expect(unconfigured.diagnosis_attempted).toBe(true);
    expect(ai.run).toHaveBeenCalledOnce();
    expect("ELIOTR_DOCTOR_GITHUB_TOKEN" in unconfiguredEnv).toBe(false);
    const tokenOnly = await db.prepare(
      "SELECT d.state,d.diagnosis_state,d.diagnosis FROM doctor_delivery_outbox d " +
      "WHERE d.delivery_id=?1",
    ).bind(TOKEN_ONLY_DELIVERY).first<{
      readonly state: string;
      readonly diagnosis_state: string;
      readonly diagnosis: string;
    }>();
    expect(tokenOnly).toMatchObject({ state: "UNCONFIGURED", diagnosis_state: "COMPLETE" });
    expect(tokenOnly?.diagnosis).toContain("Optional GitHub delivery");
    const diagnosisRequest = ai.run.mock.calls[0]?.[1] as {
      readonly messages: readonly { readonly content: string }[];
    };
    expect(diagnosisRequest.messages[1]?.content)
      .toBe(JSON.stringify({ health_codes: ["OPTIONAL_CONNECTOR_DEGRADED"] }));
    expect(JSON.stringify(diagnosisRequest.messages)).not.toMatch(/Users|private|secret|token|prompt_body/iu);

    const repeated = await runScheduledDoctor(unconfiguredEnv, { now: () => nowMs + 60_000 });
    expect(repeated.diagnosis_attempted).toBe(false);
    expect(ai.run).toHaveBeenCalledOnce();
    const repeatedCount = await db.prepare(
      "SELECT COUNT(*) AS count FROM doctor_delivery_outbox WHERE incident_id=?1 AND sink_ref='github-issue'",
    ).bind(TOKEN_ONLY_INCIDENT).first<{ readonly count: number }>();
    expect(repeatedCount?.count).toBe(1);
    await prepareOtherConnection();

    const env = doctorEnv();
    const scheduled = await runScheduledDoctor(env, { now: () => nowMs + 120_000 });
    expect(scheduled.github_sink).toBe("READY");
    expect(scheduled.deliveries_examined).toBe(0);
    const superseded = await db.prepare(
      "SELECT i.state AS incident_state,d.state,d.diagnosis_state FROM doctor_delivery_outbox d " +
      "JOIN incident i ON i.incident_id=d.incident_id WHERE d.delivery_id=?1",
    ).bind(TOKEN_ONLY_DELIVERY).first<{
      readonly incident_state: string;
      readonly state: string;
      readonly diagnosis_state: string;
    }>();
    expect(superseded).toEqual({ incident_state: "RESOLVED", state: "SUPERSEDED", diagnosis_state: "COMPLETE" });

    const wrongTargetReadiness = await readDoctorMcpSinkState({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
      repository: REPOSITORY,
      agent_connection_id: "other-agent",
      mcp_auth_profile: "service-token",
      mcp_service_client_id: "doctor-mcp-client.access",
      mcp_service_client_ids: [],
      now_ms: nowMs,
    });
    expect(wrongTargetReadiness).toBe("UNAVAILABLE");
    const missingTargetReadiness = await readDoctorMcpSinkState({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
      repository: REPOSITORY,
      agent_connection_id: undefined,
      mcp_auth_profile: "service-token",
      mcp_service_client_id: "doctor-mcp-client.access",
      mcp_service_client_ids: [],
      now_ms: nowMs,
    });
    expect(missingTargetReadiness).toBe("UNCONFIGURED");
  });

  it("keeps path- and credential-bearing incident details out of native diagnosis and rejects unsafe output", async () => {
    const sourceIncidentId = `doctor-test-${crypto.randomUUID()}`;
    const privateDetail = "C:\\Users\\private\\credential-marker Bearer ghp_DOCTOR_TEST_SECRET";
    await db.prepare(
      "INSERT INTO incident(incident_id,severity,kind,state,details_ref,created_at,resolved_at) " +
      "VALUES(?1,'WARNING','operator-seed','OPEN',?2,?3,NULL)",
    ).bind(sourceIncidentId, privateDetail, new Date(nowMs).toISOString()).run();
    const ai = fakeAI("Unsafe answer C:\\Users\\private\\secret Bearer ghp_DOCTOR_TEST_SECRET");
    const env = doctorEnv({
      AI: ai as unknown as Env["AI"],
      ELIOTR_DOCTOR_AGENT_CONNECTION_ID: undefined,
    });

    const result = await runScheduledDoctor(env, { now: () => nowMs });
    expect(result.diagnosis_attempted).toBe(true);
    expect(ai.run).toHaveBeenCalledOnce();
    const request = ai.run.mock.calls[0]?.[1] as {
      readonly messages: readonly { readonly content: string }[];
    };
    expect(request.messages[1]?.content).toContain("OPEN_INCIDENT");
    expect(JSON.stringify(request.messages)).not.toMatch(/credential-marker|DOCTOR_TEST_SECRET|Bearer|Users|private/iu);

    const unsafeDiagnosis = await db.prepare(
      "SELECT d.diagnosis_state,d.diagnosis FROM doctor_delivery_outbox d " +
      "JOIN incident i ON i.incident_id=d.incident_id " +
      "WHERE i.kind='DOCTOR_HEALTH_OPEN_INCIDENT' AND i.details_ref LIKE 'health-code:OPEN_INCIDENT:%' LIMIT 1",
    ).first<{ readonly diagnosis_state: string; readonly diagnosis: string | null }>();
    expect(unsafeDiagnosis).toEqual({ diagnosis_state: "UNKNOWN", diagnosis: null });
    await db.prepare("DELETE FROM incident WHERE incident_id=?1").bind(sourceIncidentId).run();
  });

  it("pulls from the single D1 outbox and fences receipt by selected agent, lease and idempotency", async () => {
    const env = doctorEnv();
    await prepareOtherConnection();
    const empty = await callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_pull", {
      worker_slot: "codex",
    });
    expect(empty).toEqual({ protocol: "eliotr.doctor-delivery-pull.v1", state: "EMPTY" });
    await expect(callMcpDoctorDelivery(env, agentContext("other-agent.access"),
      "eliotr_doctor_delivery_pull", { worker_slot: "other" }))
      .rejects.toMatchObject({ code: "DOCTOR_DELIVERY_CONNECTION_MISMATCH" });
    await expect(callMcpDoctorDelivery(doctorEnv({ ELIOTR_DOCTOR_AGENT_CONNECTION_ID: undefined }),
      agentContext(), "eliotr_doctor_delivery_pull", { worker_slot: "codex" }))
      .rejects.toMatchObject({ code: "DOCTOR_DELIVERY_TARGET_UNAVAILABLE" });

    const digest = await sha256Hex("doctor-mcp-delivery-actionable-fixture");
    const actionable = await insertDelivery(digest, "OPEN_INCIDENT", "WARNING", new Date(nowMs).toISOString());
    const unregistered = agentContext("unregistered-agent.access");
    await expect(callMcpDoctorDelivery(env, unregistered, "eliotr_doctor_delivery_pull", {
      worker_slot: "codex",
    })).rejects.toMatchObject({ code: "COMPUTER_AGENT_CONNECTION_DENIED" });

    const claimedAt = Date.now();
    const pulled = await callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_pull", {
      worker_slot: "codex",
    }) as {
      readonly state: string;
      readonly item: {
        readonly delivery_id: string;
        readonly marker: string;
        readonly target_repository: string;
        readonly lease: { readonly generation: number; readonly connection_id: string; readonly connection_revision: number };
      };
    };
    expect(pulled).toMatchObject({
      protocol: "eliotr.doctor-delivery-pull.v1",
      state: "LEASED",
      item: {
        delivery_id: actionable.deliveryId,
        marker: `[eliotr-doctor:${digest}]`,
        target_repository: REPOSITORY,
        lease: { generation: 1, connection_id: CONNECTION_ID, connection_revision: 1 },
      },
    });
    const replay = await callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_pull", {
      worker_slot: "codex",
    });
    expect(replay).toEqual(pulled);

    const leaseGeneration = pulled.item.lease.generation;
    const issue = { issue_number: 731, issue_url: "https://github.com/owner/repo/issues/731" };
    await expect(callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_receipt", {
      delivery_id: actionable.deliveryId,
      lease_generation: leaseGeneration,
      worker_slot: "different-slot",
      ...issue,
    })).rejects.toMatchObject({ code: "DOCTOR_DELIVERY_LEASE_STALE" });
    await expect(recordDoctorDeliveryReceipt({
      database: db,
      connection: {
        protocol: "eliotr.computer-agent-connection.v1",
        connection_id: CONNECTION_ID,
        revision: 1,
        owner_principal_ref: principal,
        state: "ENABLED",
        display_name: "Codex doctor delivery",
        contour: "OPENAI_DOT",
        actor: { issuer: ISSUER, authentication_method: "service_token", subject: AGENT },
        transport_capabilities: ["MCP_WRITE"],
        computer_capabilities: [],
        task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
        created_at: new Date(nowMs).toISOString(),
        updated_at: new Date(nowMs).toISOString(),
      },
      target_repository: REPOSITORY,
      delivery_id: actionable.deliveryId,
      lease_generation: leaseGeneration,
      worker_slot: "codex",
      ...issue,
      now: () => claimedAt + 180_001,
    })).rejects.toMatchObject({ code: "DOCTOR_DELIVERY_LEASE_STALE" });

    const receipt = await callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_receipt", {
      delivery_id: actionable.deliveryId,
      lease_generation: leaseGeneration,
      worker_slot: "codex",
      ...issue,
    }) as { readonly protocol: string; readonly state: string; readonly issue_url: string };
    expect(receipt).toMatchObject({
      protocol: "eliotr.doctor-delivery-receipt.v1",
      state: "DELIVERED",
      issue_url: issue.issue_url,
    });
    const duplicate = await callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_receipt", {
      delivery_id: actionable.deliveryId,
      lease_generation: leaseGeneration,
      worker_slot: "codex",
      ...issue,
    });
    expect(duplicate).toMatchObject({ state: "ALREADY_DELIVERED", issue_url: issue.issue_url });
    await expect(callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_receipt", {
      delivery_id: actionable.deliveryId,
      lease_generation: leaseGeneration,
      worker_slot: "codex",
      issue_number: 732,
      issue_url: "https://github.com/owner/repo/issues/732",
    })).rejects.toMatchObject({ code: "DOCTOR_DELIVERY_IDEMPOTENCY_CONFLICT" });

    const stored = await db.prepare(
      "SELECT state,external_issue_number,external_issue_url,lease_generation,lease_owner " +
      "FROM doctor_delivery_outbox WHERE delivery_id=?1",
    ).bind(actionable.deliveryId).first<{
      readonly state: string;
      readonly external_issue_number: number;
      readonly external_issue_url: string;
      readonly lease_generation: number;
      readonly lease_owner: string;
    }>();
    expect(stored).toMatchObject({
      state: "DELIVERED",
      external_issue_number: 731,
      external_issue_url: issue.issue_url,
      lease_generation: 1,
    });
    expect(stored?.lease_owner).toBe("mcp-doctor:5:codex:1:5:codex");
  });

  it("does not lease when the selected connection is disabled after MCP preflight", async () => {
    const env = doctorEnv();
    const digest = await sha256Hex("doctor-mcp-lease-revocation-race");
    const actionable = await insertDelivery(digest, "OPEN_INCIDENT", "WARNING", new Date(nowMs).toISOString());
    const race = revokeConnectionBeforeOutboxUpdate(
      env, "UPDATE doctor_delivery_outbox SET state='UNKNOWN',lease_owner=",
    );

    const result = await callMcpDoctorDelivery(race.env, agentContext(), "eliotr_doctor_delivery_pull", {
      worker_slot: "race",
    });
    expect(race.wasInjected()).toBe(true);
    expect(result).toEqual({ protocol: "eliotr.doctor-delivery-pull.v1", state: "EMPTY" });
    const row = await db.prepare(
      "SELECT state,lease_owner,lease_until,lease_generation FROM doctor_delivery_outbox WHERE delivery_id=?1",
    ).bind(actionable.deliveryId).first<{
      readonly state: string;
      readonly lease_owner: string | null;
      readonly lease_until: number | null;
      readonly lease_generation: number;
    }>();
    expect(row).toEqual({ state: "PENDING", lease_owner: null, lease_until: null, lease_generation: 0 });
    const connection = await db.prepare(
      "SELECT revision,state FROM computer_agent_connection_current WHERE connection_id=?1",
    ).bind(CONNECTION_ID).first<{ readonly revision: number; readonly state: string }>();
    expect(connection).toEqual({ revision: 2, state: "DISABLED" });
  });

  it("does not settle a receipt when the selected connection is disabled after MCP preflight", async () => {
    const env = doctorEnv();
    const digest = await sha256Hex("doctor-mcp-receipt-revocation-race");
    const actionable = await insertDelivery(digest, "OPEN_INCIDENT", "WARNING", new Date(nowMs).toISOString());
    const pulled = await callMcpDoctorDelivery(env, agentContext(), "eliotr_doctor_delivery_pull", {
      worker_slot: "race",
    }) as { readonly item: { readonly lease: { readonly generation: number } } };
    const race = revokeConnectionBeforeOutboxUpdate(
      env, "UPDATE doctor_delivery_outbox SET state='DELIVERED',external_issue_number=",
    );

    await expect(callMcpDoctorDelivery(race.env, agentContext(), "eliotr_doctor_delivery_receipt", {
      delivery_id: actionable.deliveryId,
      lease_generation: pulled.item.lease.generation,
      worker_slot: "race",
      issue_number: 811,
      issue_url: "https://github.com/owner/repo/issues/811",
    })).rejects.toMatchObject({ code: "DOCTOR_DELIVERY_LEASE_STALE" });
    expect(race.wasInjected()).toBe(true);
    const row = await db.prepare(
      "SELECT state,external_issue_number,external_issue_url,lease_generation FROM doctor_delivery_outbox " +
      "WHERE delivery_id=?1",
    ).bind(actionable.deliveryId).first<{
      readonly state: string;
      readonly external_issue_number: number | null;
      readonly external_issue_url: string | null;
      readonly lease_generation: number;
    }>();
    expect(row).toEqual({
      state: "UNKNOWN",
      external_issue_number: null,
      external_issue_url: null,
      lease_generation: pulled.item.lease.generation,
    });
  });
});
