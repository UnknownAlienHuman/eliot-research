/** C2-N resume coordinator, moved from the legacy source workspace.
 *
 * Single-flight, fencing and the separate renewed / confirmed / unresolved sets are preserved exactly.
 * Every authority is injected: the catalog, the renewal call, the session-current predicate, the
 * authorization-loss and request-error classifiers. This module imports no legacy package and constructs
 * no ambient fetch, timer, window or event, and it never advances or closes an epoch.
 */

import {
  type NamespaceApi,
  type OwnerSession,
  type RenewedSourceNamespace,
  type SourceNamespaceCatalog,
  type SourceNamespaceSummary,
} from "./catalog";

export interface OwnerNamespaceResumeBinding {
  readonly session: OwnerSession;
  readonly deploymentGeneration: string;
}

export interface OwnerNamespaceResumeResult {
  readonly stale: boolean;
  readonly catalog?: SourceNamespaceCatalog;
  readonly renewedNamespaceIds: readonly string[];
  readonly confirmedNamespaceIds: readonly string[];
  readonly unresolvedNamespaceIds: readonly string[];
}

export interface OwnerNamespaceResumePorts {
  readonly api: NamespaceApi;
  readonly isAuthorizationLoss: (error: unknown) => boolean;
  readonly isCurrent: (binding: OwnerNamespaceResumeBinding) => boolean;
  readonly isRequestError: (error: unknown) => error is Error & { readonly code: string; readonly status: number };
}

export function ownerNamespaceNeedsResume(
  namespace: SourceNamespaceSummary,
  session: OwnerSession,
): boolean {
  if (namespace.read_access !== "ACTIVE" && namespace.read_access !== "EXPIRED") return false;
  if (namespace.read_policy_generation === undefined || namespace.read_expires_at === undefined) return false;
  const policyExpiry = Date.parse(namespace.read_expires_at);
  const sessionExpiry = Date.parse(session.expires_at);
  return Number.isFinite(policyExpiry) && Number.isFinite(sessionExpiry) && policyExpiry < sessionExpiry;
}

function ownerNamespaceHasPolicyShorterThanSession(
  namespace: SourceNamespaceSummary,
  session: OwnerSession,
): boolean {
  if ((namespace.read_access !== "ACTIVE" && namespace.read_access !== "EXPIRED") ||
      namespace.read_policy_generation === undefined || namespace.read_expires_at === undefined) return false;
  const policyExpiry = Date.parse(namespace.read_expires_at);
  const sessionExpiry = Date.parse(session.expires_at);
  return Number.isFinite(policyExpiry) && Number.isFinite(sessionExpiry) && policyExpiry < sessionExpiry;
}

function ownerNamespaceCoversSession(namespace: SourceNamespaceSummary | undefined, session: OwnerSession): boolean {
  if (namespace?.read_access !== "ACTIVE" || namespace.read_policy_generation === undefined ||
      namespace.read_expires_at === undefined) return false;
  const policyExpiry = Date.parse(namespace.read_expires_at);
  const sessionExpiry = Date.parse(session.expires_at);
  return Number.isFinite(policyExpiry) && Number.isFinite(sessionExpiry) && policyExpiry >= sessionExpiry;
}

function staleResumeResult(): OwnerNamespaceResumeResult {
  return { stale: true, renewedNamespaceIds: [], confirmedNamespaceIds: [], unresolvedNamespaceIds: [] };
}

function applyRenewal(catalog: SourceNamespaceCatalog, renewed: RenewedSourceNamespace): SourceNamespaceCatalog {
  return {
    ...catalog,
    namespaces: catalog.namespaces.map((namespace) => namespace.source_namespace_id === renewed.source_namespace_id
      ? {
        ...namespace,
        title: renewed.title,
        read_policy_generation: renewed.read_policy_generation,
        read_expires_at: renewed.read_expires_at,
        read_access: renewed.read_access,
      }
      : namespace),
  };
}

async function resumeOwnerNamespaces(
  binding: OwnerNamespaceResumeBinding,
  ports: OwnerNamespaceResumePorts,
  signal: AbortSignal,
  isCurrent: () => boolean,
): Promise<OwnerNamespaceResumeResult> {
  let catalog: SourceNamespaceCatalog;
  try {
    catalog = await ports.api.readSourceNamespaces(binding.deploymentGeneration, signal);
  } catch (error) {
    if (!isCurrent()) return staleResumeResult();
    throw error;
  }
  if (!isCurrent()) return staleResumeResult();

  const renewedNamespaceIds: string[] = [];
  const confirmedNamespaceIds: string[] = [];
  const unresolvedNamespaceIds: string[] = [];
  for (const namespace of catalog.namespaces) {
    if (!ownerNamespaceHasPolicyShorterThanSession(namespace, binding.session)) continue;
    if (!isCurrent()) return staleResumeResult();
    const policyGeneration = namespace.read_policy_generation;
    if (policyGeneration === undefined) continue;
    if (policyGeneration >= Number.MAX_SAFE_INTEGER) {
      unresolvedNamespaceIds.push(namespace.source_namespace_id);
      continue;
    }
    try {
      const renewed = await ports.api.renewSourceNamespace(
        namespace.source_namespace_id,
        policyGeneration,
        binding.deploymentGeneration,
        signal,
      );
      if (!isCurrent()) return staleResumeResult();
      if (renewed.read_access !== "ACTIVE" || renewed.read_policy_generation !== policyGeneration + 1 ||
          renewed.read_expires_at !== binding.session.expires_at) {
        unresolvedNamespaceIds.push(namespace.source_namespace_id);
        continue;
      }
      catalog = applyRenewal(catalog, renewed);
      renewedNamespaceIds.push(namespace.source_namespace_id);
    } catch (error) {
      if (!isCurrent()) return staleResumeResult();
      if ((ports.isRequestError(error) && error.code === "API_GENERATION_MISMATCH") || ports.isAuthorizationLoss(error)) throw error;
      if (ports.isRequestError(error) && error.status === 409) {
        let readback: SourceNamespaceCatalog;
        try {
          readback = await ports.api.readSourceNamespaces(binding.deploymentGeneration, signal);
        } catch (readbackError) {
          if (!isCurrent()) return staleResumeResult();
          if ((ports.isRequestError(readbackError) && readbackError.code === "API_GENERATION_MISMATCH") ||
              ports.isAuthorizationLoss(readbackError)) {
            throw readbackError;
          }
          unresolvedNamespaceIds.push(namespace.source_namespace_id);
          continue;
        }
        if (!isCurrent()) return staleResumeResult();
        catalog = readback;
        const current = catalog.namespaces.find((item) => item.source_namespace_id === namespace.source_namespace_id);
        if (current?.read_policy_generation !== undefined && current.read_policy_generation > policyGeneration &&
            ownerNamespaceCoversSession(current, binding.session)) {
          confirmedNamespaceIds.push(namespace.source_namespace_id);
        } else {
          unresolvedNamespaceIds.push(namespace.source_namespace_id);
        }
        continue;
      }
      if (ports.isAuthorizationLoss(error)) throw error;
      unresolvedNamespaceIds.push(namespace.source_namespace_id);
    }
  }
  if (!isCurrent()) return staleResumeResult();
  return { stale: false, catalog, renewedNamespaceIds, confirmedNamespaceIds, unresolvedNamespaceIds };
}

/** Coalesces same-session bootstrap work and fences stale session/deployment completions. */
export function createOwnerNamespaceResumeCoordinator(ports: OwnerNamespaceResumePorts): {
  run(session: OwnerSession, deploymentGeneration: string): Promise<OwnerNamespaceResumeResult>;
  clear(): void;
} {
  let serial = 0;
  let active: { readonly key: string; readonly serial: number; readonly controller: AbortController; readonly promise: Promise<OwnerNamespaceResumeResult> } | undefined;
  const bindingKey = (binding: OwnerNamespaceResumeBinding): string => JSON.stringify([
    binding.deploymentGeneration,
    binding.session.principal_ref,
    binding.session.credential_generation,
    binding.session.expires_at,
  ]);

  const clear = (): void => {
    serial += 1;
    active?.controller.abort();
    active = undefined;
  };
  const run = (session: OwnerSession, deploymentGeneration: string): Promise<OwnerNamespaceResumeResult> => {
    const binding = { session, deploymentGeneration };
    if (!ports.isCurrent(binding)) return Promise.resolve(staleResumeResult());
    const key = bindingKey(binding);
    if (active?.key === key) return active.promise;
    active?.controller.abort();
    const mine = ++serial;
    const controller = new AbortController();
    const isCurrent = (): boolean => mine === serial && !controller.signal.aborted && ports.isCurrent(binding);
    const promise = resumeOwnerNamespaces(binding, ports, controller.signal, isCurrent)
      .finally(() => { if (active?.serial === mine) active = undefined; });
    active = { key, serial: mine, controller, promise };
    return promise;
  };
  return { run, clear };
}
