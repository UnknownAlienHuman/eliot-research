import type { ProjectClientGrant, ComputerAgentQualificationTransport } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  callExternalAgentTaskTool as call,
  EXTERNAL_AGENT_TASK_TOOL_NAMES,
  isExternalAgentTaskToolName,
  type ExternalAgentTaskToolName,
} from "@eliotr/cloudflare-workspace-mcp/mcp-external-agent-task";
import type { ComputerAgentRuntime } from "@eliotr/cloudflare-computer-agent/runtime";
import type { Env } from "./env.js";
import { recoverResearchRun } from "./research-run-control.js";

export { EXTERNAL_AGENT_TASK_TOOL_NAMES, isExternalAgentTaskToolName };
export type { ExternalAgentTaskToolName };

export function callExternalAgentTaskTool(
  env: Env,
  context: AuthenticatedRequestContext,
  grant: ProjectClientGrant,
  name: ExternalAgentTaskToolName,
  input: Record<string, unknown>,
  transport: ComputerAgentQualificationTransport,
): Promise<unknown> {
  const runtime: ComputerAgentRuntime = {
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  return call(runtime, context, grant, name, input, transport,
    (wakeContext, operationId) => recoverResearchRun(env, wakeContext, operationId, {}));
}
