import type {
  BundlePromotionAuthorization,
  IngestAdmissionAuthority,
  R2StagedBundleDependencies,
  StagedBundlePort,
} from "@eliotr/platform-cloudflare";
import type { SourceAdmissionService } from "./source-admission-service.js";
import {
  createIngestActorService,
  IngestServiceError,
  type IngestActor,
} from "./ingest-service.js";
import type {
  RawCaptureWorkflowOwnerAuthoritySnapshot,
  RawCaptureWorkflowPrincipal,
} from "./raw-capture-workflow-owner-service.js";
import type { RawNormalizedAdmissionBundlePort } from "./raw-normalized-admission-service.js";

export interface IngestWorkflowOwnerAuthorityReadback
  extends Omit<RawCaptureWorkflowOwnerAuthoritySnapshot, "workflow_state"> {
  readonly workflow_state: string;
}

export interface IngestWorkflowOwnerAuthorityInput {
  readonly operation_id: string;
  readonly principal: RawCaptureWorkflowPrincipal;
  /**
   * Must read canonical authority for this exact Workflow operation, principal,
   * credential generation, and deployment generation. No supplied context or
   * locally reconstructed object is an authority substitute.
   */
  readonly read_current_authority: (
    operationId: string,
    principal: Omit<RawCaptureWorkflowPrincipal, "signal">,
  ) => Promise<IngestWorkflowOwnerAuthorityReadback>;
}

export type IngestWorkflowStagedBundleOptions = Pick<
  R2StagedBundleDependencies,
  "require_current" | "authorize_promotion"
>;

/** Trusted Core ports; policy and promotion authority remain injected existing owners. */
export interface IngestWorkflowOwnerDependencies {
  readonly authority: IngestAdmissionAuthority;
  readonly create_staged_bundles: (
    options: IngestWorkflowStagedBundleOptions,
  ) => StagedBundlePort;
  readonly authorize_promotion: (
    authority: IngestAdmissionAuthority,
    input: BundlePromotionAuthorization,
    admissionReceiptRef: string,
  ) => Promise<boolean>;
  readonly admission: SourceAdmissionService;
  readonly now?: () => number;
}

export interface IngestWorkflowOwnerServiceInput extends IngestWorkflowOwnerAuthorityInput {
  readonly dependencies: IngestWorkflowOwnerDependencies;
}

async function aroundCurrent<T>(
  assertCurrent: () => Promise<void>,
  effect: () => Promise<T>,
): Promise<T> {
  await assertCurrent();
  const result = await effect();
  await assertCurrent();
  return result;
}

function requireCurrentCalls<T extends object>(
  port: T,
  assertCurrent: () => Promise<void>,
): T {
  return new Proxy(port, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => aroundCurrent(assertCurrent, async () =>
        await Reflect.apply(value, target, args));
    },
  });
}

/** Bind the existing ingest engine to one active owner Workflow actor. */
export function createIngestWorkflowOwnerService(
  input: IngestWorkflowOwnerServiceInput,
): RawNormalizedAdmissionBundlePort {
  const actor: IngestActor = {
    principal_ref: input.principal.principal_ref,
    credential_generation: input.principal.credential_generation,
  };

  const assertCurrent = async (): Promise<void> => {
    input.principal.signal?.throwIfAborted();
    const current = await input.read_current_authority(input.operation_id, {
      principal_ref: input.principal.principal_ref,
      credential_generation: input.principal.credential_generation,
      deployment_generation: input.principal.deployment_generation,
    });
    input.principal.signal?.throwIfAborted();
    if (
      current.workflow_state !== "ACTIVE" ||
      current.client_class !== "owner_pwa" ||
      current.principal_ref !== input.principal.principal_ref ||
      current.credential_generation !== input.principal.credential_generation
    ) {
      throw new IngestServiceError(
        "INGEST_PRINCIPAL_DENIED",
        403,
        "bundle admission requires current owner Workflow authority",
      );
    }
  };

  const authority = requireCurrentCalls(input.dependencies.authority, assertCurrent);
  const staging = input.dependencies.create_staged_bundles({
    require_current: assertCurrent,
    authorize_promotion: async (promotion, receiptRef) => aroundCurrent(
      assertCurrent,
      () => input.dependencies.authorize_promotion(authority, promotion, receiptRef),
    ),
  });
  const stagedBundles = requireCurrentCalls(staging, assertCurrent);
  const admission = requireCurrentCalls(input.dependencies.admission, assertCurrent);
  const engine = createIngestActorService({
    authority,
    stagedBundles,
    admission,
    ...(input.dependencies.now === undefined ? {} : { now: input.dependencies.now }),
  });

  return {
    getBundleRecovery: (operationId) => aroundCurrent(
      assertCurrent,
      () => engine.getBundleRecovery(actor, operationId),
    ),
    prepareBundle: (request) => aroundCurrent(
      assertCurrent,
      () => engine.prepareBundle(actor, request),
    ),
    uploadBundlePart: (request) => aroundCurrent(
      assertCurrent,
      () => engine.uploadBundlePart(actor, request),
    ),
    completeBundleFile: (request) => aroundCurrent(
      assertCurrent,
      () => engine.completeBundleFile(actor, request),
    ),
    commitBundle: (request) => aroundCurrent(
      assertCurrent,
      () => engine.commitBundle(actor, request),
    ),
    getBundleStatus: (operationId) => aroundCurrent(
      assertCurrent,
      () => engine.getBundleStatus(actor, operationId),
    ),
  };
}
