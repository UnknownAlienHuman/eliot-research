import type { QueryFunction } from "@tanstack/react-query";
import type { ProjectListView } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

interface ReadQuery<T> { readonly queryKey: (string | number)[]; readonly queryFn: QueryFunction<T, (string | number)[]> }
export interface ConnectionsQueryOptions {
  health(): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["health"]["getSystemHealth"]>>>;
  session(): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["session"]["readOwnerSession"]>>>;
  diagnostic(): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["connections"]["diagnostic"]["getLatestMcpClientDiagnostic"]>>>;
  grants(page: ProjectListView, projectId: string): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["connections"]["grants"]["readClientGrants"]>>>;
  providers(page: ProjectListView, projectId: string): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["connections"]["providers"]["readResearchProviderKeyConfigurations"]>>>;
  models(page: ProjectListView, projectId: string): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["connections"]["models"]["readResearchProjectModelConfiguration"]>>>;
  modelUse(page: ProjectListView, projectId: string, keyOperationId: string, operationId: string): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["connections"]["modelUse"]["readResearchProviderKeyModelUse"]>>>;
  readiness(page: ProjectListView, projectId: string): ReadQuery<Awaited<ReturnType<BoundWorkspaceApis["connections"]["configuration"]["readResearchConfiguration"]>>>;
}

/** Each fact has its own request and Query state. A successful health read proves only health. */
export function connectionsQueryOptions(
  apis: BoundWorkspaceApis, privacy: PrivacyController, context: SessionContext,
  currentProjects: () => ProjectListView | undefined,
): ConnectionsQueryOptions {
  const key = protectedQueryKey(context, "connections");
  const assertProject = (page: ProjectListView, projectId: string) => {
    if (currentProjects() !== page || page.deployment_generation !== context.deploymentGeneration ||
        !page.projects.some(project => project.project_id === projectId)) {
      throw new Error("Connections project is no longer in the current project page");
    }
  };
  const projectRead = <T>(name: string, page: ProjectListView, projectId: string, read: (signal: AbortSignal) => Promise<T>): ReadQuery<T> => ({
    queryKey: [...key, name, projectId],
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
      assertProject(page, projectId);
      const result = await read(readSignal);
      assertProject(page, projectId);
      return result;
    }),
  });
  return {
    health: () => ({ queryKey: [...key, "health"], queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
      const health = await apis.health.getSystemHealth(readSignal);
      if (health.deployment_generation !== context.deploymentGeneration) throw new Error("Application changed; verify access again");
      return health;
    }) }),
    session: () => ({ queryKey: [...key, "session"], queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
      const session = await apis.session.readOwnerSession(context.deploymentGeneration, readSignal);
      if (session.client_class !== "owner_pwa" || session.principal_ref !== context.principal ||
          session.credential_generation !== context.credentialGeneration || session.expires_at !== context.expiresAt ||
          !apis.session.isOwnerSessionUnexpired(session)) throw new Error("Owner access changed; verify access again");
      return session;
    }) }),
    diagnostic: () => ({ queryKey: [...key, "diagnostic"], queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
      readSignal => apis.connections.diagnostic.getLatestMcpClientDiagnostic(context.deploymentGeneration, readSignal)) }),
    grants: (page: ProjectListView, projectId: string) => projectRead("grants", page, projectId,
      signal => apis.connections.grants.readClientGrants(projectId, context.deploymentGeneration, undefined, signal)),
    providers: (page: ProjectListView, projectId: string) => projectRead("providers", page, projectId,
      signal => apis.connections.providers.readResearchProviderKeyConfigurations(projectId, context.deploymentGeneration, signal)),
    models: (page: ProjectListView, projectId: string) => projectRead("models", page, projectId,
      signal => apis.connections.models.readResearchProjectModelConfiguration(projectId, context.deploymentGeneration, {}, signal)),
    modelUse: (page: ProjectListView, projectId: string, keyOperationId: string, operationId: string) => {
      const query = projectRead("model-use", page, projectId,
        signal => apis.connections.modelUse.readResearchProviderKeyModelUse(projectId, context.deploymentGeneration, keyOperationId, operationId, signal));
      return { ...query, queryKey: [...query.queryKey, keyOperationId, operationId] };
    },
    readiness: (page: ProjectListView, projectId: string) => projectRead("readiness", page, projectId,
      signal => apis.connections.configuration.readResearchConfiguration(context.deploymentGeneration, { projectId, signal })),
  };
}
