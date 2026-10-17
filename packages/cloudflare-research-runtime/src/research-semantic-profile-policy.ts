import {
  parseResearchModelProfileDefinition,
  readOwnerModelProfileTemplateV2,
  type ReferenceManifestPolicyProfile,
} from "@eliotr/cloudflare-research";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";

function invalid(): never {
  throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
}

function missing(): never {
  throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING");
}

/** Read legacy definitions directly, but materialize V2 owner templates through the current-authority producer. */
export async function resolveResearchSemanticServerRoleModelPolicy(input: {
  readonly raw: string | undefined;
  readonly provenance_ref: string | undefined;
  readonly materialize_owner_template: (model_profile_ref: string) =>
    Promise<Readonly<{ policy: ReferenceManifestPolicyProfile }>>;
}): Promise<ReferenceManifestPolicyProfile> {
  if (typeof input.raw !== "string" || input.raw.trim() === "") missing();
  if (typeof input.provenance_ref !== "string" || input.provenance_ref.trim() === "") missing();
  let decoded: unknown;
  try { decoded = JSON.parse(input.raw) as unknown; } catch { invalid(); }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) invalid();
  const schema = (decoded as Record<string, unknown>).schema;
  if (schema === "eliotr.research.model-profile-definition.v2") {
    let template;
    try { template = await readOwnerModelProfileTemplateV2(decoded, input.provenance_ref); }
    catch { invalid(); }
    // The producer revalidates this exact source and binds it to persisted W1,
    // the active scope/grant, the run deadline, and the immutable synthesis pin.
    return (await input.materialize_owner_template(template.model_profile_ref)).policy;
  }
  let definition;
  try { definition = await parseResearchModelProfileDefinition(decoded); }
  catch { invalid(); }
  if (definition.config_provenance_ref !== input.provenance_ref) invalid();
  return definition.policy;
}
