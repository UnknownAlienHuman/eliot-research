import { queryOptions } from "@tanstack/react-query";
import type { ProjectGuideApi, ProjectGuideLanguage, ProjectGuideView } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

export interface ProjectGuideConnection {
  readonly api: ProjectGuideApi; readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly projectId: string; readonly hasSourceEvidence: boolean; readonly isProjectCurrent: () => boolean;
}
export function projectGuideQueryOptions(connection: ProjectGuideConnection, language: ProjectGuideLanguage) {
  const { api, privacy, context, projectId } = connection;
  return queryOptions({ queryKey: [...protectedQueryKey(context, "project-guide"), projectId, language],
    enabled: connection.hasSourceEvidence && privacy.isCurrent(context) && connection.isProjectCurrent(),
    retry: false, retryOnMount: false, refetchOnMount: false, refetchOnReconnect: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
      if (!connection.isProjectCurrent()) throw new Error("Project guide selection is no longer current");
      const view = await api.read(projectId, language, context.deploymentGeneration, readSignal);
      if (!connection.isProjectCurrent()) throw new Error("Project guide selection is no longer current");
      // A fresh read may recover a failed admission; renders only reuse the attempted latch.
      const state = openings.get(context), identity = guideIdentity(view);
      if (privacy.isCurrent(context) && !readSignal.aborted && state?.rejected.has(identity) && !state.pending.has(identity)) {
        if (view.state === "MISSING" && connection.hasSourceEvidence && view.source_count > 0 &&
            view.identity_digest !== null && view.project_id === projectId && view.language === language) {
          state.rejected.delete(identity);
          state.attempted.delete(identity);
          return ensureProjectGuideOnOpen(connection, view, readSignal) ?? view;
        }
        if (view.state !== "MISSING") state.rejected.delete(identity);
      }
      return view;
    }) });
}
// Only opaque identities survive settlement; private guide text lives in protected Query state.
const openings = new WeakMap<SessionContext, {
  attempted: Set<string>; rejected: Set<string>; pending: Map<string, Promise<ProjectGuideView>>;
}>();
function guideIdentity(view: ProjectGuideView) {
  return `${view.project_id}:${view.language}:${view.identity_digest}`;
}
export function ensureProjectGuideOnOpen(connection: ProjectGuideConnection, view: ProjectGuideView,
  signal: AbortSignal): Promise<ProjectGuideView> | undefined {
  if (!connection.hasSourceEvidence || view.state !== "MISSING" || view.source_count === 0 || view.identity_digest === null ||
      view.project_id !== connection.projectId || !connection.isProjectCurrent() ||
      !connection.privacy.isCurrent(connection.context) || signal.aborted) return undefined;
  let state = openings.get(connection.context);
  if (state === undefined) { state = { attempted: new Set(), rejected: new Set(), pending: new Map() }; openings.set(connection.context, state); }
  const identity = guideIdentity(view);
  const pending = state.pending.get(identity);
  if (pending !== undefined) return pending;
  if (state.attempted.has(identity)) return undefined;
  state.attempted.add(identity);
  const operation = runProtectedRead(connection.privacy, connection.context, signal, async readSignal => {
    if (!connection.isProjectCurrent()) throw new Error("Project guide selection changed before admission");
    let result: ProjectGuideView;
    try {
      result = await connection.api.ensure(connection.projectId, view.language, connection.context.deploymentGeneration, readSignal);
    } catch {
      state.rejected.add(identity);
      if (!connection.isProjectCurrent() || !connection.privacy.isCurrent(connection.context) || readSignal.aborted) {
        throw new Error("Project guide selection changed during admission");
      }
      // The POST may already have reserved a run. Reconcile with GET only; never retry here.
      result = await connection.api.read(connection.projectId, view.language, connection.context.deploymentGeneration, readSignal);
      if (guideIdentity(result) === identity && result.state !== "MISSING") state.rejected.delete(identity);
    }
    if (!connection.isProjectCurrent()) throw new Error("Project guide selection changed during admission");
    return result;
  });
  state.pending.set(identity, operation);
  void operation.finally(() => state?.pending.delete(identity)).catch(() => undefined);
  return operation;
}
