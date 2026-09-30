from pathlib import Path
from textwrap import dedent

ROOT = Path(__file__).resolve().parents[2]


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(dedent(content).lstrip(), encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


def append_once(path: str, marker: str, content: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    if marker in text:
        return
    target.write_text(text.rstrip() + "\n\n" + dedent(content).strip() + "\n", encoding="utf-8")


replace_once(
    "packages/contracts/src/computer-agent-route.ts",
    '''import {
  ComputerAgentActorSchema,
  ComputerAgentTaskKindSchema,
} from "./computer-agent-connection.js";
''',
    '''import {
  ComputerAgentActorSchema,
  ComputerAgentContourSchema,
  ComputerAgentTaskKindSchema,
} from "./computer-agent-connection.js";
import {
  ComputerAgentQualificationStatusSchema,
  ComputerAgentQualificationStatusValueSchema,
  ComputerAgentQualificationTransportSchema,
} from "./computer-agent-qualification.js";
''',
)
append_once("packages/contracts/src/computer-agent-route.ts",
    "export const ProjectComputerAgentRouteReadinessSchema",
    r'''
export const ComputerAgentRouteConnectionStateSchema = z.enum(["CURRENT", "STALE", "DISABLED"]);
export const ComputerAgentRouteCapabilityStateSchema = z.enum([
  "SUPPORTED", "UNSUPPORTED_TRANSPORT", "UNSUPPORTED_TASK",
]);
export const ComputerAgentRouteQualificationStateSchema = z.union([
  ComputerAgentQualificationStatusValueSchema,
  z.literal("UNQUALIFIED"),
]);

export const ProjectComputerAgentRouteReadinessEntrySchema = z.object({
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
  display_name: z.string().min(1).max(128),
  contour: ComputerAgentContourSchema,
  transport: ComputerAgentQualificationTransportSchema,
  connection_state: ComputerAgentRouteConnectionStateSchema,
  capability_state: ComputerAgentRouteCapabilityStateSchema,
  qualification_state: ComputerAgentRouteQualificationStateSchema,
  qualification: ComputerAgentQualificationStatusSchema.nullable(),
  eligible: z.boolean(),
}).strict().superRefine((value, context) => {
  const shouldBeEligible = value.connection_state === "CURRENT" &&
    value.capability_state === "SUPPORTED" &&
    value.qualification_state === "READY" &&
    value.qualification?.status === "READY";
  if (value.eligible !== shouldBeEligible) {
    context.addIssue({ code: "custom", message: "Route readiness eligibility is inconsistent" });
  }
});
export type ProjectComputerAgentRouteReadinessEntry =
  z.infer<typeof ProjectComputerAgentRouteReadinessEntrySchema>;

const preferredReady = z.object({
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
}).strict();

export const ProjectComputerAgentRouteReadinessSchema = z.object({
  protocol: z.literal("eliotr.project-computer-agent-route-readiness.v1"),
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  route_revision: revision,
  route_state: z.enum(["ACTIVE", "DISABLED"]),
  strategy: z.literal("ORIGINATING_MATCH"),
  transport: ComputerAgentQualificationTransportSchema,
  deployment_generation: id,
  observed_at: IsoDateTimeSchema,
  entries: z.array(ProjectComputerAgentRouteReadinessEntrySchema).min(1).max(16),
  preferred_ready_connection: preferredReady.nullable(),
}).strict().superRefine((value, context) => {
  const eligible = value.route_state === "ACTIVE"
    ? value.entries.find((entry) => entry.eligible)
    : undefined;
  const preferred = value.preferred_ready_connection;
  if ((eligible === undefined) !== (preferred === null) ||
      (eligible !== undefined && preferred !== null && (
        eligible.priority !== preferred.priority ||
        eligible.connection_id !== preferred.connection_id ||
        eligible.connection_revision !== preferred.connection_revision
      ))) {
    context.addIssue({ code: "custom", message: "Preferred ready connection is inconsistent" });
  }
});
export type ProjectComputerAgentRouteReadiness =
  z.infer<typeof ProjectComputerAgentRouteReadinessSchema>;
''')

append_once("apps/eliotr-core/src/computer-agent-qualification-store.ts",
    "export async function readComputerAgentQualificationStatusForConnection",
    r'''
export async function readComputerAgentQualificationStatusForConnection(input: {
  readonly database: D1Database;
  readonly connection_id: string;
  readonly connection_revision: number;
  readonly transport: ComputerAgentQualificationTransport;
  readonly now?: () => number;
}): Promise<ComputerAgentQualificationStatus | null> {
  const now = input.now ?? Date.now;
  await requireSchema(input.database);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(input.connection_id) ||
      !Number.isSafeInteger(input.connection_revision) || input.connection_revision < 1 ||
      input.connection_revision > 2_147_483_647) {
    fail("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400,
      "Connection qualification identity is invalid");
  }
  const selectedTransport = transport(input.transport);
  const row = await latest(input.database, input.connection_id,
    input.connection_revision, selectedTransport);
  if (row === null) return null;
  const status = await statusFromRow(row, nowValue(now));
  if (status.connection_id !== input.connection_id ||
      status.connection_revision !== input.connection_revision ||
      status.transport !== selectedTransport) {
    fail("COMPUTER_AGENT_QUALIFICATION_STORAGE_CORRUPT", 500,
      "Connection qualification readback identity is corrupt");
  }
  return status;
}
''')

write("apps/eliotr-core/src/computer-agent-route-readiness.ts", r'''
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
    const entry = route.connections[priority]!;
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
''')

replace_once(
    "apps/eliotr-core/src/computer-agent-route-http.ts",
    'import type { Env } from "./env.js";\n',
    'import type { Env } from "./env.js";\n'
    'import { readProjectComputerAgentRouteReadiness } from "./computer-agent-route-readiness.js";\n',
)
replace_once(
    "apps/eliotr-core/src/computer-agent-route-http.ts",
    '''    if (request.method === "GET") {
      return apiResult(request, env, await service.get(context, projectId, taskKind));
    }
''',
    '''    if (request.method === "GET") {
      if (params.transport !== undefined) {
        return apiResult(request, env, await readProjectComputerAgentRouteReadiness({
          database: env.CORE_DB,
          context,
          project_id: projectId,
          task_kind: taskKind,
          transport: params.transport,
          deployment_generation: env.DEPLOYMENT_GENERATION,
        }));
      }
      return apiResult(request, env, await service.get(context, projectId, taskKind));
    }
''',
)

replace_once(
    "packages/interfaces/src/routes.ts",
    '  { method: "DELETE", path: "/api/v1/research/projects/:project_id/computer-agent-routes/:task_kind", operation: "research.computer-agent-routes.disable", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n',
    '  { method: "DELETE", path: "/api/v1/research/projects/:project_id/computer-agent-routes/:task_kind", operation: "research.computer-agent-routes.disable", auth: "owner", maximum_request_bytes: 1024, response_mode: "json" },\n'
    '  { method: "GET", path: "/api/v1/research/projects/:project_id/computer-agent-routes/:task_kind/readiness/:transport", operation: "research.computer-agent-routes.readiness", auth: "owner", maximum_request_bytes: 0, response_mode: "json" },\n',
)

replace_once(
    "apps/eliotr-core/src/http-special-routes.ts",
    '    case "research.computer-agent-routes.disable":\n',
    '    case "research.computer-agent-routes.disable":\n'
    '    case "research.computer-agent-routes.readiness":\n',
)

append_once("docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    "## 7. Readiness-aware route preview",
    r'''
## 7. Readiness-aware route preview

The owner-only route-readiness endpoint now combines the active ordered route, exact connection revisions,
declared task/transport capabilities, latest exact qualification and current deployment into one read-only
report. Each entry reports connection, capability and qualification state; the first eligible entry becomes
`preferred_ready_connection`. Missing qualification is `UNQUALIFIED`, not inferred READY. Qualification
for another deployment is `STALE`.

This preview is not dispatch. It does not create a run, call an agent, alter a route, confirm a challenge,
move a task or transfer a lease. It makes future preferred-agent selection auditable before any mutation
protocol is introduced.
''')
append_once("docs/adr/0008-computer-agent-web-inbox.md",
    "## Route readiness preview",
    r'''
## Route readiness preview

Owners may inspect
`/api/v1/research/projects/<project_id>/computer-agent-routes/RESEARCH_BRANCH_ANALYSIS/readiness/WEB_INBOX`
before starting work. The report preserves route priority but marks an entry eligible only when the exact
connection revision is still current/enabled, declares `WEB_INBOX` and the task kind, and has READY
qualification for the current deployment. `preferred_ready_connection` is advisory observation only.
''')
append_once("docs/implementation/computer-agent-web-inbox.md",
    "## Inspect readiness without dispatch",
    r'''
## Inspect readiness without dispatch

Use the owner-only route readiness GET endpoint with `WEB_INBOX` to see ordered Spark/Muse/Dot entries,
exact revisions, declared capabilities, latest qualification state and the first currently eligible entry.
`UNQUALIFIED`, `EXPIRED`, `ACTOR_MISMATCH`, `STALE`, unsupported capability and stale connection revisions
remain distinct. Reading the report does not select an agent or reserve work.
''')
append_once("docs/implementation/muse-operator-runbook.md",
    "## Preview the preferred ready contour",
    r'''
## Preview the preferred ready contour

Before manual dispatch, the owner can read the project route readiness report for `MCP_WRITE` or
`WEB_INBOX`. The first eligible ordered entry is returned as `preferred_ready_connection`, while every
other entry retains its exact reason for ineligibility. This is a planning signal only: the agent that starts
a delegated run must still be the verified originating actor present in the active route.
''')
