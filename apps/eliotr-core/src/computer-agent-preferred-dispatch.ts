import {
  createComputerAgentPreferredDispatchService as createService,
} from "@eliotr/cloudflare-computer-agent/computer-agent-preferred-dispatch";
import type { ComputerAgentRuntime } from "@eliotr/cloudflare-computer-agent/runtime";
import { createComputerAgentDispatchService } from "./computer-agent-dispatch-store.js";
import type { Env } from "./env.js";

export function createComputerAgentPreferredDispatchService(env: Env,
  options?: { readonly now?: () => number }) {
  const runtime: ComputerAgentRuntime = {
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  return createService(runtime, {
    ...(options?.now === undefined ? {} : { now: options.now }),
    create_dispatch_service: (dispatchOptions) => createComputerAgentDispatchService(env, dispatchOptions),
  });
}
