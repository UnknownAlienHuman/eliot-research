import { queryOptions } from "@tanstack/react-query";
import type { createProjectsApi, createLibraryApi, createReadinessApi, createRevisionApi, LibraryPage, ProjectListView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

export interface SourcesQueryApis {
  readonly projects: ReturnType<typeof createProjectsApi>;
  readonly library: ReturnType<typeof createLibraryApi>;
  readonly readiness: ReturnType<typeof createReadinessApi>;
  readonly revisions: ReturnType<typeof createRevisionApi>;
}
export interface SourcesQueryCurrentPages {
  readonly projects: () => ProjectListView | undefined;
  readonly library: () => LibraryPage | undefined;
}

/** Query owns remote state. UI controllers receive its results and keep only local selection. */
export function sourcesQueryOptions(apis: SourcesQueryApis, privacy: PrivacyController, context: SessionContext, current: SourcesQueryCurrentPages) {
  const generation = context.deploymentGeneration;
  const key = protectedQueryKey(context, "sources");
  const currentProject = (projects: ProjectListView, projectId: string) => {
    if (current.projects() !== projects || projects.deployment_generation !== generation || !projects.projects.some(project => project.project_id === projectId)) {
      throw new Error("Selected project is no longer in the current project page");
    }
  };
  const currentSource = (page: LibraryPage, sourceId: string) => {
    if (current.library() !== page || page.generation !== generation || !page.sources.some(source => source.id === sourceId)) {
      throw new Error("Selected source is no longer in the current library page");
    }
  };
  return {
    projects(afterProjectId?: string) {
      return queryOptions({
        queryKey: [...key, "projects", afterProjectId ?? null],
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
          readSignal => apis.projects.readProjects(generation, afterProjectId, readSignal)),
      });
    },
    library(projects: ProjectListView, projectId: string, cursor?: string) {
      return queryOptions({
        queryKey: [...key, "library", projectId, cursor ?? null],
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          currentProject(projects, projectId);
          const result = await apis.library.readLibraryPage({ project: projectId, generation, ...(cursor === undefined ? {} : { cursor }) }, readSignal);
          currentProject(projects, projectId);
          return result;
        }),
      });
    },
    readiness(page: LibraryPage, sourceId: string, sourceRevisionRef?: string) {
      return queryOptions({
        queryKey: [...key, "readiness", sourceId, sourceRevisionRef ?? null],
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          currentSource(page, sourceId);
          const result = await apis.readiness.readLibraryReadiness(sourceId, generation, readSignal, sourceRevisionRef);
          currentSource(page, sourceId);
          return result;
        }),
      });
    },
    revisions(page: LibraryPage, sourceId: string, cursor?: string) {
      return queryOptions({
        queryKey: [...key, "revisions", sourceId, cursor ?? null],
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          currentSource(page, sourceId);
          const result = await apis.revisions.readSourceRevisionsPage(sourceId, generation, cursor, readSignal);
          currentSource(page, sourceId);
          return result;
        }),
      });
    },
  };
}
