import type { UseQueryOptions } from "@tanstack/react-query";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { ProtectedReadClosedError, protectedQueryKey, runProtectedRead } from "./client";
import { readDiscoveredCatalogModelOperation, type ChatCatalogModelOperationReadback } from './chatCatalogModelUse';

type ModelApi = BoundWorkspaceApis["connections"]["models"];
type ProviderApi = BoundWorkspaceApis["connections"]["providers"];

/** Fresh read-only discovery on every pane mount; stale/null cache never authorizes a new choice. */
export function chatCurrentCatalogModelOperationQueryOptions(
  api: Pick<BoundWorkspaceApis['connections']['catalogModelUse'], 'readCurrentResearchCatalogModelUse'>,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string | undefined,
  isProjectCurrent: () => boolean,
): UseQueryOptions<Awaited<ReturnType<typeof api.readCurrentResearchCatalogModelUse>>> {
  return {
    queryKey: [...protectedQueryKey(context, 'connections'), 'chat-current-catalog-operation', projectId ?? null],
    enabled: projectId !== undefined && privacy.isCurrent(context) && isProjectCurrent(),
    retry: false, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: ({ signal }) => {
      if (projectId === undefined) throw new ProtectedReadClosedError();
      return runProtectedRead(privacy, context, signal, async readSignal => {
        if (!isProjectCurrent()) throw new ProtectedReadClosedError();
        const receipt = await api.readCurrentResearchCatalogModelUse(projectId, context.deploymentGeneration, readSignal);
        if (!isProjectCurrent()) throw new ProtectedReadClosedError();
        return receipt;
      });
    },
  };
}

/** The operation ID comes from an authoritative server discovery, never private storage or an
 * owner-entered technical field. A missing ID disables this read; it never falls through to POST.
 */
export function chatCatalogModelOperationQueryOptions(
  api: Pick<BoundWorkspaceApis['connections']['catalogModelUse'], 'readResearchCatalogModelUse'>,
  models: Pick<ModelApi, 'readResearchProjectModelConfiguration'>,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string | undefined,
  isProjectCurrent: () => boolean,
  serverOperationId: string | undefined,
): UseQueryOptions<ChatCatalogModelOperationReadback> {
  return {
    queryKey: [...protectedQueryKey(context, 'connections'), 'chat-catalog-operation', projectId ?? null, serverOperationId ?? null],
    enabled: projectId !== undefined && serverOperationId !== undefined && isProjectCurrent() && privacy.isCurrent(context),
    retry: false, refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: ({ signal }) => {
      if (projectId === undefined || serverOperationId === undefined) throw new ProtectedReadClosedError();
      return runProtectedRead(privacy, context, signal, readSignal => readDiscoveredCatalogModelOperation({
        api, models, projectId, generation: context.deploymentGeneration, operationId: serverOperationId,
        signal: readSignal, isCurrent: () => privacy.isCurrent(context) && isProjectCurrent(),
      }));
    },
  };
}

/** Read the saved candidates only while the same selected project remains current. */
export function chatProjectModelConfigurationQueryOptions(
  models: ModelApi,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string | undefined,
  isProjectCurrent: () => boolean,
): UseQueryOptions<Awaited<ReturnType<ModelApi["readResearchProjectModelConfiguration"]>>> {
  const enabled = projectId !== undefined && isProjectCurrent() && privacy.isCurrent(context);
  return {
    queryKey: [...protectedQueryKey(context, "connections"), "chat-model-configuration", projectId ?? null] as const,
    enabled,
    queryFn: ({ signal }) => {
      if (projectId === undefined) throw new ProtectedReadClosedError();
      return runProtectedRead(privacy, context, signal, async readSignal => {
        if (!isProjectCurrent()) throw new ProtectedReadClosedError();
        const result = await models.readResearchProjectModelConfiguration(projectId, context.deploymentGeneration,
          { limit: 50 }, readSignal);
        if (!isProjectCurrent()) throw new ProtectedReadClosedError();
        return result;
      });
    },
  };
}

/** Read the existing project OpenRouter key operation only when qualification needs it. */
export function chatProviderKeyConfigurationQueryOptions(
  providers: ProviderApi,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string | undefined,
  isProjectCurrent: () => boolean,
  needed: boolean,
): UseQueryOptions<Awaited<ReturnType<ProviderApi["readResearchProviderKeyConfigurations"]>>> {
  const enabled = needed && projectId !== undefined && isProjectCurrent() && privacy.isCurrent(context);
  return {
    queryKey: [...protectedQueryKey(context, "connections"), "chat-provider-key", projectId ?? null, "openrouter"] as const,
    enabled,
    queryFn: ({ signal }) => {
      if (projectId === undefined) throw new ProtectedReadClosedError();
      return runProtectedRead(privacy, context, signal, async readSignal => {
        if (!isProjectCurrent()) throw new ProtectedReadClosedError();
        const result = await providers.readResearchProviderKeyConfigurations(projectId,
          context.deploymentGeneration, readSignal);
        if (!isProjectCurrent()) throw new ProtectedReadClosedError();
        return result;
      });
    },
  };
}
