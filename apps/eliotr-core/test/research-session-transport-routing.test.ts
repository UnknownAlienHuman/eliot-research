import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";

// Native Worker to native RESEARCH_SESSION Durable Object transport over the real
// /agents/research-session/<id> routing. The outer Access boundary is injected through
// the supported AccessVerifier seam and matches the fixture principal exactly: forged
// caller headers are never honoured, no credential is synthesized and no runtime is
// modified. The RESEARCH_WORKFLOW.get status stub is a simulated dependency that keeps
// the isolated status read on a waiting instance; it is not native Workflow acceptance.
// The RESEARCH_SESSION namespace, its canonical D1 run/scope/grant authority and the
// whole SDK routeAgentRequest dispatch are real.
interface ProjectionReply {
  readonly type: string;
  readonly id: string;
  readonly success: boolean;
  readonly done: boolean;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WebSocketClose {
  readonly code: number;
  readonly reason: string;
}

const ACCESS_EXPIRY_HEADER = "x-research-access-expires-at";
const ACCESS_EXPIRES_AT = "2027-01-01T00:00:00.000Z";

/** Verified Access identity for the exact fixture principal; caller headers are never read. */
function accessVerifierFor(principalRef: string, credentialGeneration: string) {
  return {
    accessVerifier: {
      verify: async () => ({
        principal_ref: principalRef,
        credential_generation: credentialGeneration,
        authentication_method: "cloudflare_access" as const,
        expires_at: ACCESS_EXPIRES_AT,
      }),
    },
  };
}

function serviceVerifierFor(principalRef: string, credentialGeneration: string) {
  return {
    accessVerifier: {
      verify: async () => ({
        principal_ref: principalRef,
        credential_generation: credentialGeneration,
        authentication_method: "service_token" as const,
        expires_at: ACCESS_EXPIRES_AT,
      }),
    },
  };
}

function waitForClose(socket: WebSocket): Promise<WebSocketClose> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("projection socket did not close")), 5_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      const closed = event as CloseEvent;
      resolve({ code: closed.code, reason: closed.reason });
    }, { once: true });
  });
}

async function readProjection(socket: WebSocket, id: string): Promise<ProjectionReply> {
  const reply = await new Promise<unknown>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      clearTimeout(timeout);
      try { resolve(JSON.parse(event.data as string)); }
      catch (error) { reject(error); }
    };
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("projection RPC did not respond"));
    }, 5_000);
    socket.addEventListener("message", onMessage, { once: true });
    socket.send(JSON.stringify({ type: "rpc", id, method: "readResearchSessionProjection", args: [] }));
  });
  const parsed = reply as ProjectionReply;
  if (parsed.id !== id) throw new Error("projection RPC replied with a different request id");
  return parsed;
}

async function runState(
  fixture: Awaited<ReturnType<typeof prepareHistoricalV2Workflow>>,
  operationId: string,
): Promise<{ next_stage_index: number; current_revision: number }> {
  const row = await fixture.db.prepare(
    "SELECT next_stage_index,current_revision FROM research_workflow_run WHERE operation_id=?1",
  ).bind(operationId).first<{ next_stage_index: number; current_revision: number }>();
  if (row === null) throw new Error("canonical run row disappeared");
  return row;
}

function sessionRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://research.example${path}`, headers === undefined ? {} : { headers });
}

function recordRequest(path: string, headers: Record<string, string>): Request {
  return new Request(`https://session.example${path}`, { headers });
}


/**
 * Drive the real Worker HTTP boundary: routeAgentRequest to the native
 * RESEARCH_SESSION Durable Object. Bootstrap runs first so the canonical run is
 * bound into the exact instance the outer route addresses.
 */
async function openNativeProjectionSocket(tag: string) {
  const fixture = await prepareHistoricalV2Workflow(`transport-routing-${tag}-${crypto.randomUUID()}`);
  const operationId = fixture.request.operation_id;
  const runtime = env as unknown as Env;
  const workflowGet = vi.spyOn(runtime.RESEARCH_WORKFLOW, "get")
    .mockImplementation(async (id: string) => ({ id, status: async () => ({ status: "waiting" }) } as never));
  const workflowCreate = vi.spyOn(runtime.RESEARCH_WORKFLOW, "create");
  let socket: WebSocket | undefined;
  try {
    const stub = runtime.RESEARCH_SESSION.get(runtime.RESEARCH_SESSION.idFromName(operationId));
    const before = await runState(fixture, operationId);
    const verifier = accessVerifierFor(fixture.principal.principal_ref, fixture.principal.credential_generation);
    const sessionPath = `/agents/research-session/${operationId}`;

    // The outer route bootstraps the canonical binding before the Durable Object
    // denies plain HTTP: projection transport requires a WebSocket, not chat history.
    const started = await handleHttp(sessionRequest(sessionPath), runtime, {} as ExecutionContext, verifier);
    expect(started.status).toBe(410);
    expect(await started.json()).toMatchObject({ code: "SESSION_PROJECTION_PROTOCOL_REQUIRED" });

    // Real Worker to Durable Object WebSocket upgrade. Forged x-research-* headers
    // must not override the verified owner identity or the derived access expiry.
    const upgrade = await handleHttp(sessionRequest(sessionPath, {
      "x-research-principal": "forged-reader",
      "x-research-credential": "forged-credential",
      "x-research-deployment": "forged-deployment",
      [ACCESS_EXPIRY_HEADER]: "2099-01-01T00:00:00.000Z",
      upgrade: "websocket",
    }), runtime, {} as ExecutionContext, verifier);
    expect(upgrade.status).toBe(101);
    const acceptedSocket = upgrade.webSocket ?? undefined;
    expect(acceptedSocket).toBeDefined();
    if (acceptedSocket === undefined) throw new Error("native transport returned no Agent socket");
    acceptedSocket.accept({ allowHalfOpen: false });
    socket = acceptedSocket;

    return {
      fixture, operationId, stub, socket: acceptedSocket, before,
      verifier, workflowGet, workflowCreate, closeHarness: () => {
        socket?.close();
        workflowGet.mockRestore();
        workflowCreate.mockRestore();
      },
    };
  } catch (error) {
    socket?.close();
    workflowGet.mockRestore();
    workflowCreate.mockRestore();
    throw error;
  }
}

it("routes /agents/research-session/<id> to the native read-only Agent projection and denies caller mutation", async () => {
  const harness = await openNativeProjectionSocket("read-only");
  try {
    const { fixture, operationId, socket, workflowGet, workflowCreate } = harness;
    const expectedProjection = {
      protocol: "eliotr.research-session-projection.v1",
      session_id: operationId,
      operation_id: operationId,
      state: "ACTIVE",
      investigation_ref: {
        id: fixture.session_body.investigation_id,
        revision: fixture.session_body.investigation_revision,
      },
      run_status: {
        execution_state: "ACTIVE",
        engine_status: "waiting",
        next_stage_index: harness.before.next_stage_index,
      },
    };

    const first = await readProjection(socket, "projection-first");
    expect(first).toMatchObject({ type: "rpc", id: "projection-first", success: true, done: true,
      result: expectedProjection });
    // The verified owner reached the Durable Object, not the forged header values,
    // and the stubbed Workflow status is honoured verbatim without a new dispatch.
    expect(workflowGet).toHaveBeenCalledWith(operationId);
    expect(workflowCreate).not.toHaveBeenCalled();

    // The same socket stays a stable projection channel on a repeated read.
    const second = await readProjection(socket, "projection-repeat");
    expect(second).toMatchObject({ type: "rpc", id: "projection-repeat", success: true, done: true,
      result: expectedProjection });
    expect(workflowCreate).not.toHaveBeenCalled();

    // A caller mutation frame on the real Agent socket is denied read-only.
    const closed = waitForClose(socket);
    socket.send(JSON.stringify({
      type: "cf_agent_chat_messages",
      messages: [{ id: "attacker-message", role: "user", parts: [{ type: "text", text: "attacker-marker" }] }],
    }));
    expect(await closed).toEqual({ code: 1008, reason: "SESSION_PROJECTION_READ_ONLY" });

    // Canonical D1 run state and Workflow dispatch are untouched.
    expect(await runState(fixture, operationId)).toEqual(harness.before);
    expect(workflowCreate).not.toHaveBeenCalled();

    const record = await harness.stub.fetch(recordRequest(`/session/${operationId}`, fixture.session_headers));
    expect(record.status).toBe(200);
    expect(await record.json()).toMatchObject({
      protocol: "eliotr.research-session.v1", session_id: operationId, state: "ACTIVE",
    });
  } finally {
    harness.closeHarness();
  }
}, 30_000);

it("rejects an SDK transcript read on the native route without a chat history", async () => {
  const harness = await openNativeProjectionSocket("transcript");
  try {
    const { operationId, fixture } = harness;
    const history = await handleHttp(
      sessionRequest(`/agents/research-session/${operationId}/get-messages`),
      env as unknown as Env,
      {} as ExecutionContext,
      harness.verifier,
    );
    expect(history.status).toBe(410);
    expect(await history.json()).toMatchObject({ code: "SESSION_CHAT_HISTORY_DISABLED" });
    expect(await runState(fixture, operationId)).toEqual(harness.before);
    expect(harness.workflowCreate).not.toHaveBeenCalled();
  } finally {
    harness.closeHarness();
  }
}, 30_000);

it("denies a rotated, foreign or service principal before the native Durable Object namespace is addressed", async () => {
  const fixture = await prepareHistoricalV2Workflow(`transport-routing-denied-${crypto.randomUUID()}`);
  const operationId = fixture.request.operation_id;
  const runtime = env as unknown as Env;
  const idFromName = vi.spyOn(runtime.RESEARCH_SESSION, "idFromName");
  try {
    const sessionPath = `/agents/research-session/${operationId}`;

    // Same principal, rotated credential: the canonical run keeps its original
    // credential generation, so a different Access generation is stale.
    const rotated = await handleHttp(sessionRequest(sessionPath), runtime, {} as ExecutionContext,
      accessVerifierFor(fixture.principal.principal_ref, "rotated-credential-generation"));
    expect(rotated.status).toBe(409);
    expect(await rotated.json()).toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });

    const foreign = await handleHttp(sessionRequest(sessionPath), runtime, {} as ExecutionContext,
      accessVerifierFor("foreign-owner", "foreign-credential-generation"));
    expect(foreign.status).toBe(404);

    // A service principal is not an owner session call on this owner route.
    const service = await handleHttp(sessionRequest(sessionPath), runtime, {} as ExecutionContext,
      serviceVerifierFor(fixture.principal.principal_ref, fixture.principal.credential_generation));
    expect(service.status).toBe(403);

    expect(idFromName).not.toHaveBeenCalled();
    const after = await runState(fixture, operationId);
    expect(after.current_revision).toBe(1);
  } finally {
    idFromName.mockRestore();
  }
}, 30_000);
