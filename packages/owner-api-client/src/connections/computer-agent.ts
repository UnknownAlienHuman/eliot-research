/** Strict owner reads and explicitly prepared computer-agent connection mutations. */
import {
  ComputerAgentConnectionDisableSchema,
  ComputerAgentConnectionListSchema,
  ComputerAgentConnectionPutSchema,
  ComputerAgentConnectionSchema,
  ComputerAgentQualificationStatusSchema,
  ComputerAgentQualificationTransportSchema,
  type ComputerAgentConnection,
  type ComputerAgentConnectionList,
  type ComputerAgentConnectionPut,
  type ComputerAgentQualificationStatus,
  type ComputerAgentQualificationTransport,
} from "@eliotr/contracts";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_CONNECTION_BYTES = 24_576;
const CONNECTIONS_PATH = "/api/v1/system/computer-agents";

export interface ComputerAgentConnectionMutationIntent {
  readonly connectionId: string;
  readonly deploymentGeneration: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly method: "PUT" | "DELETE";
  readonly body: string;
  readonly previous?: ComputerAgentConnection;
}

interface IdentityPort { readonly mint: () => string }
type ConnectionHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;
type ConnectionMutation = ComputerAgentConnectionMutationIntent;
type InputErrorCode = "COMPUTER_AGENT_CONNECTION_INPUT_INVALID" | "COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID";

/** No global fetch, clock, crypto, DOM, storage, or retry authority is acquired. */
export function createComputerAgentConnectionApi(
  http: ConnectionHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
  identity: IdentityPort,
) {
  const { requestApiWithStatuses } = http;
  const fail = (details: Omit<LegacyErrorDetails, "traceId" | "retryable"> &
    Partial<Pick<LegacyErrorDetails, "traceId" | "retryable">>): Error =>
    errors({ traceId: null, retryable: false, ...details });
  const closed = (): never => {
    throw fail({ status: 503, code: "API_SESSION_CLOSED", message: "Owner session is closed" });
  };
  const currentCapture = (): object => {
    const captured = epoch.capture();
    if (captured === undefined || !epoch.isCurrent(captured)) return closed();
    return captured;
  };
  const currentResult = <T>(captured: object, result: T): T => {
    if (!epoch.isCurrent(captured)) return closed();
    return result;
  };
  const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> =>
    currentResult(captured, await result);

  function inputInvalid(message: string, code: InputErrorCode = "COMPUTER_AGENT_CONNECTION_INPUT_INVALID"): never {
    throw fail({ status: 400, code, message });
  }
  function responseInvalid(): never {
    throw fail({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "Computer-agent response does not match its shared contract" });
  }
  function generationChanged(): never {
    throw fail({ status: 409, code: "API_GENERATION_MISMATCH",
      message: "Deployment changed; discard computer-agent state and reload", retryable: true });
  }
  function safeIdentifier(value: unknown, label: string, code: InputErrorCode): string {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value) || !IDENTIFIER.test(value)) {
      inputInvalid(`${label} is invalid`, code);
    }
    return value;
  }
  function expectedGeneration(value: string): string {
    return safeIdentifier(value, "Deployment generation", "COMPUTER_AGENT_CONNECTION_INPUT_INVALID");
  }
  function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function canonicalInstant(value: string): boolean {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
  }
  function freezeConnection(connection: ComputerAgentConnection): ComputerAgentConnection {
    Object.freeze(connection.actor);
    Object.freeze(connection.transport_capabilities);
    Object.freeze(connection.computer_capabilities);
    Object.freeze(connection.task_kinds);
    return Object.freeze(connection);
  }
  function parseConnection(value: unknown, input: boolean): ComputerAgentConnection {
    const parsed = ComputerAgentConnectionSchema.safeParse(value);
    if (!parsed.success) {
      if (input) inputInvalid("Current connection does not match the shared contract");
      responseInvalid();
    }
    const connection = parsed.data;
    if (!canonicalInstant(connection.created_at) || !canonicalInstant(connection.updated_at) ||
        connection.created_at > connection.updated_at) {
      if (input) inputInvalid("Current connection has invalid timestamps");
      responseInvalid();
    }
    return freezeConnection(connection);
  }
  function validateGeneration(value: unknown, expected: string): string {
    if (typeof value !== "string" || !IDENTIFIER.test(value) || /[\u0000-\u0020\u007f]/u.test(value)) {
      responseInvalid();
    }
    if (value !== expected) generationChanged();
    return value;
  }
  function decodeEnvelope(value: unknown, generation: string): unknown {
    if (!record(value) || Object.keys(value).length !== 3 ||
        !Object.hasOwn(value, "data") || !Object.hasOwn(value, "trace_id") ||
        !Object.hasOwn(value, "deployment_generation")) responseInvalid();
    const trace = value.trace_id;
    if (typeof trace !== "string" || !TRACE.test(trace) || /\s/u.test(trace)) responseInvalid();
    validateGeneration(value.deployment_generation, generation);
    return value.data;
  }
  function freezeIntent(input: Omit<ConnectionMutation, "idempotencyKey">): ConnectionMutation {
    const idempotencyKey = `computer-agent-change-${identity.mint()}`;
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      inputInvalid("Mutation identity supplier returned an invalid idempotency key");
    }
    return Object.freeze({ ...input, idempotencyKey });
  }
  function intentInput(value: unknown): ConnectionMutation {
    if (!record(value) || !Object.isFrozen(value)) inputInvalid("Mutation must be a prepared immutable intent");
    const allowed = ["connectionId", "deploymentGeneration", "expectedRevision", "idempotencyKey", "method", "body", "previous"];
    if (Object.keys(value).some((key) => !allowed.includes(key)) ||
        allowed.slice(0, 6).some((key) => !Object.hasOwn(value, key))) {
      inputInvalid("Mutation intent has missing or unknown fields");
    }
    const connectionId = safeIdentifier(value.connectionId, "Connection ID", "COMPUTER_AGENT_CONNECTION_INPUT_INVALID");
    expectedGeneration(value.deploymentGeneration as string);
    const key = value.idempotencyKey;
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) inputInvalid("Mutation identity is invalid");
    const method = value.method;
    if (method !== "PUT" && method !== "DELETE") inputInvalid("Mutation method is invalid");
    if (typeof value.body !== "string" || value.body.length > MAX_CONNECTION_BYTES) inputInvalid("Mutation body is invalid");
    let bodyValue: unknown;
    try { bodyValue = JSON.parse(value.body); }
    catch { inputInvalid("Mutation body is not valid JSON"); }
    let expectedRevision: number;
    if (method === "PUT") {
      const parsed = ComputerAgentConnectionPutSchema.safeParse(bodyValue);
      if (!parsed.success) inputInvalid("Prepared connection fields do not match the shared contract");
      const normalized = {
        ...parsed.data,
        transport_capabilities: [...parsed.data.transport_capabilities].sort(),
        computer_capabilities: [...parsed.data.computer_capabilities].sort(),
        task_kinds: [...parsed.data.task_kinds].sort(),
      };
      if (JSON.stringify(normalized) !== value.body) inputInvalid("Prepared connection body is not canonical");
      expectedRevision = parsed.data.expected_revision;
    } else {
      const parsed = ComputerAgentConnectionDisableSchema.safeParse(bodyValue);
      if (!parsed.success || JSON.stringify(parsed.data) !== value.body) inputInvalid("Prepared disable body is invalid");
      expectedRevision = parsed.data.expected_revision;
    }
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision !== expectedRevision) {
      inputInvalid("Mutation intent revision does not match its frozen body");
    }
    let previous: ComputerAgentConnection | undefined;
    if (value.previous !== undefined) {
      previous = parseConnection(value.previous, true);
      if (previous.connection_id !== connectionId || previous.revision !== expectedRevision) {
        inputInvalid("Mutation intent does not match its current connection revision");
      }
    } else if (method === "DELETE" || expectedRevision !== 0) {
      inputInvalid("Mutation intent is missing its current connection revision");
    }
    return value as unknown as ConnectionMutation;
  }
  function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  function checkMutationReceipt(raw: unknown, intent: ConnectionMutation): ComputerAgentConnection {
    const value = decodeEnvelope(raw, intent.deploymentGeneration);
    const connection = parseConnection(value, false);
    if (connection.connection_id !== intent.connectionId ||
        connection.revision !== intent.expectedRevision + 1 ||
        connection.state !== (intent.method === "PUT" ? "ENABLED" : "DISABLED") ||
        (intent.previous !== undefined && (connection.owner_principal_ref !== intent.previous.owner_principal_ref ||
          connection.created_at !== intent.previous.created_at))) responseInvalid();
    if (intent.method === "PUT") {
      const input = ComputerAgentConnectionPutSchema.parse(JSON.parse(intent.body));
      if (connection.display_name !== input.display_name || connection.contour !== input.contour ||
          connection.actor.issuer !== input.actor.issuer ||
          connection.actor.authentication_method !== input.actor.authentication_method ||
          connection.actor.subject !== input.actor.subject ||
          !sameStrings(connection.transport_capabilities, input.transport_capabilities) ||
          !sameStrings(connection.computer_capabilities, input.computer_capabilities) ||
          !sameStrings(connection.task_kinds, input.task_kinds)) responseInvalid();
    } else if (intent.previous === undefined ||
        connection.display_name !== intent.previous.display_name || connection.contour !== intent.previous.contour ||
        connection.actor.issuer !== intent.previous.actor.issuer ||
        connection.actor.authentication_method !== intent.previous.actor.authentication_method ||
        connection.actor.subject !== intent.previous.actor.subject ||
        !sameStrings(connection.transport_capabilities, intent.previous.transport_capabilities) ||
        !sameStrings(connection.computer_capabilities, intent.previous.computer_capabilities) ||
        !sameStrings(connection.task_kinds, intent.previous.task_kinds)) responseInvalid();
    return connection;
  }

  async function readComputerAgentConnections(
    generationValue: string,
    afterConnectionId?: string,
    signal?: AbortSignal,
  ): Promise<ComputerAgentConnectionList> {
    const captured = currentCapture();
    const generation = expectedGeneration(generationValue);
    const after = afterConnectionId === undefined ? "" :
      safeIdentifier(afterConnectionId, "Connection cursor", "COMPUTER_AGENT_CONNECTION_INPUT_INVALID");
    const suffix = after === "" ? "" : `?after_connection_id=${encodeURIComponent(after)}`;
    currentResult(captured, undefined);
    const pending = requestApiWithStatuses(CONNECTIONS_PATH + suffix,
      { method: "GET", ...(signal === undefined ? {} : { signal }) }, [200]);
    const raw = await guarded(captured, pending);
    const parsed = ComputerAgentConnectionListSchema.safeParse(decodeEnvelope(raw, generation));
    if (!parsed.success) responseInvalid();
    const connections = parsed.data.connections.map((item) => parseConnection(item, false));
    const seen = new Set<string>();
    let previousId = after;
    for (const connection of connections) {
      if (connection.connection_id <= previousId || seen.has(connection.connection_id)) responseInvalid();
      seen.add(connection.connection_id);
      previousId = connection.connection_id;
    }
    const next = parsed.data.next_connection_id;
    if (next !== undefined && (connections.length !== 20 || next !== connections.at(-1)?.connection_id)) {
      responseInvalid();
    }
    return currentResult(captured, Object.freeze({ ...parsed.data,
      connections: Object.freeze(connections) }) as ComputerAgentConnectionList);
  }

  function prepareComputerAgentConnectionPut(
    connectionIdValue: string,
    generationValue: string,
    inputValue: unknown,
    currentValue?: ComputerAgentConnection,
  ): ConnectionMutation {
    const captured = currentCapture();
    const connectionId = safeIdentifier(connectionIdValue, "Connection ID", "COMPUTER_AGENT_CONNECTION_INPUT_INVALID");
    const generation = expectedGeneration(generationValue);
    const current = currentValue === undefined ? undefined : parseConnection(currentValue, true);
    if (current !== undefined && current.connection_id !== connectionId) {
      inputInvalid("Current connection does not match the mutation path");
    }
    const parsed = ComputerAgentConnectionPutSchema.safeParse(inputValue);
    if (!parsed.success) inputInvalid("Connection fields do not match the shared contract");
    const expectedRevision = current?.revision ?? 0;
    if (parsed.data.expected_revision !== expectedRevision) {
      inputInvalid("Reload the current connection revision before preparing a mutation");
    }
    if (current !== undefined && (current.actor.issuer !== parsed.data.actor.issuer ||
        current.actor.authentication_method !== parsed.data.actor.authentication_method ||
        current.actor.subject !== parsed.data.actor.subject)) {
      throw fail({ status: 409, code: "COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT",
        message: "A logical connection cannot be reassigned to another service actor" });
    }
    const normalized: ComputerAgentConnectionPut = {
      ...parsed.data,
      transport_capabilities: [...parsed.data.transport_capabilities].sort(),
      computer_capabilities: [...parsed.data.computer_capabilities].sort(),
      task_kinds: [...parsed.data.task_kinds].sort(),
    };
    const body = JSON.stringify(normalized);
    if (new TextEncoder().encode(body).byteLength > MAX_CONNECTION_BYTES) {
      inputInvalid("Connection exceeds the server request byte limit");
    }
    return currentResult(captured, freezeIntent({ connectionId, deploymentGeneration: generation,
      expectedRevision, method: "PUT", body, ...(current === undefined ? {} : { previous: current }) }));
  }

  function prepareComputerAgentConnectionDisable(
    currentValue: ComputerAgentConnection,
    generationValue: string,
  ): ConnectionMutation {
    const captured = currentCapture();
    const current = parseConnection(currentValue, true);
    const generation = expectedGeneration(generationValue);
    const parsed = ComputerAgentConnectionDisableSchema.safeParse({ expected_revision: current.revision });
    if (!parsed.success) inputInvalid("Connection revision cannot be disabled");
    return currentResult(captured, freezeIntent({ connectionId: current.connection_id,
      deploymentGeneration: generation, expectedRevision: current.revision, method: "DELETE",
      body: JSON.stringify(parsed.data), previous: current }));
  }

  async function executeComputerAgentConnectionMutation(
    intentValue: ComputerAgentConnectionMutationIntent,
    signal?: AbortSignal,
  ): Promise<ComputerAgentConnection> {
    const captured = currentCapture();
    const intent = intentInput(intentValue);
    const path = `${CONNECTIONS_PATH}/${encodeURIComponent(intent.connectionId)}`;
    currentResult(captured, undefined);
    const pending = requestApiWithStatuses(path, {
      method: intent.method,
      headers: { "content-type": "application/json", "idempotency-key": intent.idempotencyKey,
        "x-eliotr-csrf": "1" },
      body: intent.body,
      ...(signal === undefined ? {} : { signal }),
    }, [200]);
    const raw = await guarded(captured, pending);
    return currentResult(captured, checkMutationReceipt(raw, intent));
  }

  async function readComputerAgentQualification(
    currentValue: ComputerAgentConnection,
    transportValue: ComputerAgentQualificationTransport,
    generationValue: string,
    signal?: AbortSignal,
  ): Promise<ComputerAgentQualificationStatus> {
    const captured = currentCapture();
    const generation = expectedGeneration(generationValue);
    const current = parseConnection(currentValue, true);
    const transport = ComputerAgentQualificationTransportSchema.safeParse(transportValue);
    if (!transport.success || current.state !== "ENABLED" ||
        !current.transport_capabilities.includes(transport.data) ||
        !current.task_kinds.includes("RESEARCH_BRANCH_ANALYSIS")) {
      inputInvalid("Selected qualification transport is unsupported by this enabled connection",
        "COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID");
    }
    const path = `${CONNECTIONS_PATH}/${encodeURIComponent(current.connection_id)}/qualifications/${transport.data}`;
    currentResult(captured, undefined);
    const pending = requestApiWithStatuses(path,
      { method: "GET", ...(signal === undefined ? {} : { signal }) }, [200]);
    const raw = await guarded(captured, pending);
    const parsed = ComputerAgentQualificationStatusSchema.safeParse(decodeEnvelope(raw, generation));
    if (!parsed.success) responseInvalid();
    const status = parsed.data;
    validateGeneration(status.deployment_generation, generation);
    if (status.connection_id !== current.connection_id || status.connection_revision !== current.revision ||
        status.transport !== transport.data) {
      throw fail({ status: 409, code: "COMPUTER_AGENT_QUALIFICATION_STALE",
        message: "Qualification evidence belongs to another connection revision or transport" });
    }
    if (!canonicalInstant(status.issued_at) || !canonicalInstant(status.expires_at) ||
        Date.parse(status.expires_at) <= Date.parse(status.issued_at) ||
        (status.observed_at !== undefined && !canonicalInstant(status.observed_at)) ||
        (status.ready_until !== undefined && !canonicalInstant(status.ready_until))) responseInvalid();
    return currentResult(captured, Object.freeze(status));
  }

  return Object.freeze({
    readComputerAgentConnections,
    prepareComputerAgentConnectionPut,
    prepareComputerAgentConnectionDisable,
    executeComputerAgentConnectionMutation,
    readComputerAgentQualification,
  });
}
