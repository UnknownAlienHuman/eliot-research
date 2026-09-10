import type { NavigationReadAuthority, CloudflareEvidenceResolver } from "@eliotr/cloudflare-evidence";
import {
  createEvidenceFreezeStageHandler,
  deriveEvidenceFreezeAuthorityBinding,
  type EvidenceFreezeAuthorityPort,
  prepareEvidenceFreezeInput,
  type EvidenceFreezeManifestStoreFactory,
  type EvidenceFreezeModelBinding,
  type EvidenceFreezeResidencyTemplate,
  type EvidenceFreezeStageFiveLineage,
} from "@eliotr/cloudflare-research";
import type { StageRequest, WorkflowPrincipal, WorkflowStageHandler, ProtocolScopeCheckpoint } from "@eliotr/cloudflare-research";
import type { LedgerHead } from "@eliotr/research";
import type { ReferenceManifestStore } from "@eliotr/policy";

export interface EvidenceFreezePredecessorReadback {
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly w1_head: LedgerHead;
  readonly authorization_receipt_ref: string;
}

export interface EvidenceFreezeCompositionDependencies {
  readonly navigation: NavigationReadAuthority;
  readonly resolver: CloudflareEvidenceResolver;
  readonly read_predecessors: (request: StageRequest, principal: WorkflowPrincipal) => Promise<EvidenceFreezePredecessorReadback>;
  readonly resolve_model_binding: (input: {
    readonly protocol_scope: ProtocolScopeCheckpoint;
    readonly w1_head: LedgerHead;
  }) => Promise<EvidenceFreezeModelBinding>;
  readonly manifest_store_factory: EvidenceFreezeManifestStoreFactory;
  readonly manifest_residency_template: EvidenceFreezeResidencyTemplate;
  readonly max_context_bytes: number;
  readonly manifest_store: ReferenceManifestStore;
}

export interface EvidenceFreezeComposition {
  readonly reconcile: WorkflowStageHandler;
  readonly freeze: WorkflowStageHandler;
}

/**
 * Compose stage 10 and stage 11 from trusted W2 readbacks. The caller owns the
 * D1/W2 readers; this module deliberately accepts typed readback values rather
 * than request-shaped profile or evidence data.
 */
export function createEvidenceFreezeComposition(
  dependencies: EvidenceFreezeCompositionDependencies,
): EvidenceFreezeComposition {
  const reconcile: WorkflowStageHandler = async ({ request, principal }) => {
    const predecessor = await dependencies.read_predecessors(request, principal);
    const binding = await dependencies.resolve_model_binding({
      protocol_scope: predecessor.stage_zero,
      w1_head: predecessor.w1_head,
    });
    return (await prepareEvidenceFreezeInput({
      navigation: dependencies.navigation,
      resolver: dependencies.resolver,
      stage_zero: predecessor.stage_zero,
      stage_five: predecessor.stage_five,
      w1_head: predecessor.w1_head,
      model_binding: binding,
      scope_snapshot_digest: dependencies.navigation.scope.digest,
      manifest_store: dependencies.manifest_store_factory,
      manifest_residency_template: dependencies.manifest_residency_template,
      authorization_receipt_ref: predecessor.authorization_receipt_ref,
      max_context_bytes: dependencies.max_context_bytes,
    }, request, principal)).input_bytes;
  };
  const authority = {
    async read(input: Parameters<EvidenceFreezeAuthorityPort["read"]>[0]) {
      const predecessor = await dependencies.read_predecessors(input.request, input.principal);
      const binding = await dependencies.resolve_model_binding({
        protocol_scope: predecessor.stage_zero,
        w1_head: predecessor.w1_head,
      });
      return deriveEvidenceFreezeAuthorityBinding({
        stage_zero: predecessor.stage_zero,
        stage_five: predecessor.stage_five,
        w1_head: predecessor.w1_head,
        model_binding: binding,
        scope_snapshot_digest: dependencies.navigation.scope.digest,
        stage_input: input.stage_input,
      });
    },
  };
  return Object.freeze({
    reconcile,
    freeze: createEvidenceFreezeStageHandler({
      navigation: dependencies.navigation,
      manifest_store: dependencies.manifest_store,
      resolver: dependencies.resolver,
      authority,
    }),
  });
}
