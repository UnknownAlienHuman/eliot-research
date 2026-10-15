import type { ComputerAgentConnection } from "@eliotr/owner-api-client";
import type { ComputerAgentQualificationTransport, ProjectClientGrant } from "@eliotr/contracts";
import type { BoundWorkspaceApis } from "../app/runtime";
import type { PrivacyController, SessionContext } from "../app/privacy";
import { protectedQueryKey, runProtectedRead } from "./client";
import { computerAgentQueryOptions } from "./computerAgents";

function requireCurrentProject(
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string,
  isProjectCurrent: () => boolean,
): void {
  if (!privacy.isCurrent(context) || !isProjectCurrent() || !projectId.trim()) {
    throw new Error("Agent assignment requires the current owner project");
  }
}

export function computerAgentTaskRouteReadinessOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string,
  isProjectCurrent: () => boolean,
  transport: ComputerAgentQualificationTransport,
) {
  return {
    queryKey: [...protectedQueryKey(context, "computer-agent-task-route"), projectId, transport] as const,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal,
      async readSignal => {
        requireCurrentProject(privacy, context, projectId, isProjectCurrent);
        const readiness = await apis.connections.computerAgentTasks.readComputerAgentRouteReadiness(
          projectId, transport, context.deploymentGeneration, readSignal,
        );
        requireCurrentProject(privacy, context, projectId, isProjectCurrent);
        return readiness;
      }),
  };
}

export function computerAgentTaskGrantOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string,
  isProjectCurrent: () => boolean,
  connection: ComputerAgentConnection,
) {
  return {
    queryKey: [...protectedQueryKey(context, "computer-agent-task-grant"), projectId,
      connection.connection_id, connection.revision, connection.actor.issuer, connection.actor.subject] as const,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }: { readonly signal: AbortSignal }): Promise<ProjectClientGrant | null> =>
      runProtectedRead(privacy, context, signal, async readSignal => {
        requireCurrentProject(privacy, context, projectId, isProjectCurrent);
        if (connection.state !== "ENABLED" || connection.owner_principal_ref !== context.principal) {
          throw new Error("The selected agent connection is disabled or belongs to another owner");
        }
        let after: string | undefined;
        const seen = new Set<string>();
        while (true) {
          const page = await apis.connections.grants.readClientGrants(
            projectId, context.deploymentGeneration, after, readSignal,
          );
          requireCurrentProject(privacy, context, projectId, isProjectCurrent);
          if (page.grants.some(grant => grant.project_id !== projectId ||
              grant.grantor_principal_ref !== context.principal)) {
            throw new Error("Project grant read returned a foreign owner or project");
          }
          const match = page.grants.find(grant => grant.state === "ACTIVE" &&
            grant.grantee.authentication_method === connection.actor.authentication_method &&
            grant.grantee.issuer === connection.actor.issuer && grant.grantee.subject === connection.actor.subject &&
            grant.allowed_operations.includes("run"));
          if (match) return match;
          const next = page.next_grant_id;
          if (next === undefined) return null;
          if (next === after || seen.has(next)) throw new Error("Project grant paging did not advance");
          seen.add(next);
          after = next;
        }
      }),
  };
}

export function computerAgentTaskTargetConnectionsOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  afterConnectionId?: string,
) {
  return computerAgentQueryOptions(apis, privacy, context, afterConnectionId);
}

export function computerAgentTaskStatusOptions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  projectId: string,
  dispatchId: string,
  isProjectCurrent: () => boolean,
) {
  return {
    queryKey: [...protectedQueryKey(context, "computer-agent-task-status"), projectId, dispatchId] as const,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => runProtectedRead(privacy, context, signal,
      async readSignal => {
        requireCurrentProject(privacy, context, projectId, isProjectCurrent);
        const status = await apis.connections.computerAgentTasks.readComputerAgentDispatchStatus(
          projectId, dispatchId, context.deploymentGeneration, context.principal,
          context.credentialGeneration, readSignal,
        );
        requireCurrentProject(privacy, context, projectId, isProjectCurrent);
        return status;
      }),
  };
}

export function computerAgentTaskAssignmentActions(
  apis: BoundWorkspaceApis,
  privacy: PrivacyController,
  context: SessionContext,
  isProjectCurrent: () => boolean,
) {
  return Object.freeze({
    prepare(projectId: string, connection: ComputerAgentConnection, input: unknown) {
      requireCurrentProject(privacy, context, projectId, isProjectCurrent);
      return apis.connections.computerAgentTasks.prepareComputerAgentDispatch(
        projectId, context.deploymentGeneration, context.principal, context.credentialGeneration, connection, input,
      );
    },
    async execute(intent: Parameters<BoundWorkspaceApis["connections"]["computerAgentTasks"]["executeComputerAgentDispatch"]>[0]) {
      requireCurrentProject(privacy, context, intent.projectId, isProjectCurrent);
      const dispatch = await apis.connections.computerAgentTasks.executeComputerAgentDispatch(intent);
      requireCurrentProject(privacy, context, intent.projectId, isProjectCurrent);
      return dispatch;
    },
  });
}
