import type { ProjectListView } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { ProtectedReadClosedError, protectedQueryKey, runProtectedRead } from "./client";

type ModelApi = BoundWorkspaceApis["connections"]["models"];

function assertCurrentProject(
  currentProjects: () => ProjectListView | undefined,
  page: ProjectListView,
  projectId: string,
  generation: string,
): void {
  if (currentProjects() !== page || page.deployment_generation !== generation ||
      !page.projects.some(project => project.project_id === projectId)) {
    throw new ProtectedReadClosedError();
  }
}

/** A catalog read is protected by both the owner epoch and the exact selected project page. */
export function modelCatalogQueryOptions(
  models: ModelApi,
  privacy: PrivacyController,
  context: SessionContext,
  currentProjects: () => ProjectListView | undefined,
  page: ProjectListView,
  projectId: string,
  providerId: string,
  catalogPage: number,
) {
  const queryKey = [...protectedQueryKey(context, "connections"), "model-catalog", projectId, providerId, catalogPage] as const;
  return {
    queryKey,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal, async readSignal => {
      assertCurrentProject(currentProjects, page, projectId, context.deploymentGeneration);
      const result = await models.readResearchModelCatalog(projectId, context.deploymentGeneration,
        { providerId, page: catalogPage, perPage: 50 }, readSignal);
      assertCurrentProject(currentProjects, page, projectId, context.deploymentGeneration);
      return result;
    }),
  };
}

