import { useId } from "react";
import { skipToken, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { AgentConnectGuide, Button, ConnectionsFeature, OperationAnnouncement } from "@eliotr/ui";
import type { ProjectListView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { connectionsQueryOptions } from "../query/connections";
import { protectedQueryKey, runProtectedRead } from "../query/client";
import { ComputerAgentConnectionsPanel } from "./ComputerAgentConnectionsPanel";
import { usePaneAnnouncement } from "./usePaneAnnouncement";
import { WorkspaceLink } from "../routes/WorkspaceLink";

const copy = {
  en: { reading: 'Reading connection status.', failed: 'Some status checks failed. Review the affected rows.', loaded: 'Connection status checks updated.', choose: "Choose a project", project: "Project source permissions", next: "Next project page", previous: "Previous project page", modelSettings: "Model and provider settings are global; open Settings to connect an external provider.", openSettings: "Open settings" },
  ru: { reading: 'Читается статус подключений.', failed: 'Некоторые проверки статуса завершились ошибкой. Проверьте соответствующие строки.', loaded: 'Проверки статуса подключений обновлены.', choose: "Выберите проект", project: "Доступ к источникам проекта", next: "Следующая страница проектов", previous: "Предыдущая страница проектов", modelSettings: "Настройки моделей и провайдеров общие; внешний провайдер подключается в Настройках", openSettings: "Открыть настройки" },
} as const;

function rowState<T>(query: UseQueryResult<T, Error>, enabled = true): "idle" | "loading" | "loaded" | "failed" {
  return !enabled ? "idle" : query.isPending ? "loading" : query.isError ? "failed" : "loaded";
}

/**
 * Agents and their project permissions. Model and provider setup is not part of this pane: it is a
 * service-wide fact and lives in /settings, so no project selector gates a provider, key or model.
 */
export function ConnectionsPanel({ locale, apis, privacy, context, projects, projectQueryKey, projectId, onProject, onNext, onPrevious }: {
  readonly locale: "en" | "ru"; readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly projects: UseQueryResult<ProjectListView, Error>; readonly projectId: string | undefined;
  readonly projectQueryKey: readonly unknown[];
  readonly onProject: (id: string) => void; readonly onNext?: (() => void) | undefined; readonly onPrevious?: (() => void) | undefined;
}) {
  const client = useQueryClient();
  const page = projects.data;
  const options = connectionsQueryOptions(apis, privacy, context, () => client.getQueryData<ProjectListView>(projectQueryKey));
  const key = protectedQueryKey(context, "connections");
  const active = page !== undefined && projectId !== undefined && page.projects.some(project => project.project_id === projectId);
  const health = useQuery(options.health()), session = useQuery(options.session()), diagnostic = useQuery(options.diagnostic());
  const mcpInfo = useQuery({
    queryKey: [...key, "mcp-service-info"],
    enabled: privacy.isCurrent(context),
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
      readSignal => apis.session.readMcpServiceInfo(context.deploymentGeneration, readSignal)),
  });
  const grants = useQuery(active ? options.grants(page, projectId) : { queryKey: [...key, "grants-unselected"], queryFn: skipToken });
  const refresh = () => {
    if (privacy.isCurrent(context)) void client.invalidateQueries({ queryKey: key });
  };
  // Only access facts remain. Provider, model and readiness rows move to /settings, so a project
  // selector here addresses agent permissions on private sources and nothing else.
  const facts = { health, session, diagnostic, grant: grants };
  const retry = () => {
    if (!privacy.isCurrent(context)) return;
    for (const query of new Set(Object.values(facts))) if (query.isError && !query.isFetching) void query.refetch();
  };
  const text = copy[locale];
  const projectSelectId = useId();
  const observed = [...new Set(Object.values(facts))];
  const announcement = usePaneAnnouncement(observed.some(query => query.isFetching) ? text.reading
    : observed.some(query => query.isError) ? text.failed : health.data ? text.loaded : '');
  return <>
    <OperationAnnouncement>{announcement}</OperationAnnouncement>
    {/* How an agent joins comes first; the address arrives once the server publishes its MCP endpoint. */}
    <AgentConnectGuide locale={locale} mcpUrl={mcpInfo.data?.mcp_url ?? undefined} />
    <ComputerAgentConnectionsPanel locale={locale} apis={apis} privacy={privacy} context={context} />
    <div className="er-field"><label className="er-field__label" htmlFor={projectSelectId}>{text.project}</label>
      <select id={projectSelectId} className="er-field__control" value={projectId ?? ""} onChange={event => {
        if (page?.projects.some(project => project.project_id === event.target.value)) onProject(event.target.value);
      }}>
        <option value="">{text.choose}</option>
        {page?.projects.map(project => <option key={project.project_id} value={project.project_id}>{project.title}</option>)}
      </select>
    </div>
    <div className="er-live-pagination">
      {onPrevious && <Button variant="text" onClick={onPrevious}>{text.previous}</Button>}
      {onNext && <Button variant="tonal" onClick={onNext}>{text.next}</Button>}
    </div>
    <p>{text.modelSettings}</p>
    <WorkspaceLink className="er-shell-link" to="/settings">{text.openSettings}</WorkspaceLink>
    <ConnectionsFeature locale={locale} visibleRows={["health", "session", "grant", "googleTransport", "diagnostic"]}
      queries={{ health: rowState(health), session: rowState(session), diagnostic: rowState(diagnostic),
      grant: rowState(grants, active), providerConfig: "idle", projectModel: "idle", researchReadiness: "idle",
      googleTransport: rowState(health), providerModelUse: "idle" }}
      health={health.data} session={session.data} grants={grants.data?.grants}
      diagnostic={diagnostic.data ?? undefined}
      pendingActions={{ refresh: observed.some(query => query.isFetching),
        retry: observed.some(query => query.isError && query.isFetching),
        diagnostics: diagnostic.isFetching }}
      onRefresh={refresh} {...(observed.some(query => query.isError) ? { onRetry: retry } : {})} onRetryRow={row => {
        if (row === "providerModelUse") return;
        const query = row === "googleTransport" ? health : facts[row as keyof typeof facts];
        if (privacy.isCurrent(context) && query.isError && !query.isFetching) void query.refetch();
      }} onOpenDiagnostics={() => { if (privacy.isCurrent(context)) void diagnostic.refetch(); }} />
  </>;
}
