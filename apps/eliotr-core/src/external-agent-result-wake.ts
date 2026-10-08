import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  externalAgentRecoveryKey,
  parseExternalAgentResultReceipt,
  wakeExternalAgentResultWorkflow as wake,
} from "@eliotr/cloudflare-workspace-mcp/external-agent-result-wake";
import type { Env } from "./env.js";
import { recoverResearchRun } from "./research-run-control.js";

export { externalAgentRecoveryKey, parseExternalAgentResultReceipt };

export function wakeExternalAgentResultWorkflow(
  env: Env,
  context: AuthenticatedRequestContext,
  rawReceipt: unknown,
): Promise<Readonly<Record<string, unknown>>> {
  return wake(context, rawReceipt,
    (wakeContext, operationId) => recoverResearchRun(env, wakeContext, operationId, {}));
}
