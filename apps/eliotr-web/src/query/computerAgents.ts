import type { ComputerAgentConnectionList } from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import type { BoundWorkspaceApis } from "../app/runtime";
import { protectedQueryKey, runProtectedRead } from "./client";

/** Configuration is displayed separately from observed qualification or presence. */
export function computerAgentQueryOptions(apis: BoundWorkspaceApis, privacy: PrivacyController,
  context: SessionContext, afterConnectionId?: string) {
  return {
    queryKey: [...protectedQueryKey(context, "computer-agents"), afterConnectionId ?? null],
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal,
      async readSignal => {
        const page: ComputerAgentConnectionList = await apis.connections.computerAgents.readComputerAgentConnections(
          context.deploymentGeneration, afterConnectionId, readSignal);
        if (page.connections.some(connection => connection.owner_principal_ref !== context.principal)) {
          throw new Error("Agent connections belong to another owner");
        }
        return page;
      }),
  };
}
