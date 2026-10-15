import type {
  ComputerAgentConnection,
  ComputerAgentConnectionMutationIntent,
} from "@eliotr/owner-api-client";
import type { PrivacyController, SessionContext } from "../app/privacy";
import type { BoundWorkspaceApis } from "../app/runtime";
import { protectedQueryKey, runProtectedRead } from "./client";
import { computerAgentQueryOptions } from "./computerAgents";

export function computerAgentConnectionOperationKey(context: SessionContext) {
  return [...protectedQueryKey(context, "computer-agent-operation"), "local-intent"] as const;
}

export type ComputerAgentConnectionPutInput = Omit<ComputerAgentConnection,
  "protocol" | "connection_id" | "revision" | "owner_principal_ref" | "state" | "created_at" | "updated_at"> & {
    readonly expected_revision: number;
  };

export function computerAgentConnectionReadbackPageOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  connectionId: string,
  afterConnectionId?: string,
) {
  const listPage = computerAgentQueryOptions(apis, privacy, context, afterConnectionId);
  return {
    queryKey: [...protectedQueryKey(context, "computer-agent-readback"), connectionId, afterConnectionId ?? null] as const,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }: { readonly signal: AbortSignal }) => {
      const page = await listPage.queryFn({ signal });
      return { page, connection: page.connections.find(item => item.connection_id === connectionId) };
    },
  };
}

export type ComputerAgentConnectionReadbackPage = Awaited<
  ReturnType<ReturnType<typeof computerAgentConnectionReadbackPageOptions>["queryFn"]>
>;

export type ComputerAgentQualificationStatus = Awaited<
  ReturnType<BoundWorkspaceApis["connections"]["computerAgents"]["readComputerAgentQualification"]>
>;

function requireContextOwner(connection: ComputerAgentConnection, context: SessionContext): void {
  if (connection.owner_principal_ref !== context.principal) {
    throw new Error("Computer-agent connection belongs to another owner");
  }
}

export function computerAgentQualificationOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  connection: ComputerAgentConnection,
  transport: ComputerAgentQualificationStatus["transport"],
) {
  requireContextOwner(connection, context);
  return {
    queryKey: [...protectedQueryKey(context, "computer-agent-qualification"),
      connection.connection_id, connection.revision, transport] as const,
    staleTime: 0,
    gcTime: 0,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(
      privacy,
      context,
      signal,
      readSignal => apis.connections.computerAgents.readComputerAgentQualification(
        connection, transport, context.deploymentGeneration, readSignal,
      ),
    ),
  };
}

function requireCurrent(privacy: PrivacyController, context: SessionContext): void {
  if (!privacy.isCurrent(context)) throw new Error("Owner session is no longer current");
}

export function computerAgentConnectionMutationActions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
) {
  const api = apis.connections.computerAgents;
  return Object.freeze({
    preparePut(connectionId: string, input: ComputerAgentConnectionPutInput, current?: ComputerAgentConnection) {
      requireCurrent(privacy, context);
      if (current !== undefined) requireContextOwner(current, context);
      return api.prepareComputerAgentConnectionPut(connectionId, context.deploymentGeneration, input, current);
    },
    prepareDisable(current: ComputerAgentConnection) {
      requireCurrent(privacy, context);
      requireContextOwner(current, context);
      return api.prepareComputerAgentConnectionDisable(current, context.deploymentGeneration);
    },
    async execute(intent: ComputerAgentConnectionMutationIntent) {
      requireCurrent(privacy, context);
      const receipt = await api.executeComputerAgentConnectionMutation(intent);
      requireCurrent(privacy, context);
      requireContextOwner(receipt, context);
      return receipt;
    },
  });
}
