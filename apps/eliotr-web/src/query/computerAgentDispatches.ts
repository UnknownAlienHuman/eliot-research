import type { ProjectListView } from "@eliotr/owner-api-client";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";

/** The current owner project page is a read holder, never delegation or mutation authority. */
export function computerAgentDispatchQueryOptions(
  apis: BoundWorkspaceApis, privacy: PrivacyController, context: SessionContext,
  page: ProjectListView, projectId: string, currentPage: () => ProjectListView | undefined,
  afterDispatchId?: string,
) {
  function requireProject() {
    if (currentPage() !== page || page.deployment_generation !== context.deploymentGeneration ||
        !page.projects.some(project => project.project_id === projectId)) {
      throw new Error("Task read requires the exact current owner project page");
    }
  }
  return {
    queryKey: [...protectedQueryKey(context, "computer-agent-dispatches"), projectId, afterDispatchId ?? null],
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal,
      async readSignal => {
        requireProject();
        const value = await apis.connections.computerAgentDispatches.readComputerAgentDispatches(
          projectId, context.deploymentGeneration, afterDispatchId, readSignal);
        requireProject();
        return value;
      }),
  };
}
