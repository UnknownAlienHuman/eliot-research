import {
  ResearchBranchRoleSchema,
  type ObjectResidencyKey,
  type ResearchBranchRole,
} from "@eliotr/contracts";
import {
  type CloudflareEvidenceResolver,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  createResearchBranchRoleManifestStore,
  createResearchReferenceManifestService,
  deriveBranchRoleManifestRef,
  type BuildReferenceManifestInput,
  type ReferenceManifestPolicyProfile,
  type ResearchModelPromptCompilerDependencies,
  type TrustedModelPromptParameters,
} from "@eliotr/cloudflare-research";
import type { ModelCallInput } from "@eliotr/research";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ResearchBranchRolePromptDependenciesInput } from "./research-branch-role-prompt.js";

export interface ResearchBranchRoleServerPromptInput {
  readonly role: ResearchBranchRole;
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly evidence_resolver: CloudflareEvidenceResolver;
  readonly residency_template: Omit<ObjectResidencyKey, "content_digest">;
  /** Installed workflow model profile definition policy; the same policy synthesis uses. */
  readonly model_policy: ReferenceManifestPolicyProfile;
  /** Explicitly installed by the server; no model or prompt defaults are selected here. */
  readonly trusted_parameters: TrustedModelPromptParameters;
  readonly request_timeout_ms: number;
}

function fail(message: string): never {
  throw new Error(`research branch role server prompt: ${message}`);
}

/**
 * Builds the installed per-role prompt inputs for server composition. The
 * composition turns these into prompt compiler dependencies via
 * createResearchBranchRolePromptDependencies. The reference manifest is built
 * and persisted at prompt compile time over the role's Variant A evidence
 * pack (a filtered projection of the frozen stage-five pack, so the frozen
 * manifest service cannot apply); the manifest store is namespaced to
 * branch-role manifests and bound to the current owner navigation authority.
 */
export function createResearchBranchRoleServerPromptInput(
  rawInput: ResearchBranchRoleServerPromptInput,
): ResearchBranchRolePromptDependenciesInput {
  if (rawInput === null || typeof rawInput !== "object" ||
      typeof rawInput.work_bucket?.head !== "function" || typeof rawInput.work_bucket?.get !== "function" ||
      typeof rawInput.navigation?.current !== "function" ||
      typeof rawInput.evidence_resolver?.resolveHandle !== "function" ||
      typeof rawInput.residency_template !== "object" || rawInput.residency_template === null ||
      typeof rawInput.model_policy !== "object" || rawInput.model_policy === null) {
    fail("prompt input is invalid");
  }
  const role = ResearchBranchRoleSchema.parse(rawInput.role);
  const input = Object.freeze({
    work_bucket: rawInput.work_bucket,
    navigation: rawInput.navigation,
    evidence_resolver: rawInput.evidence_resolver,
    residency_template: rawInput.residency_template,
    model_policy: rawInput.model_policy,
    trusted_parameters: rawInput.trusted_parameters,
    request_timeout_ms: rawInput.request_timeout_ms,
  });
  const manifest_service: ResearchModelPromptCompilerDependencies["manifest_service"] =
    createResearchReferenceManifestService({
      navigation: input.navigation,
      resolver: input.evidence_resolver,
      store: createResearchBranchRoleManifestStore({
        work_bucket: input.work_bucket,
        navigation: input.navigation,
        residency_template: input.residency_template,
      }),
    });
  const build_manifest_input = async (
    rawModelInput: ModelCallInput,
    rawDeployment: ModelRouteDeployment,
  ): Promise<BuildReferenceManifestInput> => {
    await input.navigation.current();
    if (typeof rawModelInput !== "object" || rawModelInput === null ||
        typeof rawModelInput.evidence_pack !== "object" || rawModelInput.evidence_pack === null ||
        typeof rawModelInput.evidence_pack.pack_ref !== "object" || rawModelInput.evidence_pack.pack_ref === null) {
      fail("branch role model call input is invalid");
    }
    if (typeof rawDeployment !== "object" || rawDeployment === null ||
        typeof rawDeployment.route_ref !== "string" || rawDeployment.route_ref.length === 0) {
      fail("branch role model deployment is invalid");
    }
    const pack = rawModelInput.evidence_pack;
    return Object.freeze({
      evidence_pack: pack,
      navigation: input.navigation,
      resolver: input.evidence_resolver,
      policy: input.model_policy,
      manifest_ref: await deriveBranchRoleManifestRef(pack, role),
      model_route_ref: rawDeployment.route_ref,
      max_context_bytes: rawModelInput.max_input_bytes,
    });
  };
  return Object.freeze({
    role,
    manifest_service,
    build_manifest_input,
    trusted_parameters: input.trusted_parameters,
    request_timeout_ms: input.request_timeout_ms,
  });
}
