/** Owner client for the existing durable computer-agent dispatch route and canonical status read. */
import {
  ComputerAgentConnectionSchema,
  ComputerAgentDispatchCreateSchema,
  ComputerAgentDispatchSchema,
  ComputerAgentDispatchStatusSchema,
  ComputerAgentQualificationTransportSchema,
  RESEARCH_REQUEST_MAX_BYTES,
  ProjectComputerAgentRouteReadinessSchema,
  type ComputerAgentConnection,
  type ComputerAgentDispatch,
  type ComputerAgentDispatchStatus,
  type ComputerAgentQualificationTransport,
  type ProjectComputerAgentRouteReadiness,
} from "@eliotr/contracts";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROJECTS_PATH = "/api/v1/research/projects";
const MAX_DISPATCH_CREATE_BYTES = RESEARCH_REQUEST_MAX_BYTES + 32_768;

export interface ComputerAgentDispatchCreateIntent {
  readonly projectId: string;
  readonly deploymentGeneration: string;
  readonly ownerPrincipalRef: string;
  readonly ownerCredentialGeneration: string;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly actorIssuer: string;
  readonly actorSubject: string;
  readonly idempotencyKey: string;
  readonly body: string;
}

type TaskHttp = Pick<LegacyHttpAdapter, "requestApiWithStatuses">;
type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type ComputerAgentDispatchTaskStatus = DeepReadonly<ComputerAgentDispatchStatus>;
export type ComputerAgentRouteReadiness = DeepReadonly<ProjectComputerAgentRouteReadiness>;

/**
 * The client prepares one immutable, idempotent owner action. The Worker rechecks the current route,
 * enabled connection, grant and qualification before writing the durable dispatch to D1.
 */
export function createComputerAgentTaskApi(
  http: TaskHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
  identity: { readonly mint: () => string },
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

  function inputInvalid(message: string): never {
    throw fail({ status: 400, code: "COMPUTER_AGENT_DISPATCH_INPUT_INVALID", message });
  }
  function responseInvalid(): never {
    throw fail({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "Computer-agent task response does not match its shared contract" });
  }
  function generationChanged(): never {
    throw fail({ status: 409, code: "API_GENERATION_MISMATCH",
      message: "Deployment changed; discard computer-agent task state and reload", retryable: true });
  }
  function identifier(value: unknown, label: string): string {
    if (typeof value !== "string" || /[\u0000-\u0020\u007f]/u.test(value) || !IDENTIFIER.test(value)) {
      inputInvalid(`${label} is invalid`);
    }
    return value;
  }
  function expectedGeneration(value: string): string {
    return identifier(value, "Deployment generation");
  }
  function exactEnvelopeData(value: unknown, generation: string): unknown {
    if (typeof value !== "object" || value === null || Array.isArray(value)) responseInvalid();
    const envelope = value as Record<string, unknown>;
    if (Object.keys(envelope).length !== 3 || !Object.hasOwn(envelope, "data") ||
        !Object.hasOwn(envelope, "trace_id") || !Object.hasOwn(envelope, "deployment_generation")) {
      responseInvalid();
    }
    if (typeof envelope.trace_id !== "string" || !TRACE.test(envelope.trace_id) || /\s/u.test(envelope.trace_id) ||
        typeof envelope.deployment_generation !== "string" || !IDENTIFIER.test(envelope.deployment_generation) ||
        /[\u0000-\u0020\u007f]/u.test(envelope.deployment_generation)) responseInvalid();
    if (envelope.deployment_generation !== generation) generationChanged();
    return envelope.data;
  }
  function readinessPath(projectId: string, transport: ComputerAgentQualificationTransport): string {
    return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS/readiness/${transport}`;
  }
  function dispatchPath(projectId: string): string {
    return `${PROJECTS_PATH}/${encodeURIComponent(projectId)}/computer-agent-dispatches`;
  }
  function statusPath(projectId: string, dispatchId: string): string {
    return `${dispatchPath(projectId)}/${encodeURIComponent(dispatchId)}`;
  }
  function freezeDispatch(dispatch: ComputerAgentDispatch): ComputerAgentDispatch {
    Object.freeze(dispatch.actor);
    Object.freeze(dispatch.qualification);
    Object.freeze(dispatch.run_request.scope_expression);
    Object.freeze(dispatch.run_request.literals);
    Object.freeze(dispatch.run_request);
    return Object.freeze(dispatch);
  }
  function freezeStatus(status: ComputerAgentDispatchStatus): ComputerAgentDispatchTaskStatus {
    freezeDispatch(status.dispatch);
    if (status.acceptance !== null) {
      Object.freeze(status.acceptance.investigation_ref);
      Object.freeze(status.acceptance.actor);
      Object.freeze(status.acceptance);
    }
    if (status.abandonment !== null) Object.freeze(status.abandonment);
    if (status.decline !== null) {
      Object.freeze(status.decline.actor);
      Object.freeze(status.decline);
    }
    if (status.reassignment !== null) Object.freeze(status.reassignment);
    return Object.freeze(status) as ComputerAgentDispatchTaskStatus;
  }

  async function readComputerAgentRouteReadiness(
    projectIdValue: string,
    transportValue: ComputerAgentQualificationTransport,
    generationValue: string,
    signal?: AbortSignal,
  ): Promise<ComputerAgentRouteReadiness> {
    const captured = currentCapture();
    const projectId = identifier(projectIdValue, "Project ID");
    const generation = expectedGeneration(generationValue);
    const transport = ComputerAgentQualificationTransportSchema.safeParse(transportValue);
    if (!transport.success) inputInvalid("Computer-agent transport is invalid");
    const raw = await guarded(captured, requestApiWithStatuses(readinessPath(projectId, transport.data), {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    }, [200]));
    const parsed = ProjectComputerAgentRouteReadinessSchema.safeParse(exactEnvelopeData(raw, generation));
    if (!parsed.success || parsed.data.project_id !== projectId ||
        parsed.data.task_kind !== "RESEARCH_BRANCH_ANALYSIS" || parsed.data.transport !== transport.data ||
        parsed.data.deployment_generation !== generation) responseInvalid();
    for (const entry of parsed.data.entries) {
      if (entry.transport !== transport.data) responseInvalid();
    }
    return currentResult(captured, Object.freeze({ ...parsed.data, entries: Object.freeze(parsed.data.entries.map(entry =>
      Object.freeze({ ...entry, ...(entry.qualification === null ? {} : { qualification: Object.freeze({ ...entry.qualification }) }) }))) }) as ComputerAgentRouteReadiness);
  }

  function prepareComputerAgentDispatch(
    projectIdValue: string,
    generationValue: string,
    ownerPrincipalRefValue: string,
    ownerCredentialGenerationValue: string,
    connectionValue: ComputerAgentConnection,
    inputValue: unknown,
  ): ComputerAgentDispatchCreateIntent {
    const captured = currentCapture();
    currentResult(captured, undefined);
    const projectId = identifier(projectIdValue, "Project ID");
    const generation = expectedGeneration(generationValue);
    const ownerPrincipalRef = identifier(ownerPrincipalRefValue, "Owner principal");
    const ownerCredentialGeneration = identifier(ownerCredentialGenerationValue, "Owner credential generation");
    const parsedConnection = ComputerAgentConnectionSchema.safeParse(connectionValue);
    if (!parsedConnection.success || parsedConnection.data.state !== "ENABLED" ||
        parsedConnection.data.owner_principal_ref !== ownerPrincipalRef) {
      inputInvalid("Dispatch target must be a current enabled connection for this owner");
    }
    const parsed = ComputerAgentDispatchCreateSchema.safeParse(inputValue);
    if (!parsed.success || parsed.data.connection_id !== parsedConnection.data.connection_id ||
        parsed.data.connection_revision !== parsedConnection.data.revision ||
        parsed.data.run_request.scope_expression.project_id !== projectId) {
      inputInvalid("Dispatch request does not match the selected connection and project");
    }
    const body = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(body).byteLength > MAX_DISPATCH_CREATE_BYTES) {
      inputInvalid("Dispatch request exceeds its byte envelope");
    }
    const idempotencyKey = `computer-agent-dispatch-${identity.mint()}`;
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) inputInvalid("Dispatch identity supplier returned an invalid key");
    return Object.freeze({
      projectId,
      deploymentGeneration: generation,
      ownerPrincipalRef,
      ownerCredentialGeneration,
      connectionId: parsedConnection.data.connection_id,
      connectionRevision: parsedConnection.data.revision,
      actorIssuer: parsedConnection.data.actor.issuer,
      actorSubject: parsedConnection.data.actor.subject,
      idempotencyKey,
      body,
    });
  }

  function validateIntent(value: unknown): ComputerAgentDispatchCreateIntent {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.isFrozen(value)) {
      inputInvalid("Dispatch must be the original prepared immutable intent");
    }
    const intent = value as Record<string, unknown>;
    const keys = ["projectId", "deploymentGeneration", "ownerPrincipalRef", "ownerCredentialGeneration",
      "connectionId", "connectionRevision", "actorIssuer", "actorSubject", "idempotencyKey", "body"];
    if (Object.keys(intent).length !== keys.length || keys.some(key => !Object.hasOwn(intent, key))) {
      inputInvalid("Dispatch intent has missing or unknown fields");
    }
    identifier(intent.projectId, "Project ID");
    expectedGeneration(intent.deploymentGeneration as string);
    identifier(intent.ownerPrincipalRef, "Owner principal");
    identifier(intent.ownerCredentialGeneration, "Owner credential generation");
    identifier(intent.connectionId, "Connection ID");
    identifier(intent.actorIssuer, "Connection issuer");
    identifier(intent.actorSubject, "Connection subject");
    if (!Number.isSafeInteger(intent.connectionRevision) || (intent.connectionRevision as number) < 1 ||
        typeof intent.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(intent.idempotencyKey) ||
        typeof intent.body !== "string" || new TextEncoder().encode(intent.body).byteLength > MAX_DISPATCH_CREATE_BYTES) {
      inputInvalid("Dispatch intent is invalid");
    }
    let bodyValue: unknown;
    try { bodyValue = JSON.parse(intent.body); }
    catch { inputInvalid("Dispatch intent body is not valid JSON"); }
    const parsed = ComputerAgentDispatchCreateSchema.safeParse(bodyValue);
    if (!parsed.success || JSON.stringify(parsed.data) !== intent.body ||
        parsed.data.connection_id !== intent.connectionId || parsed.data.connection_revision !== intent.connectionRevision ||
        parsed.data.run_request.scope_expression.project_id !== intent.projectId) {
      inputInvalid("Dispatch intent body differs from the prepared identity");
    }
    return value as ComputerAgentDispatchCreateIntent;
  }

  async function executeComputerAgentDispatch(
    value: ComputerAgentDispatchCreateIntent,
    signal?: AbortSignal,
  ): Promise<ComputerAgentDispatch> {
    const intent = validateIntent(value);
    const captured = currentCapture();
    currentResult(captured, undefined);
    const raw = await guarded(captured, requestApiWithStatuses(dispatchPath(intent.projectId), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": intent.idempotencyKey },
      body: intent.body,
      ...(signal === undefined ? {} : { signal }),
    }, [200]));
    const requested = ComputerAgentDispatchCreateSchema.parse(JSON.parse(intent.body));
    const parsed = ComputerAgentDispatchSchema.safeParse(exactEnvelopeData(raw, intent.deploymentGeneration));
    if (!parsed.success || parsed.data.project_id !== intent.projectId ||
        parsed.data.owner_principal_ref !== intent.ownerPrincipalRef ||
        parsed.data.owner_credential_generation !== intent.ownerCredentialGeneration ||
        parsed.data.connection_id !== intent.connectionId ||
        parsed.data.connection_revision !== intent.connectionRevision ||
        parsed.data.transport !== requested.transport ||
        parsed.data.route_revision !== requested.expected_route_revision ||
        parsed.data.client_grant_id !== requested.client_grant_id ||
        parsed.data.client_grant_revision !== requested.client_grant_revision ||
        parsed.data.actor.issuer !== intent.actorIssuer || parsed.data.actor.subject !== intent.actorSubject ||
        parsed.data.run_request.query !== requested.run_request.query ||
        parsed.data.run_request.scope_expression.project_id !== intent.projectId) responseInvalid();
    return currentResult(captured, freezeDispatch(parsed.data));
  }

  async function readComputerAgentDispatchStatus(
    projectIdValue: string,
    dispatchIdValue: string,
    generationValue: string,
    ownerPrincipalRefValue: string,
    ownerCredentialGenerationValue: string,
    signal?: AbortSignal,
  ): Promise<ComputerAgentDispatchTaskStatus> {
    const captured = currentCapture();
    const projectId = identifier(projectIdValue, "Project ID");
    const dispatchId = identifier(dispatchIdValue, "Dispatch ID");
    const generation = expectedGeneration(generationValue);
    const ownerPrincipalRef = identifier(ownerPrincipalRefValue, "Owner principal");
    const ownerCredentialGeneration = identifier(ownerCredentialGenerationValue, "Owner credential generation");
    const raw = await guarded(captured, requestApiWithStatuses(statusPath(projectId, dispatchId), {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    }, [200]));
    const parsed = ComputerAgentDispatchStatusSchema.safeParse(exactEnvelopeData(raw, generation));
    if (!parsed.success || parsed.data.dispatch.project_id !== projectId ||
        parsed.data.dispatch.dispatch_id !== dispatchId ||
        parsed.data.dispatch.owner_principal_ref !== ownerPrincipalRef ||
        parsed.data.dispatch.owner_credential_generation !== ownerCredentialGeneration) responseInvalid();
    return currentResult(captured, freezeStatus(parsed.data));
  }

  return Object.freeze({
    readComputerAgentRouteReadiness,
    prepareComputerAgentDispatch,
    executeComputerAgentDispatch,
    readComputerAgentDispatchStatus,
  });
}
