import { canonicalEvidenceJson, type CloudflareEvidenceResolver, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ReferenceManifestStore } from "@eliotr/policy";
import type { InvestigationLedgerStore, LedgerHead } from "@eliotr/research";
import type { ProtocolScopeCheckpoint } from "./research-protocol-freeze.js";
import { readWorkflowObject } from "@eliotr/cloudflare-workflows";
import { decodeEvidenceFreezeStageInput, type EvidenceFreezeStageInput } from "./research-evidence-freeze.js";
import {
  createResearchModelStageHandler,
  type ResearchModelStageHandlerDependencies,
} from "./research-model-stage-handler.js";
import type { ModelAttemptPreparationContext, GovernedModelAttemptHandler } from "./model-attempt-handler.js";
import type { ModelAttemptReservationInput } from "./model-attempt-types.js";
import { EvidenceFreezeSchema, type AllowedReferenceManifest, type EvidenceFreeze } from "@eliotr/contracts";
import { fail, type StageRequest, type WorkflowPrincipal, type WorkflowStageHandler, type StageReceipt } from "@eliotr/cloudflare-workflows";
import {
  createEvidenceFreezeStageHandler,
  type EvidenceFreezeAuthorityPort,
} from "./research-evidence-freeze.js";
import {
  deriveEvidenceFreezeAuthorityBinding,
  prepareEvidenceFreezeInput,
  type EvidenceFreezeManifestStoreFactory,
  type EvidenceFreezeModelBinding,
  type EvidenceFreezeResidencyTemplate,
  type EvidenceFreezeStageFiveLineage,
} from "./research-evidence-freeze-preparation.js";
import { readFreezeProtocolAndScopeCheckpoint } from "./research-protocol-freeze.js";
<<<<<<< HEAD
import { WorkflowCheckpointStore } from "./store.js";
import { readCommittedStageLineage } from "./research-committed-lineage.js";
=======
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-workflows";
import { readCommittedStageLineage } from "@eliotr/cloudflare-workflows";
>>>>>>> 0c0506e

export interface EvidenceFreezePredecessorReadback {
  readonly stage_zero: ProtocolScopeCheckpoint;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly w1_head: LedgerHead;
  readonly authorization_receipt_ref: string;
}

export interface EvidenceFreezeCommittedReaderInput {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: WorkflowPrincipal;
}

export interface EvidenceFreezeCommittedReaders {
  readonly read_stage_zero: (input: EvidenceFreezeCommittedReaderInput) => Promise<ProtocolScopeCheckpoint>;
  readonly read_stage_five: (input: EvidenceFreezeCommittedReaderInput) => Promise<EvidenceFreezeStageFiveLineage>;
  readonly read_w1_head: (investigation_id: string) => Promise<LedgerHead | null>;
  readonly read_authorization_receipt_ref: (operation_id: string, investigation_id: string, principal: WorkflowPrincipal) => Promise<string | null>;
}

export interface EvidenceFreezeWorkflowReaderEnvironment {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly read_stage_five: (input: EvidenceFreezeCommittedReaderInput) => Promise<EvidenceFreezeStageFiveLineage>;
}

export async function readCommittedProtocolScopeCheckpoint(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
}): Promise<ProtocolScopeCheckpoint> {
  const stored = await new WorkflowCheckpointStore(input.database).readCommittedStageRequest(input.request.operation_id, "FREEZE_PROTOCOL_AND_SCOPE");
  if (stored === null || stored.request.investigation_ref.id !== input.request.investigation_ref.id || stored.request.investigation_ref.revision !== 1) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  return readFreezeProtocolAndScopeCheckpoint({
    request: stored.request, principal: input.principal, database: input.database, bucket: input.bucket,
    navigation: input.navigation, ledger: input.ledger, expected_attempt_ref: stored.attempt_ref,
  });
}

export function createEvidenceFreezeStageFiveLineage(input: {
  readonly checkpoint: Pick<EvidenceFreezeStageFiveLineage, "operation_id" | "investigation_ref" | "principal_ref" | "scope_snapshot_ref" | "protocol_digest" | "denominator_digest" | "retrieval_request_digest" | "evidence_pack">;
  readonly attempt_ref: string;
  readonly request_sha256: string;
}): EvidenceFreezeStageFiveLineage {
  return { ...input.checkpoint, stage_attempt_ref: input.attempt_ref, stage_request_sha256: input.request_sha256 };
}

export function createEvidenceFreezeWorkflowReaders(
  environment: EvidenceFreezeWorkflowReaderEnvironment,
  navigation: NavigationReadAuthority,
  ledger: Pick<InvestigationLedgerStore, "read">,
): EvidenceFreezeCommittedReaders {
  const checkpoints = new WorkflowCheckpointStore(environment.database);
  return {
    async read_stage_zero(input) {
      const stored = await checkpoints.readCommittedStageRequest(input.operation_id, "FREEZE_PROTOCOL_AND_SCOPE");
      if (stored === null || stored.request.investigation_ref.id !== input.investigation_id) fail("WORKFLOW_AUTHORITY_STALE");
      return readFreezeProtocolAndScopeCheckpoint({
        request: stored.request, principal: input.principal, database: environment.database, bucket: environment.work_bucket,
        navigation, ledger, expected_attempt_ref: stored.attempt_ref,
      });
    },
    read_stage_five: environment.read_stage_five,
    async read_w1_head(investigationId) { return checkpoints.head(investigationId); },
    async read_authorization_receipt_ref(operationId, investigationId, principal) {
      const row = await environment.database.prepare(
        "SELECT operation_id, investigation_id, principal_ref, credential_generation, deployment_generation, policy_authority_ref, " +
          "authorization_receipt_ref, scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
      ).bind(operationId).first<{
        operation_id: string; investigation_id: string; principal_ref: string; credential_generation: string; deployment_generation: string;
        policy_authority_ref: string; authorization_receipt_ref: string | null; scope_snapshot_id: string; scope_snapshot_revision: number;
      }>();
      if (row === null || row.operation_id !== operationId || row.investigation_id !== investigationId || row.principal_ref !== principal.principal_ref ||
          row.credential_generation !== principal.credential_generation || row.deployment_generation !== principal.deployment_generation ||
          row.scope_snapshot_id !== navigation.scope.snapshot_id || row.scope_snapshot_revision !== navigation.scope.revision ||
          row.authorization_receipt_ref === null || row.policy_authority_ref !== (await navigation.current()).policy_authority_ref) return null;
      return row.authorization_receipt_ref;
    },
  };
}

export function createEvidenceFreezePredecessorReader(
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
): (request: StageRequest, principal: WorkflowPrincipal) => Promise<EvidenceFreezePredecessorReadback> {
  return async (request, principal) => {
    if (request.stage !== "RECONCILE" && request.stage !== "FREEZE_EVIDENCE") fail("WORKFLOW_INPUT_INVALID");
    if (request.investigation_ref.id.length === 0 || principal.principal_ref.length === 0) fail("WORKFLOW_INPUT_INVALID");
    const before = await navigation.current();
    const readerInput = { operation_id: request.operation_id, investigation_id: request.investigation_ref.id, principal };
    const stageZero = await readers.read_stage_zero(readerInput);
    const stageFive = await readers.read_stage_five(readerInput);
    const head = await readers.read_w1_head(request.investigation_ref.id);
    const authorizationReceiptRef = await readers.read_authorization_receipt_ref(request.operation_id, request.investigation_ref.id, principal);
    if (head === null || authorizationReceiptRef === null || authorizationReceiptRef.length === 0 ||
        stageZero.operation_id !== request.operation_id || stageZero.investigation_ref.id !== request.investigation_ref.id ||
        stageZero.principal_ref !== principal.principal_ref || stageFive.operation_id !== request.operation_id ||
        stageFive.investigation_ref.id !== request.investigation_ref.id || stageFive.principal_ref !== principal.principal_ref ||
        head.investigation_id !== request.investigation_ref.id || head.revision !== request.investigation_ref.revision ||
        navigation.scope.snapshot_id !== stageZero.scope_snapshot_ref.id || navigation.scope.revision !== stageZero.scope_snapshot_ref.revision) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const after = await navigation.current();
    const finalHead = await readers.read_w1_head(request.investigation_ref.id);
    if (canonicalEvidenceJson(before) !== canonicalEvidenceJson(after) || finalHead === null ||
        canonicalEvidenceJson(finalHead) !== canonicalEvidenceJson(head)) fail("WORKFLOW_AUTHORITY_STALE");
    return { stage_zero: stageZero, stage_five: stageFive, w1_head: head, authorization_receipt_ref: authorizationReceiptRef };
  };
}

export interface EvidenceFreezeCompositionDependencies {
  readonly navigation: NavigationReadAuthority;
  readonly resolver: CloudflareEvidenceResolver;
  readonly read_predecessors: (request: StageRequest, principal: WorkflowPrincipal) => Promise<EvidenceFreezePredecessorReadback>;
  readonly resolve_model_binding: (input: { readonly protocol_scope: ProtocolScopeCheckpoint; readonly w1_head: LedgerHead }) => Promise<EvidenceFreezeModelBinding>;
  readonly manifest_store_factory: EvidenceFreezeManifestStoreFactory;
  readonly manifest_residency_template: EvidenceFreezeResidencyTemplate;
  readonly max_context_bytes: number;
  readonly manifest_store: ReferenceManifestStore;
}

export interface EvidenceFreezeComposition { readonly reconcile: WorkflowStageHandler; readonly freeze: WorkflowStageHandler; }

export function createEvidenceFreezeComposition(dependencies: EvidenceFreezeCompositionDependencies): EvidenceFreezeComposition {
  const reconcile: WorkflowStageHandler = async ({ request, principal }) => {
    const predecessor = await dependencies.read_predecessors(request, principal);
    const binding = await dependencies.resolve_model_binding({ protocol_scope: predecessor.stage_zero, w1_head: predecessor.w1_head });
    return (await prepareEvidenceFreezeInput({
      navigation: dependencies.navigation, resolver: dependencies.resolver, stage_zero: predecessor.stage_zero,
      stage_five: predecessor.stage_five, w1_head: predecessor.w1_head, model_binding: binding,
      scope_snapshot_digest: dependencies.navigation.scope.digest, manifest_store: dependencies.manifest_store_factory,
      manifest_residency_template: dependencies.manifest_residency_template,
      authorization_receipt_ref: predecessor.authorization_receipt_ref, max_context_bytes: dependencies.max_context_bytes,
    }, request, principal)).input_bytes;
  };
  const authority: EvidenceFreezeAuthorityPort = {
    async read(input) {
      const predecessor = await dependencies.read_predecessors(input.request, input.principal);
      const binding = await dependencies.resolve_model_binding({ protocol_scope: predecessor.stage_zero, w1_head: predecessor.w1_head });
      return deriveEvidenceFreezeAuthorityBinding({
        stage_zero: predecessor.stage_zero, stage_five: predecessor.stage_five, w1_head: predecessor.w1_head,
        model_binding: binding, scope_snapshot_digest: dependencies.navigation.scope.digest,
        current_investigation_ref: input.request.investigation_ref, stage_input: input.stage_input,
      });
    },
  };
  return Object.freeze({ reconcile, freeze: createEvidenceFreezeStageHandler({
    navigation: dependencies.navigation, manifest_store: dependencies.manifest_store, resolver: dependencies.resolver, authority,
  }) });
}

export interface EvidenceFreezeSynthesisContext {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly current_revision: number;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly authorization_receipt_ref: string;
  readonly stage_ten_input: EvidenceFreezeStageInput;
  readonly stage_ten_request: StageRequest;
  readonly stage_ten_request_sha256: string;
  readonly stage_ten_attempt_ref: string;
  readonly stage_ten_receipt: StageReceipt;
  readonly stage_eleven_request: StageRequest;
  readonly stage_eleven_request_sha256: string;
  readonly stage_eleven_attempt_ref: string;
  readonly stage_eleven_receipt: StageReceipt;
  readonly freeze: EvidenceFreeze;
  readonly manifest: AllowedReferenceManifest;
  readonly stage_five: EvidenceFreezeStageFiveLineage;
  readonly w1_head: LedgerHead;
}

export interface EvidenceFreezeSynthesisContextReader {
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
  }): Promise<EvidenceFreezeSynthesisContext>;
}

export interface EvidenceFreezeSynthesisReaderEnvironment {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly manifest_store: ReferenceManifestStore;
  readonly read_stage_five: (input: EvidenceFreezeCommittedReaderInput) => Promise<EvidenceFreezeStageFiveLineage>;
}

interface EvidenceFreezeSynthesisReaderOptions {
  /** The current head revision to prove after the read, for a later-stage reader. */
  readonly expected_head_revision?: number;
  /** Materialize validates its own committed input through the stage receipt. */
  readonly verify_input_bytes?: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function parseCommittedFreeze(bytes: Uint8Array): EvidenceFreeze {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = EvidenceFreezeSchema.parse(JSON.parse(text));
    if (canonicalEvidenceJson(value) !== text) fail("WORKFLOW_OUTPUT_CORRUPT");
    return value;
  } catch {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
}

function ref(value: { readonly id: string; readonly revision: number }): string {
  return `${value.id}:${value.revision}`;
}

function sortedRefs(values: readonly { readonly id: string; readonly revision: number }[]): readonly string[] {
  return values.map(ref).sort();
}

function evidenceRecords(value: readonly {
  readonly handle_ref: { readonly id: string; readonly revision: number };
  readonly excerpt_sha256?: string;
  readonly digest?: string;
}[]): readonly string[] {
  return value.map((item) => `${ref(item.handle_ref)}:${item.excerpt_sha256 ?? item.digest ?? ""}`).sort();
}

function assertSynthesisLineage(
  request: StageRequest,
  stageTen: { readonly request: StageRequest; readonly attempt_ref: string; readonly request_sha256: string },
  stageTenReceipt: StageReceipt,
  stageEleven: { readonly request: StageRequest; readonly attempt_ref: string; readonly request_sha256: string },
  stageElevenReceipt: StageReceipt,
): void {
  if (request.stage !== "SYNTHESIZE" || stageTen.request.stage !== "RECONCILE" || stageEleven.request.stage !== "FREEZE_EVIDENCE" ||
      request.operation_id !== stageTen.request.operation_id || request.operation_id !== stageEleven.request.operation_id ||
      request.investigation_ref.id !== stageTen.request.investigation_ref.id ||
      request.investigation_ref.id !== stageEleven.request.investigation_ref.id ||
      stageTenReceipt.investigation_ref.id !== request.investigation_ref.id ||
      stageElevenReceipt.investigation_ref.id !== request.investigation_ref.id ||
      stageTenReceipt.investigation_ref.revision !== stageEleven.request.investigation_ref.revision ||
      stageElevenReceipt.investigation_ref.revision !== request.investigation_ref.revision ||
      stageTenReceipt.output_manifest.object_ref !== stageEleven.request.input_manifest.object_ref ||
      stageTenReceipt.output_manifest.sha256 !== stageEleven.request.input_manifest.sha256 ||
      stageElevenReceipt.output_manifest.object_ref !== request.input_manifest.object_ref ||
      stageElevenReceipt.output_manifest.sha256 !== request.input_manifest.sha256 ||
      stageTenReceipt.input_manifest_ref !== stageTen.request.input_manifest.object_ref ||
      stageElevenReceipt.input_manifest_ref !== stageEleven.request.input_manifest.object_ref ||
      stageTenReceipt.attempt_ref !== stageTen.attempt_ref || stageElevenReceipt.attempt_ref !== stageEleven.attempt_ref ||
      stageTenReceipt.request_sha256 !== stageTen.request_sha256 || stageElevenReceipt.request_sha256 !== stageEleven.request_sha256) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
}

function assertSynthesisPreparation(
  prepared: ModelAttemptReservationInput,
  frozen: EvidenceFreezeSynthesisContext,
): void {
  const deployment = frozen.stage_ten_input.model_profile_definition.deployment;
  if (!sameJson(prepared.call.evidence_pack, frozen.stage_five.evidence_pack) ||
      prepared.call.route_ref !== deployment.route_ref ||
      prepared.call.prompt_generation !== deployment.prompt_generation ||
      prepared.call.schema_generation !== deployment.schema_generation ||
      prepared.authority.principal_ref !== frozen.principal_ref ||
      prepared.authority.credential_generation !== frozen.credential_generation ||
      prepared.authority.deployment_generation !== frozen.deployment_generation ||
      !sameJson(prepared.authority.scope_snapshot_ref, frozen.stage_five.scope_snapshot_ref) ||
      prepared.authority.policy_generation !== frozen.w1_head.policy_generation) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
}

function createSynthesisContextReader(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
  options: EvidenceFreezeSynthesisReaderOptions = {},
): EvidenceFreezeSynthesisContextReader {
  const checkpoints = new WorkflowCheckpointStore(environment.database);
  return {
    async read(input): Promise<EvidenceFreezeSynthesisContext> {
      if (input.request.stage !== "SYNTHESIZE") fail("WORKFLOW_INPUT_INVALID");
      const before = await navigation.current();
      if (navigation.access.principal_ref !== input.principal.principal_ref ||
          navigation.access.credential_generation !== input.principal.credential_generation ||
          input.request.input_manifest.residency.scope_domain_id !== navigation.scope.snapshot_id ||
          input.request.input_manifest.residency.access_domain_id !== input.principal.principal_ref) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      const stageTen = await readCommittedStageLineage(checkpoints, input.request.operation_id, "RECONCILE");
      const stageEleven = await readCommittedStageLineage(checkpoints, input.request.operation_id, "FREEZE_EVIDENCE");
      const stageTenReceipt = stageTen.receipt;
      const stageElevenReceipt = stageEleven.receipt;
      assertSynthesisLineage(input.request, stageTen, stageTenReceipt, stageEleven, stageElevenReceipt);
      const authorizationReceiptRef = await readers.read_authorization_receipt_ref(
        input.request.operation_id, input.request.investigation_ref.id, input.principal,
      );
      if (authorizationReceiptRef === null) fail("WORKFLOW_AUTHORITY_STALE");
      const stageZero = await readers.read_stage_zero({ operation_id: input.request.operation_id, investigation_id: input.request.investigation_ref.id, principal: input.principal });
      const predecessorObjects = [stageTen.request.input_manifest, stageTenReceipt.output_manifest,
        stageEleven.request.input_manifest, stageElevenReceipt.output_manifest, input.request.input_manifest];
      if (predecessorObjects.some((object) => object.residency.scope_domain_id !== navigation.scope.snapshot_id ||
          object.residency.access_domain_id !== input.principal.principal_ref)) fail("WORKFLOW_AUTHORITY_STALE");
      const stageTenBytes = await readWorkflowObject(environment.work_bucket, stageTenReceipt.output_manifest, true);
      const stageElevenBytes = await readWorkflowObject(environment.work_bucket, stageElevenReceipt.output_manifest, true);
      if (options.verify_input_bytes !== false && !sameBytes(stageElevenBytes, input.input_bytes)) fail("WORKFLOW_OUTPUT_CORRUPT");
      let stageTenInput: EvidenceFreezeStageInput;
      try { stageTenInput = await decodeEvidenceFreezeStageInput(stageTenBytes); }
      catch { fail("WORKFLOW_OUTPUT_CORRUPT"); }
      const freeze = parseCommittedFreeze(stageElevenBytes);
      const stageFive = await environment.read_stage_five({ operation_id: input.request.operation_id, investigation_id: input.request.investigation_ref.id, principal: input.principal });
      let manifest: AllowedReferenceManifest | null;
      try { manifest = await environment.manifest_store.get(stageTenInput.manifest_ref); }
      catch { fail("WORKFLOW_OUTPUT_UNAVAILABLE"); }
      if (manifest === null) fail("WORKFLOW_OUTPUT_CORRUPT");
      if (stageFive.operation_id !== input.request.operation_id || stageFive.investigation_ref.id !== input.request.investigation_ref.id ||
          stageFive.principal_ref !== input.principal.principal_ref || stageZero === null ||
          stageTenInput.stage_zero_attempt_ref.length === 0 || stageTenInput.stage_five_attempt_ref !== stageFive.stage_attempt_ref ||
          stageTenInput.stage_five_request_sha256 !== stageFive.stage_request_sha256 ||
          stageTenInput.stage_zero_attempt_ref !== stageZero.attempt_ref ||
          !sameJson(stageFive.scope_snapshot_ref, manifest.scope_snapshot_ref) ||
          ref(manifest.manifest_ref) !== ref(stageTenInput.manifest_ref) ||
          ref(freeze.scope_snapshot_ref) !== ref(manifest.scope_snapshot_ref) ||
          ref(freeze.freeze_ref) !== ref(stageTenInput.freeze_ref) ||
          sameJson(sortedRefs(freeze.included_evidence.map((item) => item.handle_ref)), sortedRefs(manifest.allowed_evidence_handle_refs)) === false ||
          !sameJson(stageFive.scope_snapshot_ref, stageZero.scope_snapshot_ref) ||
          !sameJson(stageFive.evidence_pack.scope_snapshot_ref, stageZero.scope_snapshot_ref) ||
          stageTenInput.protocol_digest !== stageZero.protocol_digest ||
          stageTenInput.coverage_denominator_ref.id !== stageZero.coverage_denominator.denominator_ref.id ||
          stageTenInput.coverage_denominator_ref.revision !== stageZero.coverage_denominator.denominator_ref.revision ||
          stageFive.denominator_digest !== stageZero.denominator_digest ||
          !sameJson(stageTenInput.protocol_profile, stageZero.protocol_profile) ||
          !sameJson(evidenceRecords(freeze.included_evidence), evidenceRecords(stageFive.evidence_pack.resolved_evidence.map((item) => ({
            handle_ref: item.handle.handle_ref, excerpt_sha256: item.handle.excerpt_sha256,
          }))))) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      if (stageZero.principal_ref !== input.principal.principal_ref ||
          stageTenInput.stage_zero_attempt_ref.length === 0 ||
          stageTen.request.investigation_ref.id !== stageZero.investigation_ref.id ||
          stageTenInput.model_profile_definition.definition_ref.revision !== 1) fail("WORKFLOW_OUTPUT_CORRUPT");
      const finalAuthorizationReceiptRef = await readers.read_authorization_receipt_ref(
        input.request.operation_id, input.request.investigation_ref.id, input.principal,
      );
      const finalHead = await readers.read_w1_head(input.request.investigation_ref.id);
      const after = await navigation.current();
      if (finalHead === null || !sameJson(before, after) || finalAuthorizationReceiptRef !== authorizationReceiptRef ||
          finalHead.investigation_id !== input.request.investigation_ref.id ||
          finalHead.revision !== (options.expected_head_revision ?? input.request.investigation_ref.revision) ||
          finalHead.principal_ref !== input.principal.principal_ref ||
          finalHead.deployment_generation !== input.principal.deployment_generation ||
          finalHead.scope_snapshot_id !== navigation.scope.snapshot_id ||
          finalHead.scope_snapshot_revision !== navigation.scope.revision ||
          freeze.client_fence_ref !== input.principal.credential_generation) fail("WORKFLOW_AUTHORITY_STALE");
      return Object.freeze({
        operation_id: input.request.operation_id, investigation_id: input.request.investigation_ref.id,
        current_revision: finalHead.revision, principal_ref: input.principal.principal_ref,
        credential_generation: input.principal.credential_generation, deployment_generation: input.principal.deployment_generation,
        authorization_receipt_ref: authorizationReceiptRef,
        stage_ten_input: stageTenInput, stage_ten_request: stageTen.request, stage_ten_request_sha256: stageTen.request_sha256,
        stage_ten_attempt_ref: stageTen.attempt_ref, stage_ten_receipt: stageTenReceipt,
        stage_eleven_request: stageEleven.request, stage_eleven_request_sha256: stageEleven.request_sha256,
        stage_eleven_attempt_ref: stageEleven.attempt_ref, stage_eleven_receipt: stageElevenReceipt,
        freeze, manifest, stage_five: stageFive, w1_head: finalHead,
      });
    },
  };
}

export function createEvidenceFreezeSynthesisContextReader(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
): EvidenceFreezeSynthesisContextReader {
  return createSynthesisContextReader(environment, navigation, readers);
}

export interface EvidenceFreezeVerificationContextReader {
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
  }): Promise<EvidenceFreezeSynthesisContext>;
}

/** Reads the frozen SYNTHESIZE context while pinning currentness to VERIFY. */
export function createEvidenceFreezeVerificationContextReader(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
): EvidenceFreezeVerificationContextReader {
  const checkpoints = new WorkflowCheckpointStore(environment.database);
  return {
    async read(input): Promise<EvidenceFreezeSynthesisContext> {
      if (input.request.stage !== "VERIFY") fail("WORKFLOW_INPUT_INVALID");
      const stageTwelve = await readCommittedStageLineage(checkpoints, input.request.operation_id, "SYNTHESIZE");
      const stageTwelveReceipt = stageTwelve.receipt;
      if (stageTwelve.request.investigation_ref.id !== input.request.investigation_ref.id ||
          stageTwelveReceipt.stage !== "SYNTHESIZE" ||
          stageTwelveReceipt.investigation_ref.id !== input.request.investigation_ref.id ||
          stageTwelveReceipt.investigation_ref.revision !== input.request.investigation_ref.revision ||
          !sameJson(stageTwelveReceipt.output_manifest, input.request.input_manifest)) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      const stageTwelveInput = await readWorkflowObject(environment.work_bucket, stageTwelve.request.input_manifest, true);
      return createSynthesisContextReader(environment, navigation, readers, {
        expected_head_revision: input.request.investigation_ref.revision,
        verify_input_bytes: true,
      }).read({ request: stageTwelve.request, principal: input.principal, input_bytes: stageTwelveInput });
    },
  };
}

export interface EvidenceFreezeMaterializeContext extends EvidenceFreezeSynthesisContext {
  readonly stage_sixteen_request: StageRequest;
  readonly stage_sixteen_request_sha256: string;
  readonly stage_sixteen_attempt_ref: string;
  readonly stage_sixteen_receipt: StageReceipt;
  readonly stage_twelve_request: StageRequest;
  readonly stage_twelve_request_sha256: string;
  readonly stage_twelve_attempt_ref: string;
  readonly stage_twelve_receipt: StageReceipt;
}

export interface EvidenceFreezeMaterializeContextReader {
  read(input: {
    readonly request: StageRequest;
    readonly principal: WorkflowPrincipal;
    readonly input_bytes: Uint8Array;
  }): Promise<EvidenceFreezeMaterializeContext>;
}

export function createEvidenceFreezeMaterializeContextReader(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
): EvidenceFreezeMaterializeContextReader {
  const checkpoints = new WorkflowCheckpointStore(environment.database);
  return {
    async read(input): Promise<EvidenceFreezeMaterializeContext> {
      if (input.request.stage !== "MATERIALIZE") fail("WORKFLOW_INPUT_INVALID");
      const before = await navigation.current();
      if (navigation.access.principal_ref !== input.principal.principal_ref ||
          navigation.access.credential_generation !== input.principal.credential_generation ||
          input.request.input_manifest.residency.scope_domain_id !== navigation.scope.snapshot_id ||
          input.request.input_manifest.residency.access_domain_id !== input.principal.principal_ref) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      const stageTwelve = await readCommittedStageLineage(checkpoints, input.request.operation_id, "SYNTHESIZE");
      const stageTwelveReceipt = stageTwelve.receipt;
      const stageSixteen = await readCommittedStageLineage(checkpoints, input.request.operation_id, "CALCULATE_COVERAGE");
      const stageSixteenReceipt = stageSixteen.receipt;
      if (stageTwelve.request.stage !== "SYNTHESIZE" ||
          stageTwelve.request.operation_id !== input.request.operation_id ||
          stageTwelve.request.investigation_ref.id !== input.request.investigation_ref.id ||
          stageTwelveReceipt.stage !== "SYNTHESIZE" ||
          stageTwelveReceipt.investigation_ref.id !== input.request.investigation_ref.id ||
          stageSixteen.request.stage !== "CALCULATE_COVERAGE" ||
          stageSixteen.request.operation_id !== input.request.operation_id ||
          stageSixteen.request.investigation_ref.id !== input.request.investigation_ref.id ||
          stageSixteenReceipt.stage !== "CALCULATE_COVERAGE" ||
          stageSixteenReceipt.investigation_ref.id !== input.request.investigation_ref.id ||
          stageSixteenReceipt.investigation_ref.revision !== input.request.investigation_ref.revision ||
          !sameJson(stageSixteenReceipt.output_manifest, input.request.input_manifest) ||
          stageTwelveReceipt.input_manifest_ref !== stageTwelve.request.input_manifest.object_ref ||
          stageSixteenReceipt.input_manifest_ref !== stageSixteen.request.input_manifest.object_ref ||
          stageTwelveReceipt.attempt_ref !== stageTwelve.attempt_ref ||
          stageSixteenReceipt.attempt_ref !== stageSixteen.attempt_ref ||
          stageTwelveReceipt.request_sha256 !== stageTwelve.request_sha256 ||
          stageSixteenReceipt.request_sha256 !== stageSixteen.request_sha256) {
        fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      const synthesis = createSynthesisContextReader(environment, navigation, readers, {
        expected_head_revision: input.request.investigation_ref.revision,
        verify_input_bytes: false,
      });
      const context = await synthesis.read({ request: stageTwelve.request, principal: input.principal, input_bytes: new Uint8Array() });
      const after = await navigation.current();
      if (!sameJson(before, after) || context.current_revision !== input.request.investigation_ref.revision) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      return Object.freeze({ ...context, current_revision: input.request.investigation_ref.revision,
        stage_sixteen_request: stageSixteen.request, stage_sixteen_request_sha256: stageSixteen.request_sha256,
        stage_sixteen_attempt_ref: stageSixteen.attempt_ref, stage_sixteen_receipt: stageSixteenReceipt,
        stage_twelve_request: stageTwelve.request, stage_twelve_request_sha256: stageTwelve.request_sha256,
        stage_twelve_attempt_ref: stageTwelve.attempt_ref, stage_twelve_receipt: stageTwelveReceipt });
    },
  };
}

export interface EvidenceFreezeSynthesisModelDependencies extends Omit<ResearchModelStageHandlerDependencies, "prepare"> {
  readonly prepare: (
    input: ModelAttemptPreparationContext,
    frozen: EvidenceFreezeSynthesisContext,
  ) => Promise<ModelAttemptReservationInput>;
}

export function createEvidenceFreezeSynthesisHandler(input: {
  readonly context: EvidenceFreezeSynthesisContextReader;
  readonly model: EvidenceFreezeSynthesisModelDependencies;
}): GovernedModelAttemptHandler {
  return createResearchModelStageHandler({
    ...input.model,
    prepare: async (context) => {
      const frozen = await input.context.read(context);
      const prepared = await input.model.prepare(context, frozen);
      assertSynthesisPreparation(prepared, frozen);
      return prepared;
    },
  });
}
