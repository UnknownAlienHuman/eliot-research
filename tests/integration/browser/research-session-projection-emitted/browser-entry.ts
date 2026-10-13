import { createResearchSessionProjectionAdapter } from "../../../../packages/owner-api-client/src/research/session-projection/adapter.js";
import type { ResearchSessionBinding } from "../../../../packages/owner-api-client/src/research/session-projection/session.js";

interface ProjectionQualificationWindow extends Window {
  __ELIOT_PROJECTION_BINDING__?: ResearchSessionBinding;
  __ELIOT_PROJECTION_SOCKETS__?: Array<{
    readonly url: string;
    readonly events: Array<Record<string, unknown>>;
    readonly socket: WebSocket;
  }>;
  __eliotResearchSessionQualification?: {
    readProjection(): Promise<unknown>;
    readCanonical(): Promise<unknown>;
    dispose(): void;
    socketState(): unknown;
  };
}

const qualificationWindow = window as ProjectionQualificationWindow;
let adapter: ReturnType<typeof createResearchSessionProjectionAdapter> | undefined;
const epochCapture = Object.freeze({ id: "emitted-browser-qualification" });
const epoch = {
  capture: () => epochCapture,
  isCurrent: (capture: unknown) => capture === epochCapture,
};

function requireBinding(): ResearchSessionBinding {
  const binding = qualificationWindow.__ELIOT_PROJECTION_BINDING__;
  if (binding === undefined) throw new Error("projection qualification binding is missing");
  return binding;
}

function getAdapter(): ReturnType<typeof createResearchSessionProjectionAdapter> {
  if (adapter !== undefined) return adapter;
  adapter = createResearchSessionProjectionAdapter({
    epoch,
    errors: (details) => Object.assign(new Error(details.message), details),
    now: () => Date.now(),
    isRequestError: (error) => error instanceof Error &&
      typeof (error as { readonly status?: unknown }).status === "number",
    controls: {
      transport: "cf-websocket",
      host: window.location.host,
      protocol: window.location.protocol === "https:" ? "wss" : "ws",
    },
  });
  return adapter;
}

qualificationWindow.__eliotResearchSessionQualification = {
  async readProjection() {
    const result = await getAdapter().readProjection(requireBinding());
    const state = document.getElementById("qualification-state");
    if (state !== null) state.textContent = result.kind;
    return result;
  },
  async readCanonical() {
    const binding = requireBinding();
    const response = await fetch(`/api/v1/research/run/${encodeURIComponent(binding.operation_id)}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    return { status: response.status, body: await response.json() };
  },
  dispose() {
    adapter?.dispose();
    adapter = undefined;
  },
  socketState() {
    return (qualificationWindow.__ELIOT_PROJECTION_SOCKETS__ ?? []).map(({ url, events, socket }) => ({
      url,
      events,
      ready_state: socket.readyState,
    }));
  },
};
