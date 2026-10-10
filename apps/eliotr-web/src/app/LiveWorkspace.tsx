import { useCallback, useLayoutEffect, useRef, useState, type Ref, type RefObject } from "react";
import { skipToken, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { WorkspaceLink } from "../routes/WorkspaceLink";
import { Button, Dialog, DocumentReader, ProjectsLibraryFeature } from "@eliotr/ui";
import type { LibraryPage, ProjectListView, SourceRevisionPage } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "./privacy";
import type { BoundWorkspaceApis } from "./runtime";
import { sourcesQueryOptions } from "../query/sources";
import { documentQueryOptions } from "../query/documents";
import { protectedQueryKey } from "../query/client";
import type { destinations } from "../routes/location";
import "./live-workspace.css";
import { ErasurePanel } from "./ErasurePanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { ImportPanel } from "./ImportPanel";
import { NextQuestionScope, type NextQuestionSource } from "./NextQuestionScope";
import { OWNER_RESEARCH_MAX_SELECTED_SOURCES as selectedSourceLimit } from '@eliotr/owner-api-client';
import { ResearchPanel } from "./ResearchPanel";
import { StudioPanel } from "./StudioPanel";

const copy = {
  en: { sources: "Sources", research: "Research", studio: "Studio", connections: "Connections", choose: "Choose a project to get started", detail: "Keep sources, questions and their evidence together.", next: "Next page", previous: "Previous page", versions: "Choose a version to read", document: "Source document", close: "Back to sources", untitled: "No project selected", researchPrompt: "Choose the sources for your next question", researchDetail: "The question will keep the exact source scope you choose.", studioEmpty: "Your saved work belongs here", studioDetail: "Reports and artifacts will keep the sources they were created from.", connectionsDetail: "Review owner access and research configuration.", review: "Review connections", selected: (count: number) => `${count} sources selected`, sourceScope: "For your next question", openSources: "Choose sources", version: (index: number) => `Version ${index + 1}`, scopeNote: "Readiness and recorded versions are separate observations." },
  ru: { sources: "Источники", research: "Исследование", studio: "Студия", connections: "Подключения", choose: "Выберите проект, чтобы начать", detail: "Источники, вопросы и доказательства остаются вместе.", next: "Следующая страница", previous: "Предыдущая страница", versions: "Выберите версию для чтения", document: "Документ источника", close: "Вернуться к источникам", untitled: "Проект не выбран", researchPrompt: "Выберите источники для следующего вопроса", researchDetail: "Вопрос сохранит точный набор выбранных источников.", studioEmpty: "Здесь будут сохранённые материалы", studioDetail: "Отчёты и материалы сохраняют связь с исходными источниками.", connectionsDetail: "Проверьте доступ владельца и настройки исследования.", review: "Проверить подключения", selected: (count: number) => `Выбрано источников: ${count}`, sourceScope: "Для следующего вопроса", openSources: "Выбрать источники", version: (index: number) => `Версия ${index + 1}`, scopeNote: "Готовность и записанные версии — отдельные наблюдения." },
} as const;

export function LiveWorkspace({ destination, locale, headingRef, apis, privacy, context }: {
  readonly destination: typeof destinations[number]; readonly locale: "en" | "ru";
  readonly headingRef: RefObject<HTMLHeadingElement | null>; readonly apis: BoundWorkspaceApis;
  readonly privacy: PrivacyController; readonly context: SessionContext;
}) {
  const client = useQueryClient();
  const [projectPages, setProjectPages] = useState<readonly (string | undefined)[]>([undefined]);
  const [projectId, setProjectId] = useState<string>();
  const projectSelectFocus = useRef<{
    readonly projectId: string; readonly context: SessionContext;
    readonly projectPage: ProjectListView; readonly after: string | undefined;
  } | undefined>(undefined);
  useLayoutEffect(() => {
    if (destination !== "sources") projectSelectFocus.current = undefined;
  }, [destination]);
  const [sourceId, setSourceId] = useState<string>();
  const [libraryPages, setLibraryPages] = useState<readonly (string | undefined)[]>([undefined]);
  const [scope, setScope] = useState<readonly NextQuestionSource[]>([]);
  const after = projectPages[projectPages.length - 1];
  const cursor = libraryPages[libraryPages.length - 1];
  const key = protectedQueryKey(context, "sources");
  const options = sourcesQueryOptions(apis.sources, privacy, context, {
    projects: () => client.getQueryData([...protectedQueryKey(context, "sources"), "projects", after ?? null]),
    library: () => client.getQueryData<LibraryPage>([...key, "library", projectId, cursor ?? null]),
  });
  const projects = useQuery(options.projects(after));
  const selected = projects.data?.projects.find(project => project.project_id === projectId);
  const library = useQuery(selected && projects.data ? options.library(projects.data, selected.project_id, cursor)
    : { queryKey: [...key, "library-unselected"], queryFn: skipToken });
  // Keep selected pages observed in protected memory across pagination.
  const projectPage = projects.data;
  useQueries({ queries: selected && projectPage
    ? [...new Map(scope.map(item => [item.cursor ?? null, item])).values()].map(item => ({
      ...options.library(projectPage, selected.project_id, item.cursor), refetchOnMount: false,
    })) : [] });
  const isScopeCurrent = () => scope.length > 0 && selected !== undefined && privacy.isCurrent(context) &&
    client.getQueryData([...key, "projects", after ?? null]) === projects.data && scope.every(item => {
      const observed = client.getQueryState<LibraryPage>([...key, "library", selected.project_id, item.cursor ?? null]);
      return observed?.status === "success" && observed.fetchStatus === "idle" && !observed.isInvalidated &&
        observed.data === item.page && item.page.generation === context.deploymentGeneration &&
        item.page.sources.some(source => source.id === item.id);
    });
  const scopeCurrent = isScopeCurrent();
  const restoreProjectSelectFocus = useCallback((node: HTMLSelectElement | null) => {
    if (node === null) return;
    const target = projectSelectFocus.current;
    if (target === undefined) return;
    try {
      const currentCachedProjectPage = client.getQueryData<ProjectListView>(
        [...protectedQueryKey(context, "sources"), "projects", after ?? null],
      );
      if (destination === "sources" && target.projectId === selected?.project_id && target.after === after &&
        target.projectPage === projects.data && target.projectPage === currentCachedProjectPage &&
        privacy.isCurrent(target.context) && privacy.isCurrent(context)) {
        node.focus({ preventScroll: true });
      }
    } finally {
      projectSelectFocus.current = undefined;
    }
  }, [after, client, context, destination, privacy, projects.data, selected?.project_id]);
  const chooseProject = (id: string) => {
    const projectPage = projects.data;
    if (projectPage?.projects.some(project => project.project_id === id) && privacy.isCurrent(context)) {
      if (destination === "sources" && id !== projectId &&
        client.getQueryData<ProjectListView>([...key, "projects", after ?? null]) === projectPage) {
        projectSelectFocus.current = { projectId: id, context, projectPage, after };
      }
      setProjectId(id); setSourceId(undefined); setLibraryPages([undefined]); setScope([]);
    }
  };
  const toggleScope = (page: LibraryPage, id: string, checked: boolean) => {
    const source = page.sources.find(row => row.id === id);
    if (!source || page !== library.data || page.generation !== context.deploymentGeneration ||
      client.getQueryData([...key, "library", projectId, cursor ?? null]) !== page || !privacy.isCurrent(context)) return;
    setScope(old => checked ? old.some(item => item.id === id) || old.length >= selectedSourceLimit ? old : [...old, { id, label: source.title, page, ...(cursor === undefined ? {} : { cursor }) }]
      : old.filter(item => item.id !== id));
  };
  const text = copy[locale];
  return <div className="er-live-workspace">
    <aside className="er-shell-sources" hidden={destination !== "research"} aria-label={text.sources}>
      <h2>{text.sources}</h2><p>{selected?.title ?? text.untitled}</p><p>{text.sourceScope}</p>
      <p>{text.selected(scope.length)}</p>
      <WorkspaceLink className="er-shell-link" to="/sources">{text.openSources}</WorkspaceLink>
    </aside>
    <main className="er-shell-reading" id="workspace-main">
      {destination !== "sources" && <p className="er-shell-eyebrow">{selected?.title ?? (destination === "studio" ? text.studioEmpty : destination === "connections" ? text.connectionsDetail : text.choose)}</p>}
      <h1 id="workspace-heading" ref={headingRef} tabIndex={-1}>{text[destination]}</h1>
      {destination === "sources" ? <>
        <ActiveSources key={selected?.project_id ?? "no-project"} locale={locale} apis={apis} privacy={privacy} context={context}
          projectId={selected?.project_id} projects={projects} after={after} onProject={chooseProject} projectSelectRef={restoreProjectSelectFocus}
          sourceId={sourceId} onSource={setSourceId}
          libraryPages={libraryPages} onLibraryPages={setLibraryPages} scope={scope} onScope={toggleScope} onClearScope={() => setScope([])} />
        <div className="er-live-pagination">
          {projectPages.length > 1 && <Button variant="text" onClick={() => { setProjectId(undefined); setProjectPages(pages => pages.slice(0, -1)); }}>{text.previous}</Button>}
          {projects.data?.next_project_id && <Button variant="tonal" onClick={() => { const next = projects.data?.next_project_id; if (next) { setProjectId(undefined); setProjectPages(pages => [...pages, next]); } }}>{text.next}</Button>}
        </div>
      </> : destination === "connections" ? <ConnectionsPanel locale={locale} apis={apis} privacy={privacy} context={context}
        projects={projects} projectQueryKey={[...protectedQueryKey(context, "sources"), "projects", after ?? null]} projectId={selected?.project_id}
        onProject={chooseProject}
        onPrevious={projectPages.length > 1 ? () => { setProjectId(undefined); setProjectPages(pages => pages.slice(0, -1)); } : undefined}
        onNext={projects.data?.next_project_id ? () => { const next = projects.data?.next_project_id; if (next) { setProjectId(undefined); setProjectPages(pages => [...pages, next]); } } : undefined} />
        : destination === "research" ? <ResearchPanel locale={locale} apis={apis} privacy={privacy} context={context} scope={scope} scopeCurrent={scopeCurrent}
          isScopeCurrent={isScopeCurrent} />
        : <StudioPanel locale={locale} apis={apis} privacy={privacy} context={context} />}
    </main>
  </div>;
}

function ActiveSources({ locale, apis, privacy, context, projectId, projects, after, onProject, projectSelectRef, sourceId, onSource, libraryPages, onLibraryPages, scope, onScope, onClearScope }: {
  readonly locale: "en" | "ru"; readonly apis: BoundWorkspaceApis; readonly privacy: PrivacyController;
  readonly context: SessionContext; readonly projectId: string | undefined;
  readonly projects: UseQueryResult<ProjectListView, Error>;
  readonly after: string | undefined; readonly onProject: (id: string) => void;
  readonly projectSelectRef: Ref<HTMLSelectElement>;
  readonly sourceId: string | undefined; readonly onSource: (id: string | undefined) => void;
  readonly libraryPages: readonly (string | undefined)[]; readonly onLibraryPages: (pages: readonly (string | undefined)[]) => void;
  readonly scope: readonly NextQuestionSource[]; readonly onScope: (page: LibraryPage, id: string, checked: boolean) => void; readonly onClearScope: () => void;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const cursor = libraryPages[libraryPages.length - 1];
  const key = protectedQueryKey(context, "sources");
  const current = {
    projects: () => client.getQueryData<NonNullable<typeof projects.data>>([...key, "projects", after ?? null]),
    library: () => client.getQueryData<LibraryPage>([...key, "library", projectId, cursor ?? null]),
    revisions: () => client.getQueryData<SourceRevisionPage>([...key, "revisions", sourceId, null]),
  };
  const options = sourcesQueryOptions(apis.sources, privacy, context, current);
  const library = useQuery(projectId && projects.data ? options.library(projects.data, projectId, cursor)
    : { queryKey: [...key, "library-unselected"], queryFn: skipToken });
  const source = library.data?.sources.find(row => row.id === sourceId);
  const readiness = useQuery(source && library.data ? options.readiness(library.data, source.id)
    : { queryKey: [...key, "readiness-unselected"], queryFn: skipToken });
  const revisions = useQuery(source && library.data ? options.revisions(library.data, source.id)
    : { queryKey: [...key, "revisions-unselected"], queryFn: skipToken });
  const text = copy[locale];
  const routeState: unknown = location.state;
  const ref = routeState !== null && typeof routeState === "object" && "sourceDocument" in routeState &&
    typeof routeState.sourceDocument === "string" && "cacheEpoch" in routeState && routeState.cacheEpoch === context.cacheEpoch &&
    "sourceId" in routeState && routeState.sourceId === source?.id && "projectId" in routeState && routeState.projectId === projectId
    ? routeState.sourceDocument : undefined;
  const selectedRevision = revisions.data?.revisions.find(row => row.source_revision_ref === ref);
  const document = useQuery(source && library.data && revisions.data && selectedRevision
    ? documentQueryOptions(apis.sources.reader, privacy, context, current, library.data, revisions.data, source.id, selectedRevision.source_revision_ref)
    : { queryKey: [...key, "document-unselected"], queryFn: skipToken });
  const pending = projects.isPending || (projectId !== undefined && library.isPending);
  const error = projects.isError || (projectId !== undefined && library.isError);
  const selectSource = (id: string) => {
    if (library.data?.sources.some(row => row.id === id) && current.library() === library.data && privacy.isCurrent(context)) onSource(id);
  };
  return <>
    <ProjectsLibraryFeature locale={locale} projectSelectRef={projectSelectRef} state={pending ? "loading" : error ? "error" : "useful"}
      sourceActions={<>
        <ImportPanel locale={locale} apis={apis} privacy={privacy} context={context} />
        <NextQuestionScope locale={locale} page={library.data} projectSelected={projectId !== undefined} isLoading={pending} isError={error}
          selected={scope} selectionLimit={selectedSourceLimit} onToggle={onScope} onClear={onClearScope} />
      </>}
      projects={projects.data?.projects ?? []} selectedProjectId={projectId} onSelectProject={id => { if (projects.data?.projects.some(row => row.project_id === id)) onProject(id); }}
      library={library.data} readiness={readiness.isError ? undefined : readiness.data} readinessState={!source ? "idle" : readiness.isPending ? "loading" : readiness.isError ? "degraded" : "useful"}
      revisions={revisions.isError ? undefined : revisions.data} revisionsState={!source ? "idle" : revisions.isPending ? "loading" : revisions.isError ? "error" : "useful"}
      selectedSourceId={source?.id} onOpenSource={selectSource} onLoadRevisions={selectSource}
      onReadRevision={revisionRef => {
        if (source && revisions.data?.revisions.some(revision => revision.source_revision_ref === revisionRef) &&
          privacy.isCurrent(context) && current.library() === library.data && current.revisions() === revisions.data) {
          void navigate(location.pathname, { state: { sourceDocument: revisionRef, sourceId: source.id, projectId, cacheEpoch: context.cacheEpoch }, preventScrollReset: true });
        }
      }}
      onRetry={() => { if (projects.isError) void projects.refetch(); else if (projectId) void library.refetch(); }}
      onRetryReadiness={() => { if (source && privacy.isCurrent(context) && current.library() === library.data) void readiness.refetch(); }}
      onRetryRevisions={() => { if (source && privacy.isCurrent(context) && current.library() === library.data) void revisions.refetch(); }} />
    <ErasurePanel locale={locale} apis={apis} privacy={privacy} context={context}
      selectedSourceId={source?.id} page={library.data} currentLibrary={current.library} />
    {projectId && <div className="er-live-pagination">
      {libraryPages.length > 1 && <Button variant="text" onClick={() => { onSource(undefined); onLibraryPages(libraryPages.slice(0, -1)); }}>{text.previous}</Button>}
      {library.data?.next_cursor && <Button variant="tonal" onClick={() => { const next = library.data?.next_cursor; if (next) { onSource(undefined); onLibraryPages([...libraryPages, next]); } }}>{text.next}</Button>}
    </div>}
    {ref !== undefined && <Dialog open title={source?.title ?? text.document} onClose={() => { void navigate(-1); }}>
      {selectedRevision && <DocumentReader locale={locale} sourceRevisionRef={selectedRevision.source_revision_ref} expectedDeploymentGeneration={context.deploymentGeneration}
        state={document.isPending ? "loading" : document.isError ? "error" : document.data ? "useful" : "empty"}
        {...(document.data ? { document: document.data } : {})} onRetry={() => { void document.refetch(); }} />}
      <Button variant="text" onClick={() => { void navigate(-1); }}>{text.close}</Button>
    </Dialog>}
  </>;
}
