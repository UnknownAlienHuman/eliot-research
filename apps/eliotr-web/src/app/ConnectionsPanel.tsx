import { useId } from "react";
import { skipToken, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Button, ConnectionsFeature, OperationAnnouncement } from "@eliotr/ui";
import type { ProjectListView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { connectionsQueryOptions } from "../query/connections";
import { protectedQueryKey } from "../query/client";
import { ComputerAgentConnectionsPanel } from "./ComputerAgentConnectionsPanel";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { usePaneAnnouncement } from "./usePaneAnnouncement";

const copy = {
  en: { reading: 'Reading connection status.', failed: 'Some status checks failed. Review the affected rows.', loaded: 'Connection status checks updated.', choose: "Choose a project", project: "Project", next: "Next project page", previous: "Previous project page" },
  ru: { reading: 'Читается статус подключений.', failed: 'Некоторые проверки статуса завершились ошибкой. Проверьте соответствующие строки.', loaded: 'Проверки статуса подключений обновлены.', choose: "Выберите проект", project: "Проект", next: "Следующая страница проектов", previous: "Предыдущая страница проектов" },
} as const;

function rowState<T>(query: UseQueryResult<T, Error>, enabled = true): "idle" | "loading" | "loaded" | "failed" {
  return !enabled ? "idle" : query.isPending ? "loading" : query.isError ? "failed" : "loaded";
}

/** Each row observes its own protected read; model selection never substitutes for operation status. */
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
  const grants = useQuery(active ? options.grants(page, projectId) : { queryKey: [...key, "grants-unselected"], queryFn: skipToken });
  const providers = useQuery(active ? options.providers(page, projectId) : { queryKey: [...key, "providers-unselected"], queryFn: skipToken });
  const models = useQuery(active ? options.models(page, projectId) : { queryKey: [...key, "models-unselected"], queryFn: skipToken });
  const readiness = useQuery(active ? options.readiness(page, projectId) : { queryKey: [...key, "readiness-unselected"], queryFn: skipToken });
  const refresh = () => {
    if (privacy.isCurrent(context)) void client.invalidateQueries({ queryKey: key });
  };
  const facts = { health, session, diagnostic, googleTransport: health, grant: grants, providerConfig: providers,
    projectModel: models, researchReadiness: readiness };
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
    <ConnectionsFeature locale={locale} queries={{ health: rowState(health), session: rowState(session), diagnostic: rowState(diagnostic),
      googleTransport: rowState(health), grant: rowState(grants, active), providerConfig: rowState(providers, active),
      projectModel: rowState(models, active), researchReadiness: rowState(readiness, active), providerModelUse: "idle" }}
      health={health.data} session={session.data} grants={grants.data?.grants} providerConfigurations={providers.data?.configurations}
      projectModel={models.data} readiness={readiness.data} diagnostic={diagnostic.data ?? undefined}
      pendingActions={{ refresh: [...new Set(Object.values(facts))].some(query => query.isFetching),
        retry: [...new Set(Object.values(facts))].some(query => query.isError && query.isFetching),
        diagnostics: diagnostic.isFetching }}
      onRefresh={refresh} {...(Object.values(facts).some(query => query.isError) ? { onRetry: retry } : {})} onRetryRow={row => {
        if (row === "providerModelUse") return;
        const query = facts[row];
        if (privacy.isCurrent(context) && query.isError && !query.isFetching) void query.refetch();
      }} onOpenDiagnostics={() => { if (privacy.isCurrent(context)) void diagnostic.refetch(); }} />
    {active && page !== undefined && projectId !== undefined && <ModelSettingsPanel
      key={`${context.cacheEpoch}:${context.principal}:${context.credentialGeneration}:${context.deploymentGeneration}:${projectId}`}
      locale={locale} apis={apis} privacy={privacy} context={context} projectPage={page} projectId={projectId}
      projectQueryKey={projectQueryKey} providers={providers} models={models} />}
    <ComputerAgentConnectionsPanel locale={locale} apis={apis} privacy={privacy} context={context} />
  </>;
}
