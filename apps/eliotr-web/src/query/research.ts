import { queryOptions } from "@tanstack/react-query";
import type { ResearchRunLaunchView } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

/**
 * Research query owns remote run state. It reads only: the already composed runtime APIs are consumed
 * as they are, and no factory, privacy type or epoch is created here.
 *
 * Starting a run, minting intent and polling stay with the root controller. This helper only prepares
 * the three canonical reads and fences each one on the supplied session context.
 */
export interface ResearchQueryApis {
  readonly runs: BoundWorkspaceApis["research"]["runs"];
  readonly history: BoundWorkspaceApis["research"]["history"];
  readonly configuration: BoundWorkspaceApis["connections"]["configuration"];
}

export function researchQueryOptions(
  apis: ResearchQueryApis,
  privacy: PrivacyController,
  context: SessionContext,
) {
  const generation = context.deploymentGeneration;
  const key = protectedQueryKey(context, "research");

  /** The full run identity: a status read is meaningless without the workflow and investigation. */
  const statusKey = (launch: ResearchRunLaunchView) =>
    [...key, "status", launch.workflow_instance_id, launch.investigation_ref.id, launch.investigation_ref.revision];

  /**
   * Identity fence around a status read: the response must belong to the launch that requested it,
 * and the session must still be the one that produced it.
   */
  const matchesLaunch = (view: { workflow_instance_id: string; investigation_ref: { id: string; revision: number } }, launch: ResearchRunLaunchView): boolean =>
    view.workflow_instance_id === launch.workflow_instance_id &&
    view.investigation_ref.id === launch.investigation_ref.id &&
    view.investigation_ref.revision === launch.investigation_ref.revision;

  return {
    configuration() {
      return queryOptions({
        queryKey: [...key, "configuration"],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
          readSignal => apis.configuration.readResearchConfiguration(generation, { signal: readSignal })),
      });
    },

    history() {
      return queryOptions({
        queryKey: [...key, "history"],
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal,
          readSignal => apis.history.readResearchRunHistory(generation, readSignal)),
      });
    },

    status(launch: ResearchRunLaunchView) {
      return queryOptions({
        queryKey: statusKey(launch),
        refetchOnMount: false,
        queryFn: ({ signal }) => runProtectedRead(privacy, context, signal, async readSignal => {
          const view = await apis.runs.readResearchRunStatus(launch.workflow_instance_id, generation, readSignal);
          if (!matchesLaunch(view, launch)) {
            throw new Error("Status response does not belong to the requested run");
          }
          return view;
        }),
      });
    },
  };
}
