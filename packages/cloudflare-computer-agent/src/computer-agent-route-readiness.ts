import {
  ComputerAgentQualificationTransportSchema,
  ProjectComputerAgentRouteReadinessSchema,
  type ComputerAgentQualificationTransport,
  type ProjectComputerAgentRouteReadiness,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentConnectionError,
  readComputerAgentConnectionRevision,
  readCurrentComputerAgentConnection,
} from "./computer-agent-connection-store.js";
import {
  ComputerAgentQualificationError,
  readComputerAgentQualificationStatusForConnection,
} from "./computer-agent-qualification-store.js";
import {
  ComputerAgentRouteError,
  createProjectComputerAgentRouteService,
} from "./computer-agent-route-store.js";

function fail(code: ComputerAgentRouteError["code"], status: number,
  message: string, retryable = false): never {
  throw new ComputerAgentRouteError(code, status, message, retryable);
}
function mapConnection(error: unknown): never {
  if (error instanceof ComputerAgentRouteError) throw error;
  if (error instanceof ComputerAgentConnectionError) {
    fail(error.retryable ? "COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE" :
      error.code === "COMPUTER_AGENT_CONNECTION_STORAGE_CORRUPT"
        ? "COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT"
        : "COMPUTER_AGENT_ROUTE_AUTHORITY_STALE",
    error.retryable ? 503 : error.status,
    "Computer-agent connection readiness could not be resolved", error.retryable);
  }
  throw error;
}
function mapQualification(error: unknown): never {
  if (error instanceof ComputerAgentRouteError) throw error;
  if (error instanceof ComputerAgentQualificationError) {
    fail(error.retryable ? "COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE" :
      error.code === "COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT"
        ? "COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT"
        : "COMPUTER_AGENT_ROUTE_AUTHORITY_STALE",
    error.retryable ? 503 : error.status,
    "Computer-agent qualification readiness could not be resolved", error.retryable);
  }
  throw error;
}
function parseTransport(value: unknown): ComputerAgentQualificationTransport {
  const parsed = ComputerAgentQualificationTransportSchema.safeParse(value);
  if (!parsed.success) {
    fail("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 400, "Readiness transport is invalid");
  }
  return parsed.data;
}
function observedAt(now: () => number): { readonly ms: number; readonly iso: string } {
  let ms: number;
  try { ms = now(); }
  catch { return fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503,
    "Route readiness clock is unavailable", true); }
  if (!Number.isSafeInteger(ms) || ms < 0) {
    fail("COMPUTER_AGENT_ROUTE_STORAGE_UNAVAILABLE", 503,
      "Route readiness clock is invalid", true);
  }
  return { ms, iso: new Date(ms).toISOString() };
}

export async function readProjectComputerAgentRouteReadiness(input: {
  readonly database: D1Database;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly task_kind: string;
  readonly transport: unknown;
  readonly deployment_generation: string;
  readonly now?: () => number;
}): Promise<ProjectComputerAgentRouteReadiness> {
  const now = input.now ?? Date.now;
  const observed = observedAt(now);
  const selectedTransport = parseTransport(input.transport);
  const route = await createProjectComputerAgentRouteService({
    database: input.database,
    now,
  }).get(input.context, input.project_id, input.task_kind);

  const entries = [];
  for (let priority = 0; priority < route.connections.length; priority += 1) {
    const entry = route.connections[priority];
    if (entry === undefined) {
      fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500,
        "Route contains a missing connection entry");
    }
    const [exact, current] = await Promise.all([
      readComputerAgentConnectionRevision(input.database,
        entry.connection_id, entry.connection_revision).catch(mapConnection),
      readCurrentComputerAgentConnection(input.database,
        entry.connection_id).catch(mapConnection),
    ]);
    if (exact === null) {
      fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500,
        "Route references a missing immutable connection revision");
    }
    if (exact.owner_principal_ref !== route.owner_principal_ref) {
      fail("COMPUTER_AGENT_ROUTE_STORAGE_CORRUPT", 500,
        "Route and connection owners differ");
    }
    const connectionState = exact.state !== "ENABLED" || current?.state === "DISABLED"
      ? "DISABLED" as const
      : current === null || current.revision !== exact.revision
        ? "STALE" as const
        : "CURRENT" as const;
    const capabilityState = !exact.task_kinds.includes(route.task_kind)
      ? "UNSUPPORTED_TASK" as const
      : !exact.transport_capabilities.includes(selectedTransport)
        ? "UNSUPPORTED_TRANSPORT" as const
        : "SUPPORTED" as const;
    const qualification = connectionState === "CURRENT" && capabilityState === "SUPPORTED"
      ? await readComputerAgentQualificationStatusForConnection({
          database: input.database,
          connection_id: exact.connection_id,
          connection_revision: exact.revision,
          transport: selectedTransport,
          now,
        }).catch(mapQualification)
      : null;
    const qualificationState = qualification === null
      ? "UNQUALIFIED" as const
      : qualification.deployment_generation !== input.deployment_generation
        ? "STALE" as const
        : qualification.status;
    const eligible = connectionState === "CURRENT" &&
      capabilityState === "SUPPORTED" &&
      qualificationState === "READY" &&
      qualification?.status === "READY" &&
      qualification.ready_until !== undefined &&
      Date.parse(qualification.ready_until) > observed.ms;
    entries.push({
      priority,
      connection_id: exact.connection_id,
      connection_revision: exact.revision,
      display_name: exact.display_name,
      contour: exact.contour,
      transport: selectedTransport,
      connection_state: connectionState,
      capability_state: capabilityState,
      qualification_state: qualificationState,
      qualification,
      eligible,
    });
  }
  const preferred = route.state === "ACTIVE"
    ? entries.find((entry) => entry.eligible)
    : undefined;
  return ProjectComputerAgentRouteReadinessSchema.parse({
    protocol: "eliotr.project-computer-agent-route-readiness.v1",
    project_id: route.project_id,
    task_kind: route.task_kind,
    route_revision: route.revision,
    route_state: route.state,
    strategy: route.strategy,
    transport: selectedTransport,
    deployment_generation: input.deployment_generation,
    observed_at: observed.iso,
    entries,
    preferred_ready_connection: preferred === undefined ? null : {
      priority: preferred.priority,
      connection_id: preferred.connection_id,
      connection_revision: preferred.connection_revision,
    },
  });
}
