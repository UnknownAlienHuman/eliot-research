import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import {
  decodeComputerAgentDispatch,
  readComputerAgentDispatchRow,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-record";
import {
  createComputerAgentDispatchDeclineService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-decline";
import {
  failComputerAgentDispatch,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-error";
import type { McpComputerAgentDispatchCommand } from "@eliotr/cloudflare-workspace-mcp/research-service-operations.js";
import { createComputerAgentDispatchService } from "./computer-agent-dispatch-store.js";
import type { Env } from "./env.js";

export type McpComputerAgentDispatchServiceFactory = typeof createComputerAgentDispatchService;

function requireMcpWriteTransport(transport: string): void {
  if (transport !== "MCP_WRITE") failComputerAgentDispatch(
    "COMPUTER_AGENT_DISPATCH_DENIED", 403,
    "MCP dispatch tools can access only MCP_WRITE offers",
  );
}

export async function callMcpComputerAgentDispatch(
  env: Env,
  context: AuthenticatedRequestContext,
  command: McpComputerAgentDispatchCommand,
  createDispatchService: McpComputerAgentDispatchServiceFactory = createComputerAgentDispatchService,
): Promise<unknown> {
  const dispatches = createDispatchService(env);
  if (command.kind === "pull") {
    return dispatches.pull(context, { transport: "MCP_WRITE" });
  }

  const row = await readComputerAgentDispatchRow(env.CORE_DB, command.dispatch_id);
  if (row === null) {
    if (command.kind === "accept") return dispatches.accept(context, command.dispatch_id, {});
    return createComputerAgentDispatchDeclineService({ database: env.CORE_DB }).decline(
      context, command.dispatch_id, command.request,
    );
  }
  const dispatch = await decodeComputerAgentDispatch(row);
  requireMcpWriteTransport(dispatch.transport);

  if (command.kind === "accept") {
    return dispatches.accept(context, command.dispatch_id, {});
  }

  if (context.request.headers.get("Idempotency-Key") !== command.idempotency_key ||
      context.request.headers.get("X-Eliotr-Client-Grant") !== dispatch.client_grant_id) {
    failComputerAgentDispatch("COMPUTER_AGENT_DISPATCH_DENIED", 403,
      "Decline requires the selected dispatch grant and idempotency key");
  }
  const lease = await authorizeProjectClientGrant(env.CORE_DB, context, {
    operation: "run",
    project_id: dispatch.project_id,
    required_revision: dispatch.client_grant_revision,
  });
  const grant = lease.grant;
  const sameSelectedGrant = grant.grant_id === dispatch.client_grant_id &&
    grant.project_id === dispatch.project_id &&
    grant.grantor_principal_ref === dispatch.owner_principal_ref &&
    grant.revision === dispatch.client_grant_revision &&
    grant.grantee.issuer === dispatch.actor.issuer &&
    grant.grantee.authentication_method === dispatch.actor.authentication_method &&
    grant.grantee.subject === dispatch.actor.subject &&
    grant.allowed_operations.includes("recover") &&
    grant.allowed_operations.includes("evidence") &&
    grant.spend_policy_ref !== undefined;
  if (!sameSelectedGrant) failComputerAgentDispatch(
    "COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE", 409,
    "The exact current run, recovery, evidence and sponsorship delegation is required",
  );

  const receipt = await createComputerAgentDispatchDeclineService({
    database: env.CORE_DB,
  }).decline(context, command.dispatch_id, command.request);
  await lease.requireGrantCurrent();
  return receipt;
}
