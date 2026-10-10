import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";

const bindings = env as unknown as Env;
const ACCESS_EXPIRY_HEADER = "x-research-access-expires-at";

interface WorkflowSnapshot {
  state: string;
  next_stage_index: number;
  current_revision: number;
  attempts: number;
  checkpoints: number;
}

interface SessionSnapshot {
  status: number;
  body: unknown;
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("projection socket did not close")), 5_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      const closed = event as CloseEvent;
      resolve({ code: closed.code, reason: closed.reason });
    }, { once: true });
  });
}

async function transcriptStorageSnapshot(stub: DurableObjectStub): Promise<string> {
  return runInDurableObject(stub, async (_instance, state) => {
    const tables = state.storage.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master
      WHERE type='table' AND (lower(name) LIKE '%chat%' OR lower(name) LIKE '%message%' OR lower(name) LIKE '%transcript%'
        OR lower(name) = 'cf_agents_state')
      ORDER BY name`).toArray();
    const rows = tables.map(({ name }) => {
      const quotedName = `"${name.replaceAll('"', '""')}"`;
      return { name, rows: state.storage.sql.exec(`SELECT * FROM ${quotedName}`).toArray() };
    });
    const entries = Array.from(await state.storage.list())
      .filter(([key]) => /chat|message|transcript/iu.test(key))
      .sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify({ rows, entries });
  });
}

async function sessionSnapshot(stub: DurableObjectStub, sessionId: string, headers: Record<string, string>): Promise<SessionSnapshot> {
  const response = await stub.fetch(new Request(`https://session.example/session/${sessionId}`, { headers }));
  return { status: response.status, body: await response.json() };
}

async function workflowSnapshot(
  fixture: Awaited<ReturnType<typeof prepareHistoricalV2Workflow>>,
): Promise<WorkflowSnapshot | null> {
  return fixture.db.prepare(`SELECT state, next_stage_index, current_revision,
    (SELECT COUNT(*) FROM research_workflow_attempt WHERE operation_id = ?1) AS attempts,
    (SELECT COUNT(*) FROM research_workflow_checkpoint WHERE operation_id = ?1) AS checkpoints
    FROM research_workflow_run WHERE operation_id = ?1`).bind(fixture.request.operation_id)
    .first<WorkflowSnapshot>();
}

async function openProjectionHarness(tag: string) {
  const fixture = await prepareHistoricalV2Workflow(`session-native-chat-${tag}-${crypto.randomUUID()}`);
  const workflow = bindings.RESEARCH_WORKFLOW;
  const get = vi.spyOn(workflow, "get").mockImplementation(async (id) => ({
    id,
    status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(workflow, "create");
  let socket: WebSocket | undefined;
  try {
    const sessionId = fixture.session_body.session_id;
    const stub = bindings.RESEARCH_SESSION.get(
      bindings.RESEARCH_SESSION.idFromName(`session-native-chat-${sessionId}`),
    );
    const started = await stub.fetch(new Request("https://session.example/session/start", {
      method: "POST",
      headers: { "content-type": "application/json", ...fixture.session_headers },
      body: JSON.stringify(fixture.session_body),
    }));
    expect(started.status).toBe(200);

    const response = await stub.fetch(new Request(
      `https://session.example/status?session_id=${encodeURIComponent(sessionId)}`,
      {
        headers: {
          ...fixture.session_headers,
          [ACCESS_EXPIRY_HEADER]: "2027-01-01T00:00:00.000Z",
          upgrade: "websocket",
        },
      },
    ));
    expect(response.status).toBe(101);
    const acceptedSocket = response.webSocket ?? undefined;
    expect(acceptedSocket).toBeDefined();
    if (acceptedSocket === undefined) throw new Error("Agent websocket upgrade returned no socket");
    acceptedSocket.accept({ allowHalfOpen: false });
    socket = acceptedSocket;

    const beforeSession = await sessionSnapshot(stub, sessionId, fixture.session_headers);
    const beforeRun = await workflowSnapshot(fixture);
    const beforeTranscript = await transcriptStorageSnapshot(stub);
    return { fixture, sessionId, stub, socket: acceptedSocket, get, create, beforeSession, beforeRun, beforeTranscript };
  } catch (error) {
    socket?.close();
    get.mockRestore();
    create.mockRestore();
    throw error;
  }
}

async function expectProjectionUnchanged(
  harness: Awaited<ReturnType<typeof openProjectionHarness>>,
  marker: string,
): Promise<void> {
  const afterTranscript = await transcriptStorageSnapshot(harness.stub);
  const afterSession = await sessionSnapshot(harness.stub, harness.sessionId, harness.fixture.session_headers);
  const afterRun = await workflowSnapshot(harness.fixture);

  expect(harness.beforeSession.status).toBe(200);
  expect(afterSession.status).toBe(200);
  expect(afterSession.body).toEqual(harness.beforeSession.body);
  expect(afterRun).toEqual(harness.beforeRun);
  expect(afterTranscript).toBe(harness.beforeTranscript);
  expect(afterTranscript).not.toContain(marker);
  expect(harness.create).not.toHaveBeenCalled();
  expect(harness.get).toHaveBeenCalledWith(harness.fixture.request.operation_id);
}

function closeProjectionHarness(harness: Awaited<ReturnType<typeof openProjectionHarness>>): void {
  harness.socket.close();
  harness.get.mockRestore();
  harness.create.mockRestore();
}

it("repeated projection RPC reads and disconnect leave the canonical run and transcript unchanged", async () => {
  const harness = await openProjectionHarness("read-repeat");
  try {
    expect(harness.beforeRun).not.toBeNull();
    for (const id of ["projection-first", "projection-repeat"]) {
      const reply = new Promise<unknown>((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
          clearTimeout(timeout);
          try { resolve(JSON.parse(event.data as string)); }
          catch (error) { reject(error); }
        };
        const timeout = setTimeout(() => {
          harness.socket.removeEventListener("message", onMessage);
          reject(new Error("projection RPC did not respond"));
        }, 5_000);
        harness.socket.addEventListener("message", onMessage, { once: true });
      });
      harness.socket.send(JSON.stringify({ type: "rpc", id, method: "readResearchSessionProjection", args: [] }));
      expect(await reply).toEqual({
        type: "rpc", id, success: true, done: true,
        result: {
          protocol: "eliotr.research-session-projection.v1",
          session_id: harness.sessionId,
          operation_id: harness.fixture.request.operation_id,
          state: "ACTIVE",
          investigation_ref: {
            id: harness.fixture.session_body.investigation_id,
            revision: harness.fixture.session_body.investigation_revision,
          },
          run_status: {
            execution_state: "ACTIVE", engine_status: "waiting",
            next_stage_index: harness.beforeRun?.next_stage_index,
          },
        },
      });
    }
    harness.socket.close();
    await expectProjectionUnchanged(harness, "projection-read-repeat");
  } finally {
    closeProjectionHarness(harness);
  }
}, 30_000);

it("rejects legacy transcript sync before Agent dispatch without writing chat history or changing the run", async () => {
  const harness = await openProjectionHarness("transcript");
  try {
    const disabledHistory = await harness.stub.fetch(new Request(
      `https://session.example/agents/research-session/${encodeURIComponent(harness.sessionId)}/get-messages`,
      { headers: { ...harness.fixture.session_headers, [ACCESS_EXPIRY_HEADER]: "2027-01-01T00:00:00.000Z" } },
    ));
    expect(disabledHistory.status).toBe(410);
    expect(await disabledHistory.json()).toMatchObject({ code: "SESSION_CHAT_HISTORY_DISABLED" });

    const marker = `legacy-transcript-${crypto.randomUUID()}`;
    const closed = waitForClose(harness.socket);
    harness.socket.send(JSON.stringify({
      type: "cf_agent_chat_messages",
      messages: [{ id: "attacker-message", role: "user", parts: [{ type: "text", text: marker }] }],
    }));
    expect(await closed).toEqual({ code: 1008, reason: "SESSION_PROJECTION_READ_ONLY" });
    await expectProjectionUnchanged(harness, marker);
  } finally {
    closeProjectionHarness(harness);
  }
}, 30_000);

type NativeMutationFrame = string | Record<string, unknown>;
interface NativeMutationCase {
  name: string;
  frames: (marker: string) => readonly NativeMutationFrame[];
}

const nativeMutationFrames: readonly NativeMutationCase[] = [
  { name: "clear", frames: () => [{ type: "cf_agent_chat_clear" }] },
  {
    name: "regenerate",
    frames: (marker) => [{
      type: "cf_agent_use_chat_request",
      id: `regenerate-${marker}`,
      init: { messages: [{ id: `user-${marker}`, role: "user", parts: [{ type: "text", text: marker }] }] },
    }],
  },
  {
    name: "tool approval",
    frames: (marker) => [{
      type: "cf_agent_tool_approval",
      toolCallId: `unowned-${marker}`,
      approved: true,
      autoContinue: false,
    }],
  },
  {
    name: "tool result",
    frames: (marker) => [{
      type: "cf_agent_tool_result",
      toolCallId: `unowned-${marker}`,
      toolName: "unowned-tool",
      output: { marker },
      state: "output-available",
      autoContinue: false,
    }],
  },
  {
    name: "state",
    frames: (marker) => [
      { type: "cf_agent_state", state: { attacker_marker: marker } },
    ],
  },
  { name: "malformed", frames: () => ["{"] },
  {
    name: "unrelated RPC",
    frames: (marker) => [
      { type: "rpc", id: `mutation-${marker}`, method: "setState", args: [{ attacker_marker: marker }] },
    ],
  },
  {
    name: "projection RPC arguments",
    frames: (marker) => [
      { type: "rpc", id: `arguments-${marker}`, method: "readResearchSessionProjection", args: [{ attacker_marker: marker }] },
    ],
  },
  {
    name: "projection RPC unknown field",
    frames: (marker) => [
      { type: "rpc", id: `field-${marker}`, method: "readResearchSessionProjection", args: [], attacker_marker: marker },
    ],
  },
];

it.each(nativeMutationFrames)("rejects native client mutation frame: $name", async ({ name, frames }) => {
  const harness = await openProjectionHarness(`mutation-${name.replaceAll(" ", "-")}`);
  const marker = `native-mutation-${name}-${crypto.randomUUID()}`;
  try {
    const closed = waitForClose(harness.socket);
    for (const frame of frames(marker)) {
      harness.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    }
    expect(await closed).toEqual({ code: 1008, reason: "SESSION_PROJECTION_READ_ONLY" });
    await expectProjectionUnchanged(harness, marker);
  } finally {
    closeProjectionHarness(harness);
  }
}, 30_000);

it("isolates two native projection connections from client transcript injection", async () => {
  const harness = await openProjectionHarness("peer-isolation");
  let peer: WebSocket | undefined;
  const peerFrames: unknown[] = [];
  try {
    expect(harness.beforeRun).not.toBeNull();
    const response = await harness.stub.fetch(new Request(
      `https://session.example/status?session_id=${encodeURIComponent(harness.sessionId)}`,
      {
        headers: {
          ...harness.fixture.session_headers,
          [ACCESS_EXPIRY_HEADER]: "2027-01-01T00:00:00.000Z",
          upgrade: "websocket",
        },
      },
    ));
    expect(response.status).toBe(101);
    peer = response.webSocket ?? undefined;
    if (peer === undefined) throw new Error("peer projection upgrade returned no socket");
    peer.accept({ allowHalfOpen: false });
    peer.addEventListener("message", (event: MessageEvent) => peerFrames.push(event.data));
    expect(await runInDurableObject(harness.stub, (_instance, state) => state.getWebSockets().length)).toBe(2);

    const marker = `peer-transcript-${crypto.randomUUID()}`;
    const closed = waitForClose(harness.socket);
    harness.socket.send(JSON.stringify({
      type: "cf_agent_chat_messages",
      messages: [{ id: "attacker-message", role: "user", parts: [{ type: "text", text: marker }] }],
    }));
    expect(await closed).toEqual({ code: 1008, reason: "SESSION_PROJECTION_READ_ONLY" });
    expect(peer.readyState).toBe(WebSocket.OPEN);

    const id = "unaffected-peer-projection";
    const reply = new Promise<unknown>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        clearTimeout(timeout);
        try { resolve(JSON.parse(event.data as string)); }
        catch (error) { reject(error); }
      };
      const timeout = setTimeout(() => {
        peer?.removeEventListener("message", onMessage);
        reject(new Error("peer projection RPC did not respond"));
      }, 5_000);
      peer?.addEventListener("message", onMessage, { once: true });
    });
    peer.send(JSON.stringify({ type: "rpc", id, method: "readResearchSessionProjection", args: [] }));
    expect(await reply).toEqual({
      type: "rpc", id, success: true, done: true,
      result: {
        protocol: "eliotr.research-session-projection.v1",
        session_id: harness.sessionId,
        operation_id: harness.fixture.request.operation_id,
        state: "ACTIVE",
        investigation_ref: {
          id: harness.fixture.session_body.investigation_id,
          revision: harness.fixture.session_body.investigation_revision,
        },
        run_status: {
          execution_state: "ACTIVE", engine_status: "waiting",
          next_stage_index: harness.beforeRun?.next_stage_index,
        },
      },
    });
    await expectProjectionUnchanged(harness, marker);
    expect(peerFrames).toHaveLength(1);
    expect(JSON.stringify(peerFrames)).not.toContain(marker);
  } finally {
    peer?.close();
    closeProjectionHarness(harness);
  }
}, 30_000);
