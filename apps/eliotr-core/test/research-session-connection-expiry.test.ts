import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Connection } from "agents";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { ResearchSession } from "../src/research-session.js";
import type { SessionChatConnectionState } from "../src/research-session-chat-authority.js";
import { requireCurrentSessionConnection } from "../src/research-session-connection-authority.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";

const bindings = env as unknown as Env;
const EXPIRY_HEADER = "x-research-access-expires-at";
const CLOSE_TIMEOUT_MS = 5_000;

interface ResumableChatStreamHarness {
  start(requestId: string, options?: { messageId?: string }): string;
  storeChunk(streamId: string, body: string): number | undefined;
  flushBuffer(): void;
  hasActiveStream(): boolean;
  activeRequestId: string | null;
  complete(streamId: string): void;
}

interface ChatStreamHarness {
  _resumableStream: ResumableChatStreamHarness;
}

interface ObservedSocket {
  readonly frames: string[];
  readonly closed: Promise<{ code: number; reason: string }>;
}

function currentExpiry(): string {
  return new Date(Date.now() + 60 * 60 * 1_000).toISOString();
}

function pastExpiry(): string {
  return new Date(Date.now() - 60 * 1_000).toISOString();
}

function observe(socket: WebSocket): ObservedSocket {
  const frames: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) => {
      const close = event as CloseEvent;
      resolve({ code: close.code, reason: close.reason });
    }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(event.data);
  });
  return { frames, closed };
}

async function waitForClose(observed: ObservedSocket): Promise<{ code: number; reason: string }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    observed.closed,
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), CLOSE_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (result === null) throw new Error("expired research session socket did not close");
  return result;
}

function researchSession(instance: unknown): ResearchSession {
  return instance as ResearchSession;
}

function connectionFor(instance: unknown, id: string): Connection<SessionChatConnectionState> {
  const connection = researchSession(instance).getConnection<SessionChatConnectionState>(id);
  if (connection === undefined) throw new Error(`research session connection ${id} is absent`);
  return connection;
}

async function connectedState(stub: DurableObjectStub): Promise<{
  id: string;
  state: SessionChatConnectionState | null | undefined;
}> {
  return runInDurableObject(stub, (instance) => {
    const connections = Array.from(researchSession(instance).getConnections<SessionChatConnectionState>());
    if (connections.length !== 1) throw new Error(`expected one accepted socket, found ${connections.length}`);
    const connection = connections[0];
    if (connection === undefined) throw new Error("accepted research session socket is absent");
    return { id: connection.id, state: connection.state };
  });
}

async function openSocket(
  stub: DurableObjectStub,
  sessionId: string,
  headers: Record<string, string>,
  expiresAt: string,
): Promise<WebSocket> {
  const response = await stub.fetch(new Request(
    `https://session.example/status?session_id=${encodeURIComponent(sessionId)}`,
    {
      headers: {
        ...headers,
        [EXPIRY_HEADER]: expiresAt,
        upgrade: "websocket",
      },
    },
  ));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).not.toBeNull();
  if (socket === null) throw new Error("native Agent websocket upgrade returned no socket");
  // An in-process Worker test has to accept the returned peer explicitly.
  // Keep the normal close handshake enabled so server close frames are ACKed;
  // otherwise this endpoint can remain half-open unlike a browser client.
  socket.accept({ allowHalfOpen: false });
  return socket;
}

async function setConnectionExpiry(stub: DurableObjectStub, connectionId: string, expiresAt: string): Promise<void> {
  await runInDurableObject(stub, (instance) => {
    const connection = connectionFor(instance, connectionId);
    connection.setState((previous) => ({
      ...(previous ?? {}),
      research_access_expires_at: expiresAt,
    }));
  });
}

async function expectClosedWithoutMarker(
  stub: DurableObjectStub,
  connectionId: string,
  observed: ObservedSocket,
  marker: string,
): Promise<void> {
  expect(await waitForClose(observed)).toEqual({ code: 1008, reason: "SESSION_AUTHORITY_STALE" });
  expect(observed.frames.join("\n")).not.toContain(marker);
  const remaining = await runInDurableObject(stub, (instance) =>
    Array.from(researchSession(instance).getConnections<SessionChatConnectionState>(), (connection) => connection.id));
  expect(remaining).not.toContain(connectionId);
}

it("enforces expiry for SDK frames, scheduled callbacks, restored sockets, and guarded sends", async () => {
  const fixture = await prepareHistoricalV2Workflow(`session-expiry-${crypto.randomUUID().replaceAll("-", "")}`);
  const sessionId = fixture.session_body.session_id;
  const workflow = bindings.RESEARCH_WORKFLOW;
  const get = vi.spyOn(workflow, "get").mockImplementation(async (id) => ({
    id,
    status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(workflow, "create");
  const namespace = bindings.RESEARCH_SESSION;
  const stub = namespace.get(namespace.idFromName(sessionId));
  const sockets: WebSocket[] = [];
  let activeStreamId: string | undefined;

  try {
    const started = await stub.fetch(new Request("https://session.example/session/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.session_headers },
      body: JSON.stringify(fixture.session_body),
    }));
    expect(started.status).toBe(200);
    await started.json();

    const broadcastSocket = await openSocket(stub, sessionId, fixture.session_headers, currentExpiry());
    sockets.push(broadcastSocket);
    const broadcastObservation = observe(broadcastSocket);
    const broadcastConnection = await connectedState(stub);
    expect(broadcastConnection.state?.research_access_expires_at).toBeTypeOf("string");
    const broadcastMarker = "research-session-expired-broadcast";
    const broadcastExpiry = pastExpiry();
    const storedBroadcastExpiry = await runInDurableObject(stub, (instance) => {
      const connection = connectionFor(instance, broadcastConnection.id);
      connection.setState((previous) => ({ ...(previous ?? {}), research_access_expires_at: broadcastExpiry }));
      researchSession(instance).broadcast(JSON.stringify({ type: "expiry-test", marker: broadcastMarker }));
      return connection.state?.research_access_expires_at;
    });
    expect(storedBroadcastExpiry).toBe(broadcastExpiry);
    await expectClosedWithoutMarker(stub, broadcastConnection.id, broadcastObservation, broadcastMarker);

    const resumeSocket = await openSocket(stub, sessionId, fixture.session_headers, currentExpiry());
    sockets.push(resumeSocket);
    const resumeObservation = observe(resumeSocket);
    const resumeConnection = await connectedState(stub);
    const replayMarker = "research-session-expired-stream-replay";
    const requestId = `resume-${sessionId}`;
    const seededStream = await runInDurableObject(stub, (instance) => {
      const sdk = instance as unknown as ChatStreamHarness;
      const streamId = sdk._resumableStream.start(requestId, { messageId: requestId });
      const sequence = sdk._resumableStream.storeChunk(streamId, JSON.stringify({
        body: replayMarker,
        done: false,
        id: requestId,
      }));
      sdk._resumableStream.flushBuffer();
      const connection = connectionFor(instance, resumeConnection.id);
      connection.setState((previous) => ({ ...(previous ?? {}), research_access_expires_at: pastExpiry() }));
      return {
        stream_id: streamId,
        sequence,
        active: sdk._resumableStream.hasActiveStream(),
        active_request_id: sdk._resumableStream.activeRequestId,
      };
    });
    activeStreamId = seededStream.stream_id;
    expect(seededStream.sequence).toBe(0);
    expect(seededStream).toMatchObject({ active: true, active_request_id: requestId });
    resumeSocket.send(JSON.stringify({ type: "stream-resume-request", probeId: "expired-resume-probe" }));
    await expectClosedWithoutMarker(stub, resumeConnection.id, resumeObservation, replayMarker);
    expect(resumeObservation.frames.join("\n")).not.toContain("expired-resume-probe");
    const completedStreamId = activeStreamId;
    if (completedStreamId !== undefined) {
      await runInDurableObject(stub, (instance) => {
        (instance as unknown as ChatStreamHarness)._resumableStream.complete(completedStreamId);
      });
    }
    activeStreamId = undefined;

    const scheduledSocket = await openSocket(stub, sessionId, fixture.session_headers, currentExpiry());
    sockets.push(scheduledSocket);
    const scheduledObservation = observe(scheduledSocket);
    const scheduledConnection = await connectedState(stub);
    const scheduledExpiry = pastExpiry();
    await setConnectionExpiry(stub, scheduledConnection.id, scheduledExpiry);
    const callbackResult = await runInDurableObject(stub, (instance) => {
      researchSession(instance).expireResearchSessionConnections({
        connection_id: scheduledConnection.id,
        expires_at: scheduledExpiry,
      });
      return Array.from(researchSession(instance).getConnections<SessionChatConnectionState>(), (connection) => connection.id);
    });
    expect(callbackResult).not.toContain(scheduledConnection.id);
    await expectClosedWithoutMarker(stub, scheduledConnection.id, scheduledObservation, "scheduled-expiry-should-not-send");

    const rehydratedSocket = await openSocket(stub, sessionId, fixture.session_headers, currentExpiry());
    sockets.push(rehydratedSocket);
    const rehydratedObservation = observe(rehydratedSocket);
    const rehydratedConnection = await connectedState(stub);
    const persistedExpiry = rehydratedConnection.state?.research_access_expires_at;
    expect(persistedExpiry).toBeTypeOf("string");
    await evictDurableObject(stub);
    // runInDurableObject bypasses Agents lifecycle startup. Wake through the
    // authenticated SDK history path so onStart reinstalls guards on the
    // hibernated connection before exercising a direct send.
    const restoredHistory = await stub.fetch(new Request(
      `https://session.example/get-messages?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { ...fixture.session_headers, [EXPIRY_HEADER]: currentExpiry() } },
    ));
    expect(restoredHistory.status).toBe(200);
    await restoredHistory.text();
    const afterEviction = await runInDurableObject(stub, (instance) => {
      const connection = connectionFor(instance, rehydratedConnection.id);
      return {
        id: connection.id,
        expires_at: connection.state?.research_access_expires_at,
      };
    });
    expect(afterEviction).toEqual({ id: rehydratedConnection.id, expires_at: persistedExpiry });

    const postEvictionMarker = "research-session-expired-post-eviction-send";
    await runInDurableObject(stub, (instance) => {
      const connection = connectionFor(instance, rehydratedConnection.id);
      connection.setState((previous) => ({ ...(previous ?? {}), research_access_expires_at: pastExpiry() }));
      connection.send(postEvictionMarker);
    });
    await expectClosedWithoutMarker(stub, rehydratedConnection.id, rehydratedObservation, postEvictionMarker);

    const constructorSocket = await openSocket(stub, sessionId, fixture.session_headers, currentExpiry());
    sockets.push(constructorSocket);
    const constructorObservation = observe(constructorSocket);
    const constructorConnection = await connectedState(stub);
    const constructorExpiry = pastExpiry();
    await setConnectionExpiry(stub, constructorConnection.id, constructorExpiry);
    await evictDurableObject(stub);
    // Native RPC restores the instance without running SDK onStart; constructor
    // expiry handling must close this socket before the callback can read it.
    const restoredConnectionIds = await runInDurableObject(stub, (instance) =>
      Array.from(researchSession(instance).getConnections<SessionChatConnectionState>(), (connection) => connection.id));
    expect(restoredConnectionIds).not.toContain(constructorConnection.id);
    await expectClosedWithoutMarker(
      stub,
      constructorConnection.id,
      constructorObservation,
      "constructor-expired-socket-should-not-send",
    );
    expect(create).not.toHaveBeenCalled();
  } finally {
    const pendingStreamId = activeStreamId;
    if (pendingStreamId !== undefined) {
      try {
        await runInDurableObject(stub, (instance) => {
          (instance as unknown as ChatStreamHarness)._resumableStream.complete(pendingStreamId);
        });
      } catch { /* The test may already have evicted or closed this Durable Object. */ }
    }
    for (const socket of sockets) {
      try { socket.close(1000, "test cleanup"); } catch { /* The server may already have closed it. */ }
    }
    get.mockRestore();
    create.mockRestore();
  }
}, 30_000);

it("rejects restored connections without a canonical authority deadline", () => {
  const close = vi.fn();
  const restored = {
    state: { research_access_expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString() },
    close,
  } as unknown as Connection<SessionChatConnectionState>;
  expect(requireCurrentSessionConnection(restored)).toBe(false);
  expect(close).toHaveBeenCalledWith(1008, "SESSION_AUTHORITY_STALE");
});

it("closes at the earliest canonical scope, grant, or Access expiry", async () => {
  const fixture = await prepareHistoricalV2Workflow(`session-scope-expiry-${crypto.randomUUID().replaceAll("-", "")}`);
  const scopeExpiresAt = fixture.scope.expires_at;
  const scopeExpiresAtMs = Date.parse(scopeExpiresAt);
  const grantExpiresAt = new Date(scopeExpiresAtMs + 30 * 60 * 1_000).toISOString();
  const accessExpiresAt = new Date(scopeExpiresAtMs + 60 * 60 * 1_000).toISOString();
  await fixture.db.prepare(
    "UPDATE scope_access_grant SET expires_at=?1 WHERE snapshot_id=?2 AND snapshot_revision=?3 " +
      "AND principal_ref=?4 AND client_class='owner_pwa' AND credential_generation=?5",
  ).bind(
    grantExpiresAt,
    fixture.scope.snapshot_id,
    fixture.scope.revision,
    fixture.principal.principal_ref,
    fixture.principal.credential_generation,
  ).run();

  const workflow = bindings.RESEARCH_WORKFLOW;
  const get = vi.spyOn(workflow, "get").mockImplementation(async (id) => ({
    id,
    status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(workflow, "create");
  const schedule = vi.spyOn(ResearchSession.prototype, "schedule");
  const namespace = bindings.RESEARCH_SESSION;
  const stub = namespace.get(namespace.idFromName(fixture.session_body.session_id));
  let socket: WebSocket | undefined;

  try {
    const started = await stub.fetch(new Request("https://session.example/session/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.session_headers },
      body: JSON.stringify(fixture.session_body),
    }));
    expect(started.status).toBe(200);
    await started.json();

    socket = await openSocket(stub, fixture.session_body.session_id, fixture.session_headers, accessExpiresAt);
    const connection = await connectedState(stub);
    expect(connection.state).toMatchObject({
      research_access_expires_at: accessExpiresAt,
      research_authority_expires_at: scopeExpiresAt,
    });
    const scheduledClose = schedule.mock.calls.find((call) => call[1] === "expireResearchSessionConnections");
    expect(scheduledClose?.[0]).toEqual(new Date(Math.ceil(scopeExpiresAtMs / 1_000) * 1_000));
    expect(scheduledClose?.[2]).toEqual({ connection_id: connection.id, expires_at: scopeExpiresAt });

    const close = vi.fn();
    const laterDeadlinesConnection = {
      state: {
        research_access_expires_at: accessExpiresAt,
        research_authority_expires_at: scopeExpiresAt,
      },
      close,
    } as unknown as Connection<SessionChatConnectionState>;
    const clock = vi.spyOn(Date, "now").mockReturnValue(scopeExpiresAtMs + 1);
    try {
      expect(requireCurrentSessionConnection(laterDeadlinesConnection)).toBe(false);
      expect(close).toHaveBeenCalledWith(1008, "SESSION_AUTHORITY_STALE");
    } finally {
      clock.mockRestore();
    }
    expect(create).not.toHaveBeenCalled();
  } finally {
    try { socket?.close(1000, "test cleanup"); } catch { /* The server may already have closed it. */ }
    get.mockRestore();
    create.mockRestore();
    schedule.mockRestore();
  }
}, 30_000);
