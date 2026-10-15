import { isWorkspaceRequestError, type BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";

type ProviderApi = BoundWorkspaceApis["connections"]["providers"];
type ProviderConfiguration = Awaited<ReturnType<ProviderApi["readResearchProviderKeyConfigurations"]>>["configurations"][number];

/** Exact server code for a definite pre-effect denial: no key was written and no intent was recorded. */
const PROVIDER_KEY_MANAGEMENT_UNAVAILABLE = "RESEARCH_PROVIDER_KEY_CONFIGURATION_MANAGEMENT_UNAVAILABLE";

export class ModelSettingsRequestClosedError extends Error {
  public constructor() {
    super("Model settings request is no longer current");
    this.name = "ModelSettingsRequestClosedError";
  }
}

/**
 * The server refused this write before any effect: no provider key was created and no operation
 * intent was recorded, so nothing is uncertain. The owner may submit again after the server's
 * management connection exists; this helper never resends the key on its own.
 */
export class ModelSettingsProviderKeyUnavailableError extends Error {
  public constructor() {
    super("Provider key management is unavailable on this server");
    this.name = "ModelSettingsProviderKeyUnavailableError";
  }
}

/**
 * Only this exact typed denial is definite. Every other transport or server failure keeps its
 * hidden identity and stays reconciled by readback, so an uncertain outcome is never reported as
 * understood, and no raw error or key material is inspected or recorded here.
 */
function isProviderKeyManagementUnavailable(error: unknown): boolean {
  return isWorkspaceRequestError(error) && error.status === 503 &&
    error.code === PROVIDER_KEY_MANAGEMENT_UNAVAILABLE;
}

/**
 * Submit one write-only key request, then reconcile only by GET with that same internal operation ID.
 * The key is never added to Query state, a URL, or returned from this helper.
 */
export async function configureProviderKeyOnceAndReadBack(input: {
  readonly providers: ProviderApi;
  readonly projectId: string;
  readonly deploymentGeneration: string;
  readonly operationId: string;
  readonly providerKey: string;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}): Promise<ProviderConfiguration | undefined> {
  const assertCurrent = () => {
    if (input.signal.aborted || !input.isCurrent()) throw new ModelSettingsRequestClosedError();
  };
  assertCurrent();
  let receipt: Awaited<ReturnType<ProviderApi["configureResearchProviderKey"]>> | undefined;
  let writeFailure: unknown;
  try {
    receipt = await input.providers.configureResearchProviderKey(input.projectId, input.deploymentGeneration,
      input.operationId, input.providerKey, input.signal);
  } catch (error) {
    // A lost acknowledgement is reconciled below. It never causes another POST.
    writeFailure = error;
    assertCurrent();
  }
  // A pre-effect denial already is the whole answer: there is no hidden identity to reconcile, so
  // no readback is issued and the key is never repeated automatically.
  if (isProviderKeyManagementUnavailable(writeFailure)) throw new ModelSettingsProviderKeyUnavailableError();
  assertCurrent();
  try {
    const page = await input.providers.readResearchProviderKeyConfigurations(input.projectId,
      input.deploymentGeneration, input.signal, input.operationId);
    assertCurrent();
    const configuration = page.configurations.find(item => item.operation_id === input.operationId);
    if (configuration && receipt && (receipt.project_id !== input.projectId || receipt.operation_id !== input.operationId ||
        receipt.provider_id !== page.provider_id || receipt.alias !== configuration.alias ||
        receipt.provider_config_id !== configuration.provider_config_id || configuration.status !== "configured_not_qualified")) {
      return undefined;
    }
    return configuration;
  } catch {
    assertCurrent();
    return undefined;
  }
}

/** Clear password form memory and cancel in-flight work when owner authority closes or the pane leaves. */
export function bindModelSettingsSecretLifetime(
  privacy: Pick<PrivacyController, "isCurrent" | "subscribe">,
  context: SessionContext,
  clear: () => void,
  abort: () => void,
): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clear();
    abort();
  };
  const unsubscribe = privacy.subscribe(() => {
    if (!privacy.isCurrent(context)) close();
  });
  return () => {
    unsubscribe();
    close();
  };
}
