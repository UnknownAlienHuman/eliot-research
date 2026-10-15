import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";

type ProviderApi = BoundWorkspaceApis["connections"]["providers"];
type ProviderConfiguration = Awaited<ReturnType<ProviderApi["readResearchProviderKeyConfigurations"]>>["configurations"][number];

export class ModelSettingsRequestClosedError extends Error {
  public constructor() {
    super("Model settings request is no longer current");
    this.name = "ModelSettingsRequestClosedError";
  }
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
  try {
    receipt = await input.providers.configureResearchProviderKey(input.projectId, input.deploymentGeneration,
      input.operationId, input.providerKey, input.signal);
  } catch {
    // A lost acknowledgement is reconciled below. It never causes another POST.
    assertCurrent();
  }
  assertCurrent();
  try {
    const page = await input.providers.readResearchProviderKeyConfigurations(input.projectId,
      input.deploymentGeneration, input.signal, input.operationId);
    assertCurrent();
    const configuration = page.configurations.find(item => item.operation_id === input.operationId);
    if (configuration && receipt && (receipt.project_id !== input.projectId || receipt.operation_id !== input.operationId ||
        receipt.provider_id !== configuration.provider_id || receipt.alias !== configuration.alias ||
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
