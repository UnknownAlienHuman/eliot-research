/** C3-RP ResearchSession socket lifecycle over the official Agents SDK.
 *
 * This is the only module in this package that touches `agents/client`. The import is lazy, inside the
 * explicit `connect()`, so no `new AgentClient(...)` can run at module import time and no SDK symbol can
 * leak into a UI or root barrel.
 *
 * One adapter binds exactly one session tuple. A second, foreign tuple is rejected against the bound
 * tuple instead of opening another socket. Concurrent reads on the bound tuple share one memoized
 * in-flight call. The socket is a call transport only: `client.state` is never read, `onStateUpdate` is
 * never registered and no chat, history, MCP or identity frame is subscribed.
 *
 * The shared session authority epoch belongs to the caller. This module captures it once per read for
 * fencing, never remints or closes it, and on dispose settles every pending read and closes only its own
 * sockets. Every ambient value is injected: the clock, the epoch, the host controls and the error
 * identity. Nothing is derived from `window`, `location`, `document` or `Date.now`.
 */

import type { LegacyErrorFactory } from "../../legacy/http";
import type { EpochPort } from "../../transport/client";

/** Socket binding tuple. Every field is injected data; nothing is derived from the environment. */
export interface ResearchSessionBinding {
  readonly agent: string;
  readonly name: string;
  readonly session_id: string;
  readonly operation_id: string;
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly handler_generation: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  /** Absolute expiry in milliseconds of the injected clock, never of `Date.now`. */
  readonly authority_expires_at: number;
  /** Caller-supplied RPC deadline in milliseconds; no SDK default silently applies. */
  readonly timeoutMs: number;
}

export interface ResearchSessionPorts {
  readonly epoch: EpochPort;
  readonly errors: LegacyErrorFactory;
  readonly now: () => number;
  /** Required typed-error identity. Only a real request error may be classified. */
  readonly isRequestError: (error: unknown) => boolean;
}

/** The single method this leaf calls. Fixed name, zero arguments. */
export const PROJECTION_METHOD = "readResearchSessionProjection";

/** The official client surface this leaf consumes. `AgentClient` satisfies it structurally. */
export interface ProjectionCallClient {
  /** The leaf consumes one contract only: an unknown, no-argument projection. */
  call(method: string, args: readonly unknown[], options?: { readonly timeout?: number }): Promise<unknown>;
  close(code?: number, reason?: string): void;
}

/**
 * Host and route controls, forwarded as data to the official `AgentClientOptions`.
 *
 * The installed SDK exposes `transport` (`"cf-websocket"` default; `"capnweb"` is `@experimental`),
 * `agent`, `name`, an optional `basePath` that fully bypasses agent and name routing, and the inherited
 * `PartySocketOptions` `host` and `protocol` (`"ws" | "wss"`), which are combined with `path` and `query`.
 * This leaf pins the protocol family explicitly and never invents an
 * authentication header: a browser cannot set WebSocket handshake headers, and credentials travel as
 * same-origin cookies handled by the browser itself.
 */
export interface ResearchSessionHostControls {
  readonly transport: "cf-websocket";
  /** Loopback or site host in `host[:port]` form, for example `127.0.0.1:6006` or `eliotr.example`. */
  readonly host: string;
  /** The official Partysocket protocol selector. No other form of transport choice is accepted. */
  readonly protocol: "ws" | "wss";
  readonly path?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly basePath?: string;
}

export type ResearchSessionClientFactory = (
  binding: ResearchSessionBinding,
  controls: ResearchSessionHostControls,
) => Promise<ProjectionCallClient>;

export interface ResearchSessionSocket {
  callProjection(binding: ResearchSessionBinding): Promise<unknown>;
  dispose(): void;
}

const fail = (ports: ResearchSessionPorts, code: string, status: number, message: string): never => {
  throw ports.errors({ code, status, message, traceId: null, retryable: false });
};

const closedSession = (ports: ResearchSessionPorts, message: string): never =>
  fail(ports, "API_SESSION_CLOSED", 503, message);

const brokenBinding = (ports: ResearchSessionPorts, message: string): never =>
  fail(ports, "RESEARCH_RUN_RESPONSE_INVALID", 502, message);

const disposedError = (ports: ResearchSessionPorts, message: string): Error =>
  ports.errors({
    code: "API_SESSION_CLOSED",
    status: 503,
    message,
    traceId: null,
    retryable: false,
  });

/**
 * Settles the owned pending promises before any state is cleared or closed, and only then throws.
 *
 * `closedSession` is declared `never`, so a fence that threw first left `closeOwned` unreachable and
 * the pending `calling` and `connecting` promises settled forever: the caller never learned the read
 * failed. This helper inverts the order, matching the dispose pattern, so a rejected read always
 * carries the same typed `API_SESSION_CLOSED` error and never leaves a socket in use.
 */
const rejectAndCloseOwned = (
  ports: ResearchSessionPorts,
  rejectCalling: (error: unknown) => void,
  rejectConnecting: (error: unknown) => void,
  clear: () => void,
  message: string,
): never => {
  const error = disposedError(ports, message);
  rejectCalling(error);
  rejectConnecting(error);
  clear();
  throw error;
};

/**
 * Freezes the caller tuple once, so later mutation of the caller object cannot change the socket.
 * binding. The nested reference and every bound are copied by value.
 */
export function freezeBinding(binding: ResearchSessionBinding): ResearchSessionBinding {
  return Object.freeze({
    agent: binding.agent,
    name: binding.name,
    session_id: binding.session_id,
    operation_id: binding.operation_id,
    investigation_ref: Object.freeze({
      id: binding.investigation_ref.id,
      revision: binding.investigation_ref.revision,
    }),
    handler_generation: binding.handler_generation,
    principal_ref: binding.principal_ref,
    credential_generation: binding.credential_generation,
    deployment_generation: binding.deployment_generation,
    authority_expires_at: binding.authority_expires_at,
    timeoutMs: binding.timeoutMs,
  });
}

const sameTuple = (left: ResearchSessionBinding, right: ResearchSessionBinding): boolean =>
  left.agent === right.agent && left.name === right.name && left.session_id === right.session_id &&
  left.operation_id === right.operation_id &&
  left.investigation_ref.id === right.investigation_ref.id &&
  left.investigation_ref.revision === right.investigation_ref.revision &&
  left.handler_generation === right.handler_generation &&
  left.principal_ref === right.principal_ref &&
  left.credential_generation === right.credential_generation &&
  left.deployment_generation === right.deployment_generation &&
  left.authority_expires_at === right.authority_expires_at && left.timeoutMs === right.timeoutMs;

const CONTROLS_KEYS = [
  "transport", "host", "protocol", "path", "query", "basePath",
] as const;

const normalizeHost = (ports: ResearchSessionPorts, controls: ResearchSessionHostControls): void => {
  for (const key of Object.keys(controls)) {
    if (!CONTROLS_KEYS.includes(key as (typeof CONTROLS_KEYS)[number])) {
      brokenBinding(ports, `unsupported host control: ${key}`);
    }
  }
  if (controls.transport !== "cf-websocket") brokenBinding(ports, "only the default transport is allowed");
  if (typeof controls.host !== "string" || controls.host.trim() === "" || /[\s/]/u.test(controls.host)) {
    brokenBinding(ports, "host must be a host and optional port");
  }
  if (controls.protocol !== "ws" && controls.protocol !== "wss") {
    brokenBinding(ports, "protocol must be an explicit ws or wss");
  }
  if (controls.basePath !== undefined && controls.basePath !== "") {
    // basePath fully bypasses agent and name routing.
    if (!controls.basePath.startsWith("/") || controls.basePath.includes("//")) {
      brokenBinding(ports, "basePath must be an absolute path");
    }
    return;
  }
  if (controls.path !== undefined && (!controls.path.startsWith("/") || controls.path.includes("//"))) {
    brokenBinding(ports, "path must be an absolute path");
  }
  for (const value of Object.values(controls.query ?? {})) {
    if (value.includes("&") || value.includes("=")) brokenBinding(ports, "query value must not smuggle a pair");
  }
}

function bindingUsable(ports: ResearchSessionPorts, binding: ResearchSessionBinding): void {
  const expiry = binding.authority_expires_at;
  const deadline = binding.timeoutMs;
  if (!Number.isSafeInteger(expiry) || !Number.isSafeInteger(deadline) || deadline < 1) {
    brokenBinding(ports, "session binding carries an invalid bound");
  }
  const observed = ports.now();
  // A NaN or infinite clock fails closed instead of bypassing the expiry comparison.
  if (!Number.isFinite(observed)) brokenBinding(ports, "session clock is not a finite bound");
  if (observed >= expiry) closedSession(ports, "Session authority has expired");
}

/**
 * The official client factory. `agents/client` is imported here, lazily, after every control and bound
 * has been validated, so no import or socket can be created from an unqualified value. Host and route
 * controls are forwarded as data; the official instance keeps ownership of its own call and close.
 */
export function createOfficialProjectionClient(
  binding: ResearchSessionBinding,
  controls: ResearchSessionHostControls,
): Promise<ProjectionCallClient> {
  // The destination is snapshotted before the lazy import, so a delayed import cannot redirect it.
  const destination = Object.freeze({
    agent: binding.agent,
    name: binding.name,
    transport: controls.transport,
    host: controls.host,
    protocol: controls.protocol,
    ...(controls.path === undefined ? {} : { path: controls.path }),
    ...(controls.query === undefined ? {} : { query: { ...controls.query } }),
    ...(controls.basePath === undefined ? {} : { basePath: controls.basePath }),
  });
  return import("agents/client").then((module) => {
    const client = new module.AgentClient(destination);
    // This leaf consumes exactly one contract: an unknown, no-argument projection. The wrapper
    // asks the official client for `unknown` rather than inventing a generic surface.
    return {
      call: (method: string, args: readonly unknown[], options?: { readonly timeout?: number }): Promise<unknown> =>
        client.call<unknown>(method, [...args], options),
      close: (code?: number, reason?: string): void => client.close(code, reason),
    };
  });
}

export function createResearchSession(
  ports: ResearchSessionPorts,
  connect: ResearchSessionClientFactory = createOfficialProjectionClient,
  controls: ResearchSessionHostControls,
): ResearchSessionSocket {
  let bound: ResearchSessionBinding | undefined;
  let captured: object | undefined;
  let client: ProjectionCallClient | undefined;
  let connecting: Promise<ProjectionCallClient> | undefined;
  let settleConnecting: ((error: unknown) => void) | undefined;
  let calling: Promise<unknown> | undefined;
  let settleCalling: ((error: unknown) => void) | undefined;
  let disposed = false;

  const stale = (capture: object, expiry: number): boolean => {
    // One clock observation per check: a clock that advances between reads cannot report a still
    // valid session as expired, or the reverse, inside a single fence.
    const observed = ports.now();
    if (disposed || !Number.isFinite(observed)) return true;
    return !ports.epoch.isCurrent(capture) || observed >= expiry;
  };

  const closeOwned = (): void => {
    const owned = client;
    client = undefined;
    connecting = undefined;
    settleConnecting = undefined;
    calling = undefined;
    settleCalling = undefined;
    bound = undefined;
    captured = undefined;
    owned?.close(1000, "owner-client-disposed");
  };

  // The reject hooks let a fence settle the promise the caller is actually waiting on before any
  // state is cleared, so a rejected read never leaves that promise pending forever.
  const rejectCalling = (error: unknown): void => settleCalling?.(error);
  const rejectConnecting = (error: unknown): void => settleConnecting?.(error);

  const beginConnect = (binding: ResearchSessionBinding, epochCapture: object): Promise<ProjectionCallClient> => {
    const promise = new Promise<ProjectionCallClient>((resolve, reject) => {
      settleConnecting = reject;
      const finish = (value: ProjectionCallClient | undefined, error: unknown): void => {
        if (settleConnecting === undefined) return;
        settleConnecting = undefined;
        connecting = undefined;
        if (value === undefined) {
          reject(error);
          return;
        }
        client = value;
        resolve(value);
      };
      connect(binding, controls).then(
        (value: ProjectionCallClient) => {
          if (stale(epochCapture, binding.authority_expires_at)) {
            value.close(1000, "owner-client-disposed");
            finish(undefined, disposedError(ports, "Socket was disposed or closed while connecting"));
            return;
          }
          finish(value, undefined);
        },
        (error: unknown) => finish(undefined, error),
      );
    });
    connecting = promise;
    return promise;
  };

  return {
    async callProjection(requested) {
      // The caller tuple is frozen before any asynchronous step can alias it.
      const binding = freezeBinding(requested);
      if (disposed) return closedSession(ports, "Socket was already disposed");
      const observed = ports.epoch.capture();
      if (observed === undefined || !ports.epoch.isCurrent(observed)) {
        return closedSession(ports, "Owner session is not current");
      }
      const epochCapture: object = observed;
      bindingUsable(ports, binding);
      // Host and route controls are qualified before any import or connect.
      normalizeHost(ports, controls);
      // This adapter binds exactly one tuple: a foreign tuple never opens a second socket.
      if (bound !== undefined && !sameTuple(bound, binding)) {
        closedSession(ports, "Socket is already bound to a different session tuple");
      }
      if (bound === undefined) {
        bound = binding;
        captured = epochCapture;
      }
      // The original capture is preserved for the whole read, including after the await. The guard
      // narrows `captured` without an assertion: an unbound socket was just bound above, and any
      // other state fails closed here rather than reaching the fences.
      if (captured === undefined) return closedSession(ports, "Owner session is not current");
      const readCapture: object = captured;
      if (bound === undefined) return closedSession(ports, "Socket is not bound");
      const readBinding: ResearchSessionBinding = bound;
      const expired = (): boolean => stale(readCapture, readBinding.authority_expires_at);

      // A pending read is memoized: a concurrent second read shares it instead of re-issuing an RPC.
      if (calling !== undefined && settleCalling !== undefined) {
        return calling.then((value) => {
          if (expired()) return { kind: "UNAVAILABLE" } as const;
          return value;
        });
      }

      const runCall = async (opened: ProjectionCallClient): Promise<unknown> => {
        // Post-connect fence: disposal, an epoch change or an expiry must not reach the wire.
        if (stale(readCapture, readBinding.authority_expires_at)) {
          opened.close(1000, "owner-client-disposed");
          rejectAndCloseOwned(
            ports,
            rejectCalling,
            rejectConnecting,
            closeOwned,
            "Socket closed before the projection call",
          );
        }
        const value = await opened.call(PROJECTION_METHOD, [], { timeout: readBinding.timeoutMs });
        // Post-RPC fence: a late response cannot be returned to a closed session.
        if (stale(readCapture, readBinding.authority_expires_at)) {
          opened.close(1000, "owner-client-disposed");
          rejectAndCloseOwned(
            ports,
            rejectCalling,
            rejectConnecting,
            closeOwned,
            "Projection response belongs to a closed session",
          );
        }
        return value;
      };

      const promise = new Promise<unknown>((resolve, reject) => {
        settleCalling = reject;
        const finish = (value: unknown, error: unknown, failed: boolean): void => {
          if (settleCalling === undefined) return;
          settleCalling = undefined;
          calling = undefined;
          if (failed) {
            reject(error);
            return;
          }
          resolve(value);
        };
        const opened = connecting ?? beginConnect(readBinding, readCapture);
        opened.then(
          (value) => runCall(value).then(
            (result: unknown) => finish(result, undefined, false),
            (error: unknown) => finish(undefined, error, true),
          ),
          (error: unknown) => finish(undefined, error, true),
        );
      });
      calling = promise;
      return promise;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      settleCalling?.(disposedError(ports, "Socket was disposed while the call was in flight"));
      settleCalling = undefined;
      calling = undefined;
      settleConnecting?.(disposedError(ports, "Socket was disposed while connecting"));
      settleConnecting = undefined;
      connecting = undefined;
      const owned = client;
      client = undefined;
      bound = undefined;
      captured = undefined;
      owned?.close(1000, "owner-client-disposed");
    },
  };
}
