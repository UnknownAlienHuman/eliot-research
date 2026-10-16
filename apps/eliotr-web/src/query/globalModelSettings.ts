import type { ServiceModelSettings, ServiceModelProviderCreateRequest, ServiceModelProviderConnection,
  createServiceModelSettingsApi } from "@eliotr/owner-api-client";
import type { ServiceModelCatalogPage } from "@eliotr/owner-api-client";
import type { UseQueryOptions } from "@tanstack/react-query";
import { isWorkspaceRequestError, type BoundWorkspaceApis } from "../app/runtime";
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
export async function readGlobalModelProviderOperation(input: { readonly api: Pick<ServiceModelSettingsApi, "readServiceModelProviderOperation">;
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
export async function configureGlobalModelProviderOnce(input: { readonly api: Pick<ServiceModelSettingsApi, "createServiceModelProvider" | "readServiceModelProviderOperation">;
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
  models: Pick<ServiceModelSettingsApi, "readServiceModelSettings">,
  privacy: PrivacyController,
  context: SessionContext,
): UseQueryOptions<ServiceModelSettings> {
  return {
    queryKey: [...protectedQueryKey(context, "service-model-settings"), "settings"] as const,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal, async readSignal =>
      models.readServiceModelSettings(context.deploymentGeneration, readSignal)),
  };
}

type ServiceModelCatalogApi = Pick<BoundWorkspaceApis["connections"]["models"], "readServiceModelCatalog">;
export type ServiceModelProviderConnectionV2 =
  Awaited<ReturnType<ServiceModelSettingsApi["readServiceModelProvidersV2"]>>["connections"][number];
export type ServiceModelCatalogPreferences =
  Awaited<ReturnType<ServiceModelSettingsApi["readServiceModelProviderCatalogPreferences"]>>;
export type ServiceModelCatalogPreferencesUpdate =
  Parameters<ServiceModelSettingsApi["updateServiceModelProviderCatalogPreferences"]>[0];
export type ServiceModelCatalogVisibility = ServiceModelCatalogPreferences["visibility"];
export type ServiceModelCatalogConnectRequest =
  Parameters<ServiceModelSettingsApi["createCatalogManagedServiceModelProvider"]>[0];

/** Service catalog reads are global owner facts and never depend on a selected project. */
export function serviceModelCatalogQueryOptions(
  models: ServiceModelCatalogApi,
  privacy: PrivacyController,
  context: SessionContext,
  request: ServiceModelCatalogQueryRequest,
): UseQueryOptions<ServiceModelCatalogPage> {
  const search = request.search?.trim() ?? "";
  const page = request.page ?? 1;
  const providerId = request.providerId;
  return {
    queryKey: [...protectedQueryKey(context, "service-model-catalog"), providerId ?? null, search, page] as const,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal, readSignal =>
      models.readServiceModelCatalog(context.deploymentGeneration, {
        ...(providerId === undefined ? {} : { providerId }), ...(search === "" ? {} : { search }), page,
      }, readSignal)),
  };
}

export function serviceModelProvidersV2QueryOptions(
  api: Pick<ServiceModelSettingsApi, "readServiceModelProvidersV2">,
  privacy: PrivacyController,
  context: SessionContext,
) {
  return {
    queryKey: [...protectedQueryKey(context, "service-model-settings"), "providers-v2"] as const,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal, readSignal =>
      api.readServiceModelProvidersV2(context.deploymentGeneration, readSignal)),
  };
}

export function serviceModelCatalogPreferencesQueryOptions(
  api: Pick<ServiceModelSettingsApi, "readServiceModelProviderCatalogPreferences">,
  privacy: PrivacyController,
  context: SessionContext,
  providerId: string,
) {
  return {
    queryKey: [...protectedQueryKey(context, "service-model-settings"), "catalog-preferences", providerId] as const,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal, readSignal =>
      api.readServiceModelProviderCatalogPreferences(providerId, context.deploymentGeneration, readSignal)),
  };
}

function sameCatalogVisibility(left: ServiceModelCatalogVisibility, right: ServiceModelCatalogVisibility): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "all" || left.mode === "none") return true;
  if (right.mode !== left.mode) return false;
  const leftIds = [...left.model_ids].sort(), rightIds = [...right.model_ids].sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

function preferencesMatch(preferences: ServiceModelCatalogPreferences, request: ServiceModelCatalogPreferencesUpdate): boolean {
  return preferences.provider_id === request.provider_id && preferences.search === request.search &&
    sameCatalogVisibility(preferences.visibility, request.visibility);
}

/** PUT is sent once; an uncertain ACK is reconciled with one readback, never a replacement write. */
export async function updateGlobalModelCatalogPreferencesOnce(input: {
  readonly api: Pick<ServiceModelSettingsApi, "updateServiceModelProviderCatalogPreferences" | "readServiceModelProviderCatalogPreferences">;
  readonly request: ServiceModelCatalogPreferencesUpdate;
  readonly generation: string; readonly signal: AbortSignal; readonly isCurrent: () => boolean;
}): Promise<ServiceModelCatalogPreferences | undefined> {
  assertCurrent(input.signal, input.isCurrent);
  try {
    const saved = await input.api.updateServiceModelProviderCatalogPreferences(input.request, input.generation, input.signal);
    assertCurrent(input.signal, input.isCurrent);
    return preferencesMatch(saved, input.request) ? saved : undefined;
  } catch {
    assertCurrent(input.signal, input.isCurrent);
    try {
      const saved = await input.api.readServiceModelProviderCatalogPreferences(
        input.request.provider_id, input.generation, input.signal);
      assertCurrent(input.signal, input.isCurrent);
      return preferencesMatch(saved, input.request) ? saved : undefined;
    } catch {
      assertCurrent(input.signal, input.isCurrent);
      return undefined;
    }
  }
}

export async function readGlobalCatalogManagedProviderOperation(input: {
  readonly api: Pick<ServiceModelSettingsApi, "readServiceModelProviderOperationV2">;
  readonly operationId: string; readonly generation: string;
  readonly signal: AbortSignal; readonly isCurrent: () => boolean;
}): Promise<ServiceModelProviderConnectionV2 | undefined> {
  assertCurrent(input.signal, input.isCurrent);
  try {
    const result = await input.api.readServiceModelProviderOperationV2(input.operationId, input.generation, input.signal);
    assertCurrent(input.signal, input.isCurrent);
    return result.connection ?? undefined;
  } catch {
    assertCurrent(input.signal, input.isCurrent);
    return undefined;
  }
}

function catalogConnectionMatchesRequest(
  connection: ServiceModelProviderConnectionV2,
  request: ServiceModelCatalogConnectRequest,
): boolean {
  return connection.model_registration_mode === "catalog_managed" &&
    connection.operation_id === request.operation_id && connection.provider_id === request.provider_id &&
    connection.display_name === request.display_name && connection.base_url === (request.base_url || null);
}

/** Catalog discovery occurs server-side after the write-only credential POST; no model IDs are supplied. */
export async function configureCatalogManagedProviderOnce(input: {
  readonly api: Pick<ServiceModelSettingsApi, "createCatalogManagedServiceModelProvider" | "readServiceModelProviderOperationV2">;
  readonly request: ServiceModelCatalogConnectRequest;
  readonly generation: string; readonly signal: AbortSignal; readonly isCurrent: () => boolean;
}): Promise<ServiceModelProviderConnectionV2 | undefined> {
  assertCurrent(input.signal, input.isCurrent);
  try {
    await input.api.createCatalogManagedServiceModelProvider(input.request, input.generation, input.signal);
  } catch (error) {
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
  const connection = await readGlobalCatalogManagedProviderOperation({ api: input.api,
    operationId: input.request.operation_id, generation: input.generation,
    signal: input.signal, isCurrent: input.isCurrent });
  return connection !== undefined && !catalogConnectionMatchesRequest(connection, input.request) ? undefined : connection;
}
