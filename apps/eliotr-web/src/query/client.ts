import { QueryClient } from "@tanstack/react-query";
import type { PrivacyController, SessionContext } from "../app/privacy";

export function createWorkspaceQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, gcTime: 0, meta: { protected: true } },
      mutations: { retry: false, meta: { protected: true } },
    },
  });
}
/** No URL, storage, dehydration or credentials are used to construct this key. */
export function protectedQueryKey(context: SessionContext, resource: string) {
  return ["owner", context.cacheEpoch, context.principal, context.credentialGeneration, context.deploymentGeneration, resource] as const;
}
export function clearWorkspaceQueries(client: QueryClient) {
  client.clear();
}

export class ProtectedReadClosedError extends Error {
  public constructor() { super("Protected read is no longer current"); this.name = "ProtectedReadClosedError"; }
}
export async function runProtectedRead<T>(privacy: PrivacyController, context: SessionContext, signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (signal.aborted || !privacy.isCurrent(context)) throw new ProtectedReadClosedError();
  const result = await read(signal);
  if (signal.aborted || !privacy.isCurrent(context)) throw new ProtectedReadClosedError();
  return result;
}
