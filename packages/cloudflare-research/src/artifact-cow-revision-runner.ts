import {
  CloudflareArtifactCowAdapter,
  type ArtifactCowPorts,
} from "@eliotr/cloudflare-artifacts";
import type {
  ArtifactSectionReviseAttempt,
  ArtifactSectionReviseWorkflowStore,
} from "@eliotr/cloudflare-workflows";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { ModelAttemptAuthority } from "./model-attempt-types.js";
import type { ResidencyDomainProfile } from "./research-model-output-store.js";
import {
  createArtifactCowSectionProducer,
  type ArtifactCowSectionProducerDependencies,
} from "./artifact-cow-section-producer.js";
import type { ArtifactCowModelCallContext, ArtifactCowModelOutput } from "./artifact-cow-model-executor.js";

export interface RunArtifactCowRevisionInput {
  /** Current owner/source permission, including durable-result replay. */
  readonly requireCurrent: () => Promise<unknown>;
  readonly attempt: ArtifactSectionReviseAttempt;
  readonly principal: WorkflowPrincipal;
  readonly model_authority: ModelAttemptAuthority;
  readonly output_residency_domains: ResidencyDomainProfile;
  readonly model: {
    readonly execute: (context: ArtifactCowModelCallContext) => Promise<ArtifactCowModelOutput>;
  };
  readonly producer: Omit<ArtifactCowSectionProducerDependencies,
    "attempt" | "principal" | "model_authority" | "output_residency_domains" | "execute">;
  readonly workflow: Pick<ArtifactSectionReviseWorkflowStore, "read" | "recordOutput" | "commitReadback">;
  readonly ports: Omit<ArtifactCowPorts, "compileSection" | "prepare"> & {
    /** Deterministic per COW W2 attempt and expected child revision for restart recovery. */
    readonly createIntent: ArtifactCowPorts["createIntent"];
    readonly prepare: ArtifactCowPorts["prepare"];
  };
  readonly now?: () => number;
}

function fail(message: string): never {
  throw new Error(`ARTIFACT_COW_REVISION_RUN_INVALID: ${message}`);
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function outputEqual(
  left: ArtifactSectionReviseAttempt["output"],
  right: NonNullable<ArtifactSectionReviseAttempt["output"]>,
): boolean {
  return left !== undefined && left.output_object_ref === right.output_object_ref &&
    left.output_sha256 === right.output_sha256 && left.output_size_bytes === right.output_size_bytes &&
    left.readback_sha256 === right.readback_sha256;
}

/**
 * Executes the admitted dedicated W2 attempt through both real W3 call slots,
 * the immutable artifact COW DRAFT writer, and the final W2 readback transition.
 * There is deliberately no acceptance transition in this runner.
 */
export async function runArtifactCowRevision(input: RunArtifactCowRevisionInput): Promise<ArtifactSectionReviseAttempt> {
  await input.requireCurrent();
  const initial = await input.workflow.read(input.attempt.request.operation_id);
  if (initial === null || initial.attempt_ref !== input.attempt.attempt_ref || initial.request_sha256 !== input.attempt.request_sha256 ||
      initial.request_json !== input.attempt.request_json || !sameRef(initial.request.artifact_ref, input.attempt.request.artifact_ref)) {
    fail("persisted W2 COW attempt changed before execution");
  }
  if (initial.state === "COMMITTED") {
    await input.requireCurrent();
    return initial;
  }
  if (initial.state !== "STARTED" && initial.state !== "OUTPUT_RECORDED") {
    fail("COW W2 attempt is not effect eligible");
  }

  const sectionProducer = createArtifactCowSectionProducer({
    ...input.producer,
    execute: input.model.execute,
    attempt: initial,
    principal: input.principal,
    model_authority: input.model_authority,
    output_residency_domains: input.output_residency_domains,
  });

  const adapter = new CloudflareArtifactCowAdapter({
    ...input.ports,
    createIntent: input.ports.createIntent,
    compileSection: sectionProducer.compileSection,
    prepare: async (draftInput) => {
      const outputs = sectionProducer.modelOutputs();
      const synthesis = outputs.synthesis;
      const verification = outputs.independent_verification;
      if (synthesis === null || verification === null ||
          synthesis.call_slot !== "SYNTHESIZE" || verification.call_slot !== "INDEPENDENT_VERIFY") {
        fail("section compiler did not durably complete both required model call slots");
      }
      const savedOutput = {
        output_object_ref: synthesis.output.output_object_ref,
        output_sha256: synthesis.output.output_sha256,
        output_size_bytes: synthesis.output.output_size_bytes,
        readback_sha256: synthesis.output.readback_sha256,
      };
      if (initial.state === "STARTED") {
        await input.workflow.recordOutput({
          operation_id: initial.request.operation_id,
          attempt_ref: initial.attempt_ref,
          request_sha256: initial.request_sha256,
          output: savedOutput,
          created_at: new Date((input.now ?? Date.now)()).toISOString(),
        });
      } else if (!outputEqual(initial.output, savedOutput)) {
        fail("replayed model readback differs from the immutable W2 recorded output");
      }
      const prepared = await input.ports.prepare(draftInput);
      if (prepared.artifact_ref.id !== initial.request.artifact_ref.id ||
          prepared.artifact_ref.revision !== initial.request.artifact_ref.revision + 1 ||
          prepared.draft_head_revision < initial.request.artifact_ref.revision + 1 ||
          prepared.manifest.receipt.expected_sha256.length !== 64) {
        fail("artifact DRAFT CAS result differs from the admitted child revision");
      }
      await input.workflow.commitReadback({
        operation_id: initial.request.operation_id,
        attempt_ref: initial.attempt_ref,
        request_sha256: initial.request_sha256,
        draft: { artifact_ref: prepared.artifact_ref, manifest_sha256: prepared.manifest.receipt.expected_sha256 },
        created_at: new Date((input.now ?? Date.now)()).toISOString(),
      });
      return prepared;
    },
  });

  await adapter.reviseSection(
    initial.request.artifact_ref,
    initial.request.section_id,
    initial.request.artifact_ref.revision,
  );
  const updated = await input.workflow.read(initial.request.operation_id);
  if (updated === null || updated.attempt_ref !== initial.attempt_ref || updated.request_sha256 !== initial.request_sha256 ||
      updated.state !== "COMMITTED" || updated.draft === undefined ||
      updated.draft.artifact_ref.id !== initial.request.artifact_ref.id ||
      updated.draft.artifact_ref.revision !== initial.request.artifact_ref.revision + 1) {
    fail("committed DRAFT and final W2 child receipt failed exact readback");
  }
  await input.requireCurrent();
  return updated;
}
