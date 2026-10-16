import { reset } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { INSTALLED_INQUIRY_PROTOCOL_REFS } from "@eliotr/cloudflare-research";
import {
  ComputerAgentDispatchDeclineReceiptSchema,
  type ComputerAgentDispatch,
} from "@eliotr/contracts";
import { createProjectClientGrantService } from "@eliotr/cloudflare-navigation";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import {
  createD1McpClientDiagnosticService,
  McpClientDiagnosticServiceError,
} from "@eliotr/cloudflare-workspace-mcp";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  createComputerAgentConnectionService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-connection-store";
import {
  createComputerAgentDispatchAbandonmentService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-abandonment";
import {
  createComputerAgentDispatchService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-store";
import {
  confirmWebInboxComputerAgentQualification,
  createComputerAgentQualificationService,
  type ComputerAgentDiagnosticServiceFactory,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-store";
import {
  createProjectComputerAgentRouteService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-route-store";
import { handleHttp } from "../src/http.js";
import { parseResearchRunRequest } from "../src/research-run-service.js";
import { db, principal, runtime, setupOrientationDatabase, verifier } from "./orientation-fixture.js";

const PROJECT_ID = "dispatch-list-native-project";
const SECOND_PROJECT_ID = "dispatch-list-native-other-project";
const CONNECTION_ID = "dispatch-list-native-connection";
const GRANT_ID = "dispatch-list-native-grant";
const ISSUER = "https://dispatch-list-native-example.cloudflareaccess.com";
const AGENT = "dispatch-list-native-agent.access";
const AGENT_CREDENTIAL = "dispatch-list-native-credential";
const A = "a".repeat(64);

let nowMs = Date.now();
const now = () => nowMs;

function ownerContext(key: string, signal?: AbortSignal): AuthenticatedRequestContext {
  const expiresAt = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString();
  return {
    request: new Request("https://research.example/api/v1/research/projects", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      ...(signal === undefined ? {} : { signal }),
    }),
    principal_ref: principal,
    client_class: "owner_pwa",
    credential_generation: "credential-v1",
    trace_id: `dispatch-list-${key}`,
    access: {
      principal_ref: principal,
      credential_generation: "credential-v1",
      authentication_method: "cloudflare_access",
      expires_at: expiresAt,
    },
  };
}

async function seedProject(projectId: string): Promise<void> {
  const timestamp = new Date(nowMs).toISOString();
  await db.prepare("INSERT INTO project " +
    "(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) " +
    "VALUES (?1,?2,'private','retention-default','source-policy-default','model-default','depth-default',1,?3)")
    .bind(projectId, projectId, timestamp).run();
  await db.prepare("INSERT INTO project_owner " +
    "(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)")
    .bind(projectId, principal, runtime.DEPLOYMENT_GENERATION, timestamp).run();
}

async function ownerGet(path: string): Promise<Response> {
  return handleHttp(new Request(`https://research.example${path}`), runtime,
    {} as ExecutionContext, { accessVerifier: verifier() });
}

async function responseData<T>(response: Response): Promise<T> {
  const value = await response.json() as { readonly data?: T };
  if (value.data === undefined) throw new Error(`HTTP ${response.status} response has no data`);
  return value.data;
}

describe("native owner computer-agent dispatch listing", () => {
  beforeAll(async () => {
    await reset();
    await setupOrientationDatabase();
  });

  it("pages the ledger, projects only safe fields, and fails closed on lost authority or terminal corruption", async () => {
    nowMs = Date.now();
    await seedProject(PROJECT_ID);

    const owner = ownerContext("dispatch-list-owner");
    const connections = createComputerAgentConnectionService({
      database: db,
      trusted_issuers: [ISSUER],
      now,
    });
    const connection = await connections.put(owner, CONNECTION_ID, {
      display_name: "Native listing fixture",
      contour: "OTHER",
      actor: { issuer: ISSUER, authentication_method: "service_token", subject: AGENT },
      transport_capabilities: ["WEB_INBOX"],
      computer_capabilities: ["CLOUD_BROWSER"],
      task_kinds: ["RESEARCH_BRANCH_ANALYSIS"],
      expected_revision: 0,
    });

    const routes = createProjectComputerAgentRouteService({ database: db, now });
    await routes.put(ownerContext("dispatch-list-route"), PROJECT_ID, "RESEARCH_BRANCH_ANALYSIS", {
      strategy: "ORIGINATING_MATCH",
      connections: [{ connection_id: connection.connection_id, connection_revision: connection.revision }],
      expected_revision: 0,
    });

    const grantExpiresAt = new Date(nowMs + 6 * 60 * 60 * 1000).toISOString();
    const grants = createProjectClientGrantService({
      database: db,
      trusted_issuers: [ISSUER],
      now,
      authorize_spend: async () => ({
        policy_protocol: "eliotr.research-owner-spend-template.v1",
        policy_sha256: A,
        deployment_generation: runtime.DEPLOYMENT_GENERATION,
        expires_at: new Date(nowMs + 7 * 60 * 60 * 1000).toISOString(),
      }),
    });
    await grants.put(ownerContext("dispatch-list-grant"), PROJECT_ID, GRANT_ID, {
      grantee: { issuer: ISSUER, authentication_method: "service_token", subject: AGENT },
      allowed_operations: ["run", "recover", "evidence"],
      ingest_namespace_ids: [],
      spend_policy_ref: "dispatch-list-spend-policy",
      expires_at: grantExpiresAt,
      expected_revision: 0,
    });

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
      now,
      create_diagnostic_service: diagnosticFactory,
      is_diagnostic_error: isDiagnosticError,
    });
    const challenge = await qualifications.issue(
      ownerContext("dispatch-list-qualification"), CONNECTION_ID, "WEB_INBOX",
    );
    const agentContext: AuthenticatedRequestContext = {
      request: new Request("https://research.example/api/v1/computer-agents/qualifications/confirm", {
        method: "POST",
      }),
      principal_ref: AGENT,
      client_class: "trusted_agent",
      credential_generation: AGENT_CREDENTIAL,
      trace_id: "dispatch-list-agent-confirm",
      access: {
        principal_ref: AGENT,
        credential_generation: AGENT_CREDENTIAL,
        authentication_method: "service_token",
        issuer: ISSUER,
        expires_at: grantExpiresAt,
      },
    };
    await confirmWebInboxComputerAgentQualification({
      database: db,
      context: agentContext,
      body: { challenge_id: challenge.challenge_id, challenge_token: challenge.challenge_token },
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
      now,
      create_diagnostic_service: diagnosticFactory,
      is_diagnostic_error: isDiagnosticError,
    });

    const dispatchService = createComputerAgentDispatchService({
      database: db,
      deployment_generation: runtime.DEPLOYMENT_GENERATION,
    }, {
      now,
      start_run: async () => { throw new Error("listing fixture must not start a Research run"); },
      parse_run_request: parseResearchRunRequest,
      is_run_request_input_error: () => false,
      is_research_run_service_error: (_error): _error is {
        readonly code: string;
        readonly status: number;
        readonly retryable: boolean;
      } => false,
    });
    const runRequest = {
      query: "User approved dispatch listing question",
      product: "RESEARCH" as const,
      scope_expression: { kind: "PROJECT" as const, project_id: PROJECT_ID },
      literals: [],
      evidence_grade: "E1" as const,
      budget_ref: "research-budget-v1",
      max_results: 4,
      request_version: "eliotr.research-run-request.v2" as const,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
    };
    const dispatches: ComputerAgentDispatch[] = [];
    for (let index = 0; index < 21; index += 1) {
      dispatches.push(await dispatchService.create(ownerContext(`dispatch-list-${index}`), PROJECT_ID, {
        transport: "WEB_INBOX",
        expected_route_revision: 1,
        connection_id: CONNECTION_ID,
        connection_revision: connection.revision,
        client_grant_id: GRANT_ID,
        client_grant_revision: 1,
        expires_in_seconds: 3600,
        run_request: runRequest,
      }));
    }

    const basePath = `/api/v1/research/projects/${PROJECT_ID}/computer-agent-dispatches`;
    const firstResponse = await ownerGet(basePath);
    expect(firstResponse.status).toBe(200);
    const firstPage = await responseData<{
      readonly items: readonly Record<string, unknown>[];
      readonly next_after_dispatch_id: string | null;
    }>(firstResponse);
    expect(firstPage.items).toHaveLength(20);
    const deadlineDispatchId = String(firstPage.items[0]?.dispatch_id);
    expect(firstPage.next_after_dispatch_id).toBe(firstPage.items.at(-1)?.dispatch_id);
    expect(firstPage.items[0]).toMatchObject({
      project_id: PROJECT_ID,
      connection_id: CONNECTION_ID,
      connection_revision: 1,
      state: "PENDING",
      question_preview: runRequest.query,
      question_utf8_bytes: new TextEncoder().encode(runRequest.query).byteLength,
      question_truncated: false,
      accepted_workflow: null,
    });
    expect(firstPage.items[0]).not.toHaveProperty("run_request");
    expect(firstPage.items[0]).not.toHaveProperty("client_grant_id");
    expect(firstPage.items[0]).not.toHaveProperty("owner_principal_ref");
    expect(firstPage.items[0]).not.toHaveProperty("actor");
    expect(firstPage.items[0]).not.toHaveProperty("qualification");
    expect(JSON.stringify(firstPage)).not.toContain("owner_credential_generation");

    const cursor = firstPage.next_after_dispatch_id;
    if (cursor === null) throw new Error("first full page must have a next cursor");
    const secondResponse = await ownerGet(`${basePath}?after_dispatch_id=${encodeURIComponent(cursor)}`);
    expect(secondResponse.status).toBe(200);
    const secondPage = await responseData<{
      readonly items: readonly Record<string, unknown>[];
      readonly next_after_dispatch_id: string | null;
    }>(secondResponse);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.next_after_dispatch_id).toBeNull();
    const lastDispatchId = String(secondPage.items[0]?.dispatch_id);
    const lastDispatch = dispatches.find((dispatch) => dispatch.dispatch_id === lastDispatchId);
    if (lastDispatch === undefined) throw new Error("native D1 page returned an unknown dispatch");

    await seedProject(SECOND_PROJECT_ID);
    await routes.put(ownerContext("dispatch-list-second-route"), SECOND_PROJECT_ID,
      "RESEARCH_BRANCH_ANALYSIS", {
        strategy: "ORIGINATING_MATCH",
        connections: [{ connection_id: connection.connection_id, connection_revision: connection.revision }],
        expected_revision: 0,
      });
    const foreignCursor = await ownerGet(
      `/api/v1/research/projects/${SECOND_PROJECT_ID}/computer-agent-dispatches?after_dispatch_id=${encodeURIComponent(cursor)}`,
    );
    expect(foreignCursor.status).toBe(400);
    const duplicateCursor = await ownerGet(`${basePath}?after_dispatch_id=${encodeURIComponent(cursor)}&after_dispatch_id=${encodeURIComponent(cursor)}`);
    expect(duplicateCursor.status).toBe(400);
    const unknownQuery = await ownerGet(`${basePath}?include_payload=true`);
    expect(unknownQuery.status).toBe(400);
    const foreignOwner = await handleHttp(new Request(`https://research.example${basePath}`), runtime,
      {} as ExecutionContext, { accessVerifier: verifier("dispatch-list-foreign-owner") });
    expect(foreignOwner.status).toBe(409);
    expect(await foreignOwner.json()).toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE" });

    const abort = new AbortController();
    abort.abort();
    await expect(dispatchService.list(ownerContext("dispatch-list-cancelled", abort.signal), PROJECT_ID))
      .rejects.toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_OWNER_REQUIRED", status: 403 });

    const abandonment = createComputerAgentDispatchAbandonmentService({ database: db, now });
    await abandonment.abandon(ownerContext("dispatch-list-abandon"), PROJECT_ID, lastDispatchId,
      { reason: "OWNER_REASSIGNMENT" });
    const abandonedResponse = await ownerGet(`${basePath}?after_dispatch_id=${encodeURIComponent(cursor)}`);
    expect(abandonedResponse.status).toBe(200);
    expect((await responseData<{ readonly items: readonly Record<string, unknown>[] }>(abandonedResponse))
      .items[0]).toMatchObject({ dispatch_id: lastDispatchId, state: "ABANDONED", accepted_workflow: null });

    const deadlineDispatch = dispatches.find((dispatch) =>
      dispatch.dispatch_id === deadlineDispatchId);
    if (deadlineDispatch === undefined) throw new Error("deadline dispatch is missing from the fixture");
    nowMs = Date.parse(deadlineDispatch.expires_at) + 1;
    const expiredPage = await dispatchService.list(ownerContext("dispatch-list-expired"), PROJECT_ID);
    expect(expiredPage.items.find((item) => item.dispatch_id === deadlineDispatchId)?.state).toBe("EXPIRED");

    nowMs = Date.now();
    await grants.revoke(ownerContext("dispatch-list-revoke"), PROJECT_ID, GRANT_ID,
      { expected_revision: 1 });
    const revokedResponse = await ownerGet(basePath);
    expect(revokedResponse.status).toBe(200);
    const revokedPage = await responseData<{ readonly items: readonly Record<string, unknown>[] }>(revokedResponse);
    expect(revokedPage.items.every((item) => item.state === "STALE")).toBe(true);

    const decline = ComputerAgentDispatchDeclineReceiptSchema.parse({
      protocol: "eliotr.computer-agent-dispatch-declined.v1",
      dispatch_id: lastDispatch.dispatch_id,
      project_id: lastDispatch.project_id,
      connection_id: lastDispatch.connection_id,
      connection_revision: lastDispatch.connection_revision,
      actor: lastDispatch.actor,
      credential_generation: lastDispatch.qualification.verified_credential_generation,
      reason: "UNAVAILABLE",
      idempotency_key: "dispatch-list-conflicting-decline",
      request_sha256: A,
      declined_at: new Date(nowMs + 1).toISOString(),
    });
    const declineJson = canonicalJson(decline);
    await db.prepare("DROP TRIGGER computer_agent_dispatch_decline_insert_guard").run();
    await db.prepare("INSERT INTO computer_agent_dispatch_decline(" +
      "dispatch_id,project_id,connection_id,connection_revision,actor_issuer,actor_subject," +
      "credential_generation,reason,note,idempotency_key,request_sha256,record_json,record_sha256,declined_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,?9,?10,?11,?12,?13)")
      .bind(decline.dispatch_id, decline.project_id, decline.connection_id,
        decline.connection_revision, decline.actor.issuer, decline.actor.subject,
        decline.credential_generation, decline.reason, decline.idempotency_key,
        decline.request_sha256, declineJson, await sha256Utf8(declineJson), decline.declined_at).run();
    const conflictingTerminals = await ownerGet(`${basePath}?after_dispatch_id=${encodeURIComponent(cursor)}`);
    expect(conflictingTerminals.status).toBe(500);
    expect(await conflictingTerminals.json()).toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_STORAGE_CORRUPT" });

    const originalDispatch = dispatches[0];
    if (originalDispatch === undefined) throw new Error("native fixture did not create a dispatch");
    const foreignDispatch: ComputerAgentDispatch = {
      ...originalDispatch,
      dispatch_id: "zz-foreign-owner-row",
      owner_principal_ref: "another-project-owner",
      owner_credential_generation: "another-owner-credential",
    };
    const foreignJson = canonicalJson(foreignDispatch);
    await db.prepare("DROP TRIGGER computer_agent_dispatch_insert_guard").run();
    await db.prepare("INSERT INTO computer_agent_dispatch(" +
      "dispatch_id,project_id,task_kind,transport,route_revision,priority,connection_id," +
      "connection_revision,client_grant_id,client_grant_revision,owner_principal_ref," +
      "owner_credential_generation,actor_issuer,actor_subject,qualification_challenge_id," +
      "qualification_observation_ref,qualification_credential_generation,deployment_generation," +
      "idempotency_key,request_sha256,run_request_sha256,record_json,record_sha256,created_at,expires_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)")
      .bind(foreignDispatch.dispatch_id, foreignDispatch.project_id, foreignDispatch.task_kind,
        foreignDispatch.transport, foreignDispatch.route_revision, foreignDispatch.priority,
        foreignDispatch.connection_id, foreignDispatch.connection_revision,
        foreignDispatch.client_grant_id, foreignDispatch.client_grant_revision,
        foreignDispatch.owner_principal_ref, foreignDispatch.owner_credential_generation,
        foreignDispatch.actor.issuer, foreignDispatch.actor.subject,
        foreignDispatch.qualification.challenge_id, foreignDispatch.qualification.observation_ref,
        foreignDispatch.qualification.verified_credential_generation,
        foreignDispatch.qualification.deployment_generation, "foreign-owner-list-key", A,
        foreignDispatch.run_request_sha256, foreignJson, await sha256Utf8(foreignJson),
        foreignDispatch.created_at, foreignDispatch.expires_at).run();
    const foreignRow = await ownerGet(
      `${basePath}?after_dispatch_id=${encodeURIComponent(lastDispatchId)}`,
    );
    expect(foreignRow.status).toBe(409);
    expect(await foreignRow.json()).toMatchObject({ code: "COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE" });
  });
});
