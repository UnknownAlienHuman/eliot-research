import { useId, useState } from "react";
import { skipToken, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Button, ConnectionsFeature, Field } from "@eliotr/ui";
import type { ProjectListView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { connectionsQueryOptions } from "../query/connections";
import { protectedQueryKey } from "../query/client";

const copy = {
  en: { choose: "Choose a project", project: "Project", next: "Next project page", previous: "Previous project page", operation: "Read a saved model operation", key: "Provider key operation", use: "Model operation", read: "Read saved status", hint: "Use the two references from your saved request. Reading status does not start another operation." },
  ru: { choose: "Выберите проект", project: "Проект", next: "Следующая страница проектов", previous: "Предыдущая страница проектов", operation: "Прочитать сохранённую операцию модели", key: "Операция ключа провайдера", use: "Операция модели", read: "Прочитать сохранённый статус", hint: "Введите две ссылки из сохранённого запроса. Чтение статуса не запускает новую операцию." },
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
  const [keyInput, setKeyInput] = useState(""), [operationInput, setOperationInput] = useState("");
  const [saved, setSaved] = useState<{ readonly projectId: string; readonly key: string; readonly operation: string }>();
  const operationActive = active && saved?.projectId === projectId;
  const operation = useQuery(operationActive ? options.modelUse(page, projectId, saved.key, saved.operation)
    : { queryKey: [...key, "operation-unselected"], queryFn: skipToken });
  const refresh = () => {
    if (privacy.isCurrent(context)) void client.invalidateQueries({ queryKey: key });
  };
  const facts = { health, session, diagnostic, googleTransport: health, grant: grants, providerConfig: providers,
    projectModel: models, researchReadiness: readiness, providerModelUse: operation };
  const retry = () => {
    if (!privacy.isCurrent(context)) return;
    for (const query of new Set(Object.values(facts))) if (query.isError && !query.isFetching) void query.refetch();
  };
  const text = copy[locale];
  const projectSelectId = useId();
  return <>
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
      projectModel: rowState(models, active), researchReadiness: rowState(readiness, active), providerModelUse: rowState(operation, operationActive) }}
      health={health.data} session={session.data} grants={grants.data?.grants} providerConfigurations={providers.data?.configurations}
      projectModel={models.data} readiness={readiness.data} diagnostic={diagnostic.data ?? undefined} providerModelUse={operation.data}
      pendingActions={{ refresh: [...new Set(Object.values(facts))].some(query => query.isFetching),
        retry: [...new Set(Object.values(facts))].some(query => query.isError && query.isFetching),
        diagnostics: diagnostic.isFetching }}
      onRefresh={refresh} {...(Object.values(facts).some(query => query.isError) ? { onRetry: retry } : {})} onRetryRow={row => {
        const query = facts[row];
        if (privacy.isCurrent(context) && query.isError && !query.isFetching) void query.refetch();
      }} onOpenDiagnostics={() => { if (privacy.isCurrent(context)) void diagnostic.refetch(); }} />
    {active && <details className="er-live-connection-operation"><summary>{text.operation}</summary>
      <p>{text.hint}</p>
      <form onSubmit={event => {
        event.preventDefault();
        if (privacy.isCurrent(context) && keyInput.trim() && operationInput.trim()) setSaved({ projectId, key: keyInput.trim(), operation: operationInput.trim() });
      }}>
        <Field label={text.key} value={keyInput} maxLength={36} required onChange={event => setKeyInput(event.target.value)} />
        <Field label={text.use} value={operationInput} maxLength={36} required onChange={event => setOperationInput(event.target.value)} />
        <Button variant="tonal" type="submit">{text.read}</Button>
      </form>
    </details>}
  </>;
}
