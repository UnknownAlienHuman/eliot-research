import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";

/** Bind approved catalog prices to the main stages independently of optional branch roles. */
export async function researchSemanticNativeMainPricing(runtime: Readonly<{
  selections: ReadonlyMap<string, Readonly<{ candidate_kind?: unknown }>>;
  pricingForStage(stage: "SYNTHESIZE" | "AUDIT_CLAIMS"): Promise<ModelGatewayPricingPort | undefined>;
}>): Promise<Readonly<{ synthesis?: ModelGatewayPricingPort; audit?: ModelGatewayPricingPort }>> {
  const read = async (stage: "SYNTHESIZE" | "AUDIT_CLAIMS") => {
    if (runtime.selections.get(stage)?.candidate_kind !== "provider-native-v2") return undefined;
    const pricing = await runtime.pricingForStage(stage);
    if (pricing === undefined) throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING");
    return pricing;
  };
  const [synthesis, audit] = await Promise.all([read("SYNTHESIZE"), read("AUDIT_CLAIMS")]);
  return Object.freeze({ ...(synthesis === undefined ? {} : { synthesis }), ...(audit === undefined ? {} : { audit }) });
}
