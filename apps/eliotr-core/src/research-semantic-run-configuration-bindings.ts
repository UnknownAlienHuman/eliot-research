import {
  bindHandlersToRunConfiguration as bindRuntimeHandlersToRunConfiguration,
  type ResearchSemanticRunActor,
  type ResearchSemanticRunConfigurationIdentity,
} from "@eliotr/cloudflare-research-runtime/research-semantic-run-configuration-bindings.js";
import type { ResolvedResearchRunConfiguration } from "./research-run-configuration.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import type { Env } from "./env.js";
import type { ResearchStageHandlerFactory } from "./research-stage-handlers.js";

export { bindResearchSemanticStageModelTransports } from
  "@eliotr/cloudflare-research-runtime/research-semantic-run-configuration-bindings.js";
export type {
  ResearchSemanticRunActor,
  ResearchSemanticRunModelConfiguration,
  ResearchSemanticBranchStage,
  ResearchSemanticStageModelBindings,
} from "@eliotr/cloudflare-research-runtime/research-semantic-run-configuration-bindings.js";

/** Preserve the Core API while injecting the live run-configuration reader at the composition boundary. */
export function bindHandlersToRunConfiguration(
  env: Env,
  actor: ResearchSemanticRunActor,
  expected: ResolvedResearchRunConfiguration,
  handlers: ResearchStageHandlerFactory,
): ResearchStageHandlerFactory {
  const expectedIdentity: ResearchSemanticRunConfigurationIdentity = Object.freeze({
    mode: expected.mode,
    configuration_ref: expected.configuration_ref,
    configuration_sha256: expected.configuration_sha256,
  });
  return bindRuntimeHandlersToRunConfiguration({
    actor,
    expected: expectedIdentity,
    handlers,
    read_current: async () => {
      const current = await readResearchRunConfiguration(env, actor);
      return Object.freeze({
        mode: current.mode,
        configuration_ref: current.configuration_ref,
        configuration_sha256: current.configuration_sha256,
      });
    },
  });
}
