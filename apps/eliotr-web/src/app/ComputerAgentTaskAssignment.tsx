import { useEffect, useRef, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, HandoffSheet, Status, type AgentSummary, type HandoffRequest, type TaskScope } from "@eliotr/ui";
import type { ComputerAgentConnection, ComputerAgentDispatchCreateIntent, ComputerAgentDispatchTaskStatus } from "@eliotr/owner-api-client";
import { RESEARCH_DEFAULT_INQUIRY_PROTOCOL_REF, type ComputerAgentQualificationTransport } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "./runtime";
import type { PrivacyController, SessionContext } from "./privacy";
import {
  computerAgentTaskAssignmentActions,
  computerAgentTaskGrantOptions,
  computerAgentTaskRouteReadinessOptions,
  computerAgentTaskStatusOptions,
  computerAgentTaskTargetConnectionsOptions,
} from "../query/computerAgentTaskAssignment";
import { protectedQueryKey } from "../query/client";

type Locale = "en" | "ru";
type AssignmentOperation =
  | { readonly phase: "sending" | "unknown"; readonly context: SessionContext; readonly projectId: string; readonly intent: ComputerAgentDispatchCreateIntent; readonly agent: string }
  | { readonly phase: "created"; readonly context: SessionContext; readonly projectId: string; readonly dispatchId: string; readonly agent: string };

const copy = {
  en: {
    assign: "Assign a question to an agent",
    scope: "The agent receives a research request for this project's full source scope. The next-question source selection does not narrow this task.",
    unavailable: "Agent connections have not been read. Refresh the connection list before assigning a task.",
    noneEnabled: "No owner-enabled agent connection is available for this assignment.",
    changedTarget: "The selected agent connection changed or was disabled. Refresh the connection list and choose again.",
    routeUnavailable: "The selected agent is not eligible in this project's current research route and transport.",
    grantUnavailable: "No active project run grant matches the selected agent.",
    unsupported: "This handoff must be a research request for the selected project.",
    projectChanged: "The owner session or selected project changed. Reopen the task sheet before assigning.",
    prepareFailed: "The assignment could not be prepared. Refresh the project, agent connection and grant, then try again.",
    preparing: "Checking the current route and grant before creating the task offer.",
    sending: (agent: string) => `Submitting the task offer to ${agent}.`,
    unknown: "The assignment outcome is unknown. Its original request and idempotency identity are retained in memory.",
    retry: "Retry the same assignment",
    waiting: (agent: string) => `Task offer saved for ${agent}. Waiting for the agent to accept it.`,
    statusUnavailable: "The task status could not be read.",
    readStatus: "Read task status again",
    accepted: "The agent accepted the task and started the existing Research Workflow.",
    abandoned: "The task offer was withdrawn.",
    declined: "The agent declined the task. No replacement was started.",
    expired: "The task offer expired before acceptance.",
    stale: "The route, grant, connection or qualification changed. Refresh before assigning again.",
    pending: "Waiting for the agent to accept the task offer.",
    another: "Assign another task",
  },
  ru: {
    assign: "Поручить вопрос агенту",
    scope: "Агент получит запрос на исследование всего проекта. Выбор источников для следующего вопроса не сужает область этого поручения.",
    unavailable: "Подключения агентов ещё не прочитаны. Обновите список перед назначением задачи.",
    noneEnabled: "Для этого поручения нет подключённого агента, включённого владельцем.",
    changedTarget: "Подключение выбранного агента изменилось или отключено. Обновите список и выберите ещё раз.",
    routeUnavailable: "Выбранный агент не допущен в текущий маршрут исследования проекта и транспорт.",
    grantUnavailable: "Нет активного разрешения на запуск для выбранного агента в этом проекте.",
    unsupported: "Это поручение должно быть запросом на исследование выбранного проекта.",
    projectChanged: "Сеанс владельца или выбранный проект изменился. Откройте форму поручения ещё раз.",
    prepareFailed: "Не удалось подготовить поручение. Обновите проект, подключение агента и разрешение, затем повторите попытку.",
    preparing: "Проверяется текущий маршрут и разрешение перед созданием поручения.",
    sending: (agent: string) => `Отправляется предложение поручения агенту ${agent}.`,
    unknown: "Результат назначения неизвестен. Исходный запрос и ключ идемпотентности сохранены в памяти.",
    retry: "Повторить то же поручение",
    waiting: (agent: string) => `Поручение для ${agent} сохранено. Ожидается принятие агентом.`,
    statusUnavailable: "Не удалось прочитать статус поручения.",
    readStatus: "Прочитать статус ещё раз",
    accepted: "Агент принял поручение и запустил существующий Research Workflow.",
    abandoned: "Предложение поручения отозвано.",
    declined: "Агент отклонил поручение. Новое не создавалось.",
    expired: "Срок предложения истёк до принятия.",
    stale: "Маршрут, разрешение, подключение или квалификация изменились. Обновите данные перед новым назначением.",
    pending: "Ожидается принятие предложения агентом.",
    another: "Назначить ещё одну задачу",
  },
} as const;

function isSelectable(agent: AgentSummary): boolean {
  return agent.connectionState === "owner-enabled" && agent.presence !== "offline";
}

function hasDefinitiveHttpRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("status" in error) ||
      typeof error.status !== "number") return false;
  return error.status >= 400 && error.status < 500 && ![408, 425, 429, 499].includes(error.status);
}

export function ComputerAgentTaskAssignment({
  locale, apis, privacy, context, projectId, projectTitle, isProjectCurrent, agents, agentConnectionCursor, agentsUnavailable,
}: {
  readonly locale: Locale;
  readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController;
  readonly context: SessionContext;
  readonly projectId: string | undefined;
  readonly projectTitle: string;
  readonly isProjectCurrent: () => boolean;
  readonly agents: readonly AgentSummary[];
  readonly agentConnectionCursor: string | undefined;
  readonly agentsUnavailable: boolean;
}) {
  const client = useQueryClient();
  const text = copy[locale];
  const [openScope, setOpenScope] = useState<{ readonly context: SessionContext; readonly projectId: string }>();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string>();
  const [operation, setOperation] = useState<AssignmentOperation>();
  const sending = useRef(false);
  const currentProject = projectId !== undefined && privacy.isCurrent(context) && isProjectCurrent();
  const sheetOpen = currentProject && openScope?.context === context && openScope.projectId === projectId;
  const visibleOperation = operation?.context === context && operation.projectId === projectId && privacy.isCurrent(context)
    ? operation : undefined;
  const scope: readonly TaskScope[] = projectId === undefined ? [] : [{ id: projectId, kind: "research", label: projectTitle }];
  const actions = computerAgentTaskAssignmentActions(apis, privacy, context, isProjectCurrent);
  const statusOptions = visibleOperation?.phase === "created" && projectId !== undefined
    ? computerAgentTaskStatusOptions(apis, privacy, context, projectId, visibleOperation.dispatchId, isProjectCurrent)
    : undefined;
  const taskStatus = useQuery<ComputerAgentDispatchTaskStatus>(statusOptions ? {
    ...statusOptions,
    refetchInterval: query => query.state.data?.state === "PENDING" ? 5000 : false,
    refetchIntervalInBackground: false,
  } : {
    queryKey: [...protectedQueryKey(context, "computer-agent-task-status"), "unselected"],
    queryFn: skipToken,
  });
  useEffect(() => {
    setOpenScope(undefined);
    setError(undefined);
    setOperation(undefined);
    setPreparing(false);
    sending.current = false;
  }, [context, projectId]);
  useEffect(() => {
    const clearAfterAuthorizationLoss = () => {
      if (privacy.isCurrent(context)) return;
      setOpenScope(undefined);
      setError(undefined);
      setOperation(undefined);
      setPreparing(false);
      sending.current = false;
    };
    const unsubscribe = privacy.subscribe(clearAfterAuthorizationLoss);
    clearAfterAuthorizationLoss();
    return unsubscribe;
  }, [context, privacy]);
  const canOpen = currentProject && !agentsUnavailable && agents.some(isSelectable) &&
    !preparing && !(visibleOperation?.phase === "sending" || visibleOperation?.phase === "unknown") &&
    !(visibleOperation?.phase === "created" && (taskStatus.data === undefined || taskStatus.data.state === "PENDING" || taskStatus.isError));

  const transportCandidates = (connection: ComputerAgentConnection): readonly ComputerAgentQualificationTransport[] => [
    ...(connection.transport_capabilities.includes("MCP_WRITE") ? ["MCP_WRITE" as const] : []),
    ...(connection.transport_capabilities.includes("WEB_INBOX") ? ["WEB_INBOX" as const] : []),
  ];

  async function createAssignment(request: HandoffRequest): Promise<void> {
    if (sending.current) return;
    if (!privacy.isCurrent(context) || projectId === undefined || !isProjectCurrent()) {
      setError(text.projectChanged);
      setOpenScope(undefined);
      return;
    }
    const requestedScope = request.scope[0];
    if (request.target === "eliot" || request.tool !== "request" || request.scope.length !== 1 || requestedScope === undefined || requestedScope.kind !== "research" ||
        requestedScope.id !== projectId || !request.note.trim()) {
      setError(text.unsupported);
      setOpenScope(undefined);
      return;
    }
    const selectedSummary = agents.find(agent => agent.id === request.target);
    if (selectedSummary === undefined || !isSelectable(selectedSummary)) {
      setError(text.changedTarget);
      return;
    }
    sending.current = true;
    setPreparing(true);
    setError(undefined);
    let intent: ComputerAgentDispatchCreateIntent | undefined;
    try {
      const targetPage = await client.fetchQuery(computerAgentTaskTargetConnectionsOptions(
        apis, privacy, context, agentConnectionCursor,
      ));
      if (!privacy.isCurrent(context) || !isProjectCurrent()) throw new Error("Project or owner session changed");
      const connection = targetPage.connections.find(item => item.connection_id === request.target);
      if (connection === undefined || connection.state !== "ENABLED" ||
          connection.owner_principal_ref !== context.principal ||
          selectedSummary.connectionState !== "owner-enabled") {
        throw new Error("target-changed");
      }
      const routeResults = await Promise.all(transportCandidates(connection).map(async transport => {
        try {
          const readiness = await client.fetchQuery(computerAgentTaskRouteReadinessOptions(
            apis, privacy, context, projectId, isProjectCurrent, transport,
          ));
          return { transport, readiness };
        } catch {
          return undefined;
        }
      }));
      if (!privacy.isCurrent(context) || !isProjectCurrent()) throw new Error("Project or owner session changed");
      const eligible = routeResults.flatMap(item => {
        if (item === undefined || item.readiness.route_state !== "ACTIVE") return [];
        const entry = item.readiness.entries.find(candidate => candidate.eligible &&
          candidate.connection_id === connection.connection_id && candidate.connection_revision === connection.revision &&
          candidate.transport === item.transport);
        return entry === undefined ? [] : [{ ...item, entry }];
      })[0];
      if (eligible === undefined) throw new Error("route-unavailable");
      const grant = await client.fetchQuery(computerAgentTaskGrantOptions(
        apis, privacy, context, projectId, isProjectCurrent, connection,
      ));
      if (grant === null || grant.state !== "ACTIVE" || !grant.allowed_operations.includes("run")) {
        throw new Error("grant-unavailable");
      }
      if (!privacy.isCurrent(context) || !isProjectCurrent()) throw new Error("Project or owner session changed");
      const runRequest: unknown = {
        ...JSON.parse(apis.research.runs.researchRunBody(request.note.trim(), [], 8, projectId)),
        request_version: "eliotr.research-run-request.v2",
        inquiry_protocol_ref: RESEARCH_DEFAULT_INQUIRY_PROTOCOL_REF,
      };
      const input = {
        transport: eligible.transport,
        expected_route_revision: eligible.readiness.route_revision,
        connection_id: connection.connection_id,
        connection_revision: connection.revision,
        client_grant_id: grant.grant_id,
        client_grant_revision: grant.revision,
        expires_in_seconds: 900,
        run_request: runRequest,
      };
      intent = actions.prepare(projectId, connection, input);
      setOperation({ phase: "sending", context, projectId, intent, agent: connection.display_name });
      const dispatch = await actions.execute(intent);
      setOperation({ phase: "created", context, projectId, dispatchId: dispatch.dispatch_id,
        agent: connection.display_name });
      setOpenScope(undefined);
    } catch (error) {
      if (!privacy.isCurrent(context)) {
        setOpenScope(undefined);
        setOperation(undefined);
      } else if (intent !== undefined && !hasDefinitiveHttpRejection(error)) {
        setOperation({ phase: "unknown", context, projectId, intent, agent: selectedSummary.name });
        setOpenScope(undefined);
      } else {
        const reason = error instanceof Error ? error.message : "";
        setOperation(undefined);
        setError(reason === "target-changed" ? text.changedTarget
          : reason === "route-unavailable" ? text.routeUnavailable
            : reason === "grant-unavailable" ? text.grantUnavailable
              : reason === "Project or owner session changed" || reason === "Agent assignment requires the current owner project" ? text.projectChanged
                : text.prepareFailed);
        if (reason === "Project or owner session changed" || reason === "Agent assignment requires the current owner project") {
          setOpenScope(undefined);
        }
      }
    } finally {
      sending.current = false;
      setPreparing(false);
    }
  }

  async function retrySameAssignment(): Promise<void> {
    const current = visibleOperation;
    if (current?.phase !== "unknown" || sending.current || !privacy.isCurrent(context) ||
        projectId === undefined || !isProjectCurrent()) return;
    sending.current = true;
    setPreparing(true);
    setOperation({ ...current, phase: "sending" });
    try {
      const dispatch = await actions.execute(current.intent);
      setOperation({ phase: "created", context, projectId, dispatchId: dispatch.dispatch_id, agent: current.agent });
    } catch (error) {
      if (!privacy.isCurrent(context) || hasDefinitiveHttpRejection(error)) {
        setOperation(undefined);
        if (privacy.isCurrent(context)) setError(text.prepareFailed);
      } else {
        setOperation({ ...current, phase: "unknown" });
      }
    } finally {
      sending.current = false;
      setPreparing(false);
    }
  }

  function assignmentStatus(): string | undefined {
    if (visibleOperation?.phase !== "created") return undefined;
    if (taskStatus.isError) return text.statusUnavailable;
    if (!taskStatus.data) return text.waiting(visibleOperation.agent);
    switch (taskStatus.data.state) {
      case "PENDING": return text.pending;
      case "ACCEPTED": return text.accepted;
      case "ABANDONED": return text.abandoned;
      case "DECLINED": return text.declined;
      case "EXPIRED": return text.expired;
      case "STALE": return text.stale;
    }
    return text.statusUnavailable;
  }

  const statusMessage = assignmentStatus();
  return <section className="er-live-agent-assignment" aria-label={text.assign}>
    <p>{text.scope}</p>
    {agentsUnavailable ? <Status>{text.unavailable}</Status>
      : agents.every(agent => !isSelectable(agent)) ? <Status>{text.noneEnabled}</Status> : null}
    {error ? <Status>{error}</Status> : null}
    {visibleOperation?.phase === "unknown" && <div className="er-live-callout er-live-callout--attention">
      <Status>{text.unknown}</Status>
      <Button variant="tonal" disabled={preparing || !currentProject} onClick={() => { void retrySameAssignment(); }}>
        {text.retry}
      </Button>
    </div>}
    {preparing && visibleOperation?.phase !== "sending" && <Status announce>{text.preparing}</Status>}
    {visibleOperation?.phase === "sending" && <Status announce>{text.sending(visibleOperation.agent)}</Status>}
    {visibleOperation?.phase === "created" && <div className="er-live-callout">
      <Status announce>{statusMessage ?? text.statusUnavailable}</Status>
      {taskStatus.isError && <Button variant="text" disabled={taskStatus.isFetching || !currentProject}
        onClick={() => { void taskStatus.refetch(); }}>{text.readStatus}</Button>}
    </div>}
    <Button variant="tonal" disabled={!canOpen} onClick={() => {
      if (projectId !== undefined) { setError(undefined); setOpenScope({ context, projectId }); }
    }}>
      {visibleOperation?.phase === "created" ? text.another : text.assign}
    </Button>
    {sheetOpen && projectId !== undefined && <HandoffSheet locale={locale} open agents={agents} allowSystemTarget={false}
      sending={preparing} submissionError={error} tools={[]} scope={scope} initialTool="request"
      onSend={request => { void createAssignment(request); }}
      onClose={() => { if (!preparing) setOpenScope(undefined); }} />}
  </section>;
}
