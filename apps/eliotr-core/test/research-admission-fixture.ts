import type { Env } from "../src/env.js";
import { createResearchOwnerRuntimeConfiguration } from "../src/research-owner-runtime-config.js";
import { admissionTestConfiguration } from "./research-current-dispatch-config.js";

/** Admission-only fixture: valid installer output, zero spend, no route qualification or provider call. */
export async function admissionTestEnvironment(runtime: Env, principal: string, tag: string): Promise<Env> {
  // Compile a structurally valid, explicit local-only configuration through the production installer.
  // No route is qualified and no gateway is contacted. Workflow execution is outside this admission test.
  const compiled = await createResearchOwnerRuntimeConfiguration(
    admissionTestConfiguration(runtime.DEPLOYMENT_GENERATION, principal, tag),
  );
  return { ...runtime, ...compiled.vars, ELIOTR_MODEL_GATEWAY_TOKEN: "local-admission-not-a-credential" };
}

export async function terminateAdmissionWorkflows(runtime: Env, ids: readonly string[]): Promise<void> {
  const terminal = new Set(["errored", "complete", "terminated"]);
  for (const id of ids) {
    const instance = await runtime.RESEARCH_WORKFLOW.get(id);
    if (terminal.has((await instance.status()).status)) continue;
    try { await instance.terminate(); }
    catch (error) { if (!terminal.has((await instance.status()).status)) throw error; }
  }
}
