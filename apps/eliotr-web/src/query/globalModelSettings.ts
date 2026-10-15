import type { ServiceModelSettings, ServiceModelProviderCreateRequest, ServiceModelProviderConnection,
  createServiceModelSettingsApi } from "@eliotr/owner-api-client";
import type { UseQueryOptions } from "@tanstack/react-query";
import { isWorkspaceRequestError } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

type ServiceModelSettingsApi = ReturnType<typeof createServiceModelSettingsApi>;

export class GlobalModelSettingsClosedError extends Error {}
export class GlobalModelProviderRefusedError extends Error {
  constructor(public readonly reason: "unavailable" | "invalid") { super("Provider connection was refused before dispatch"); }
}

const assertCurrent = (signal: AbortSignal, isCurrent: () => boolean) => {
  if (signal.aborted || !isCurrent()) throw new GlobalModelSettingsClosedError();
};

/** One status read for the held operation. It never submits a key or creates a replacement operation. */
export async function readGlobalModelProviderOperation(input: { readonly api: ServiceModelSettingsApi;
  readonly operationId: string; readonly generation: string; readonly signal: AbortSignal;
  readonly isCurrent: () => boolean }): Promise<ServiceModelProviderConnection | undefined> {
  assertCurrent(input.signal, input.isCurrent);
  try {
    const result = await input.api.readServiceModelProviderOperation(input.operationId, input.generation, input.signal);
    assertCurrent(input.signal, input.isCurrent);
    return result.connection ?? undefined;
  } catch {
    assertCurrent(input.signal, input.isCurrent);
    return undefined;
  }
}

/** Keys stay out of Query and operation state; only the opaque operation identity survives a lost ACK. */
export async function configureGlobalModelProviderOnce(input: { readonly api: ServiceModelSettingsApi;
  readonly request: ServiceModelProviderCreateRequest; readonly generation: string; readonly signal: AbortSignal;
  readonly isCurrent: () => boolean }): Promise<ServiceModelProviderConnection | undefined> {
  assertCurrent(input.signal, input.isCurrent);
  try { await input.api.createServiceModelProvider(input.request, input.generation, input.signal); }
  catch (error) {
    assertCurrent(input.signal, input.isCurrent);
    if (isWorkspaceRequestError(error)) {
      if (error.status === 503 && error.code === "SERVICE_MODEL_PROVIDER_MANAGEMENT_UNAVAILABLE") {
        throw new GlobalModelProviderRefusedError("unavailable");
      }
      if (error.status === 400 && ["SERVICE_MODEL_INPUT_INVALID", "SERVICE_MODEL_PROVIDER_INPUT_INVALID"].includes(error.code)) {
        throw new GlobalModelProviderRefusedError("invalid");
      }
    }
  }
  const connection = await readGlobalModelProviderOperation({ api: input.api, operationId: input.request.operation_id,
    generation: input.generation, signal: input.signal, isCurrent: input.isCurrent });
  if (connection !== undefined && (connection.provider_id !== input.request.provider_id ||
    connection.display_name !== input.request.display_name || connection.base_url !== (input.request.base_url || null) ||
    connection.model_ids.length !== input.request.model_ids.length ||
    connection.model_ids.some(model => !input.request.model_ids.includes(model)))) return undefined;
  return connection;
}

export type ServiceModelCatalogQueryRequest = Readonly<{
  readonly search?: string;
  readonly page?: number;
  readonly providerId?: string;
}>;

/**
 * Global service model settings. Provider registration and the catalog are service-wide facts: no
 * project identity, selected project page or project grant participates, and none is invented here.
 * The owner epoch is the only authority this read observes.
 */
export function serviceModelSettingsQueryOptions(
  models: ServiceModelSettingsApi,
  privacy: PrivacyController,
  context: SessionContext,
): UseQueryOptions<ServiceModelSettings> {
  return {
    queryKey: [...protectedQueryKey(context, "service-model-settings"), "settings"] as const,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal, async readSignal =>
      models.readServiceModelSettings(context.deploymentGeneration, readSignal)),
  };
}
