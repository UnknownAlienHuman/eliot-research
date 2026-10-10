import { queryOptions } from "@tanstack/react-query";
import type { LibraryPage, ErasurePrepareView, ErasureStatusView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import type { BoundWorkspaceApis } from "../app/runtime";
import { protectedQueryKey, runProtectedRead } from "./client";

/** The component keeps the intent identifier locally; Query holds every returned server value. */
export function erasureActions(
  api: BoundWorkspaceApis["sources"]["erasure"], privacy: PrivacyController, context: SessionContext,
  current: { readonly library: () => LibraryPage | undefined; readonly prepared: () => ErasurePrepareView | undefined },
) {
  const key = protectedQueryKey(context, "erasure");
  const assertSource = (page: LibraryPage, sourceId: string) => {
    if (current.library() !== page || page.generation !== context.deploymentGeneration ||
        !page.sources.some(source => source.id === sourceId)) throw new Error("Deletion source is no longer current");
  };
  const assertPrepared = (prepared: ErasurePrepareView) => {
    if (current.prepared() !== prepared || prepared.deployment_generation !== context.deploymentGeneration) {
      throw new Error("Deletion review is no longer current");
    }
  };
  return {
    preparedKey(sourceId: string, intent: string) { return [...key, "prepared", sourceId, intent] as const; },
    /** This mutation is called only by the explicit review action; its intent is reused on failure. */
    prepare(page: LibraryPage, sourceId: string, intent: string, signal: AbortSignal) {
      return runProtectedRead(privacy, context, signal, async readSignal => {
        assertSource(page, sourceId);
        const prepared = await api.prepareErasureForOwner(sourceId, intent, context.deploymentGeneration, readSignal);
        assertSource(page, sourceId);
        return prepared;
      });
    },
    /** No effect, refresh, reconnect or retry policy calls this destructive operation. */
    confirm(prepared: ErasurePrepareView, signal: AbortSignal) {
      return runProtectedRead(privacy, context, signal, async readSignal => {
        assertPrepared(prepared);
        const receipt = await api.executePreparedErasure(prepared, context.deploymentGeneration, readSignal);
        assertPrepared(prepared);
        const expected = prepared.request.request.erasure_ref;
        if (receipt.erasure_ref.id !== expected.id || receipt.erasure_ref.revision !== expected.revision) {
          throw new Error("Deletion receipt belongs to a different request");
        }
        return receipt;
      });
    },
    status(prepared: ErasurePrepareView) {
      const ref = prepared.request.request.erasure_ref;
      return queryOptions({ queryKey: [...key, "status", ref.id, ref.revision], retry: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          assertPrepared(prepared);
          const status = await api.readErasureStatus(ref, context.deploymentGeneration, readSignal);
          assertPrepared(prepared);
          if (status && (status.erasure_ref.id !== ref.id || status.erasure_ref.revision !== ref.revision)) {
            throw new Error("Deletion status belongs to a different request");
          }
          return status;
        }),
      });
    },
  };
}

/** An execute receipt alone is insufficient: completion requires matching fresh status readback. */
export function isErasureComplete(prepared: ErasurePrepareView, status: ErasureStatusView | null | undefined,
  privacy: PrivacyController, context: SessionContext): boolean {
  const ref = prepared.request.request.erasure_ref;
  return privacy.isCurrent(context) && status?.deployment_generation === context.deploymentGeneration &&
    status.state === "COMPLETE" && status.erasure_ref.id === ref.id && status.erasure_ref.revision === ref.revision &&
    status.receipt?.state === "COMPLETE" && status.receipt.erasure_ref.id === ref.id &&
    status.receipt.erasure_ref.revision === ref.revision && status.receipt.purge_ledger_entry_ref.length > 0;
}
