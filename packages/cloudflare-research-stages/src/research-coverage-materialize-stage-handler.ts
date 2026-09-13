import {
  createEvidenceFreezeMaterializeContextReader,
  createResearchReportMaterializeStageHandler,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeMaterializeContext,
  type EvidenceFreezeMaterializeContextReader,
  type EvidenceFreezeSynthesisReaderEnvironment,
  type ResearchReportMaterializeStageDependencies,
} from "@eliotr/cloudflare-research";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  canonicalEvidenceJson,
  evidenceSha256Bytes,
} from "@eliotr/cloudflare-evidence";
import {
  fail,
  readCommittedStageLineage,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import { decodeResearchCoverageResult, type ResearchCoverageResult } from "./research-coverage-result.js";

const COVERAGE_STAGE = "CALCULATE_COVERAGE" as const;
const CITATIONS_STAGE = "RESOLVE_CITATIONS" as const;

/** REPORT materialization with a mandatory server-owned Stage16 readback. */
export type ResearchCoverageMaterializeStageDependencies = Omit<
  ResearchReportMaterializeStageDependencies,
  "context" | "read_coverage_receipt"
> & {
  readonly context: EvidenceFreezeMaterializeContextReader;
};

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameManifest(
  left: StageRequest["input_manifest"],
  right: StageRequest["input_manifest"],
): boolean {
  return canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

function corrupt(): never {
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}

function requireCoverageLineage(
  request: StageRequest,
  principal: WorkflowPrincipal,
  context: EvidenceFreezeMaterializeContext,
  result: ResearchCoverageResult,
  stageSixteenRequest: StageRequest,
  stageSixteenReceipt: EvidenceFreezeMaterializeContext["stage_sixteen_receipt"],
  stageFifteen: Awaited<ReturnType<typeof readCommittedStageLineage>>,
): void {
  if (request.stage !== "MATERIALIZE" || stageSixteenRequest.stage !== COVERAGE_STAGE ||
      stageSixteenReceipt.stage !== COVERAGE_STAGE ||
      stageSixteenRequest.operation_id !== request.operation_id ||
      result.operation_id !== request.operation_id || result.operation_id !== context.operation_id ||
      result.investigation_ref.id !== stageSixteenRequest.investigation_ref.id ||
      result.investigation_ref.revision !== stageSixteenRequest.investigation_ref.revision ||
      stageSixteenRequest.investigation_ref.revision + 1 !== request.investigation_ref.revision ||
      result.stage_attempt_ref !== context.stage_sixteen_attempt_ref ||
      result.stage_request_sha256 !== context.stage_sixteen_request_sha256 ||
      context.stage_sixteen_attempt_ref !== stageSixteenReceipt.attempt_ref ||
      context.stage_sixteen_request_sha256 !== stageSixteenReceipt.request_sha256 ||
      stageSixteenReceipt.operation_id !== request.operation_id ||
      stageSixteenReceipt.investigation_ref.id !== request.investigation_ref.id ||
      stageSixteenReceipt.investigation_ref.revision !== request.investigation_ref.revision ||
      stageSixteenReceipt.input_manifest_ref !== stageSixteenRequest.input_manifest.object_ref ||
      !sameManifest(stageSixteenReceipt.output_manifest, request.input_manifest) ||
      !sameRef(result.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(result.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(result.manifest_ref, context.manifest.manifest_ref) ||
      !sameRef(result.evidence_pack_ref, context.stage_five.evidence_pack.pack_ref) ||
      !sameRef(result.coverage_receipt.coverage_denominator_ref, context.freeze.coverage_denominator_ref) ||
      context.stage_five.operation_id !== request.operation_id ||
      context.stage_five.investigation_ref.id !== request.investigation_ref.id ||
      context.stage_five.principal_ref !== principal.principal_ref ||
      !sameRef(context.stage_five.scope_snapshot_ref, context.freeze.scope_snapshot_ref)) {
    corrupt();
  }

  const citations = result.stage_fifteen;
  if (stageFifteen.request.stage !== CITATIONS_STAGE || stageFifteen.receipt.stage !== CITATIONS_STAGE ||
      stageFifteen.request.operation_id !== request.operation_id ||
      citations.operation_id !== stageFifteen.request.operation_id ||
      !sameRef(citations.investigation_ref, stageFifteen.request.investigation_ref) ||
      citations.stage_attempt_ref !== stageFifteen.attempt_ref ||
      citations.stage_request_sha256 !== stageFifteen.request_sha256 ||
      stageFifteen.receipt.attempt_ref !== stageFifteen.attempt_ref ||
      stageFifteen.receipt.request_sha256 !== stageFifteen.request_sha256 ||
      stageFifteen.receipt.input_manifest_ref !== stageFifteen.request.input_manifest.object_ref ||
      stageFifteen.receipt.investigation_ref.id !== stageSixteenRequest.investigation_ref.id ||
      stageFifteen.receipt.investigation_ref.revision !== stageSixteenRequest.investigation_ref.revision ||
      !sameManifest(stageFifteen.receipt.output_manifest, stageSixteenRequest.input_manifest) ||
      citations.output_sha256 !== stageFifteen.receipt.output_manifest.sha256) {
    corrupt();
  }
}

async function readCoverageReceipt(input: {
  readonly database: D1Database;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly context: EvidenceFreezeMaterializeContext;
  readonly input_bytes: Uint8Array;
}): Promise<ResearchCoverageResult["coverage_receipt"]> {
  let result: ResearchCoverageResult;
  try {
    result = await decodeResearchCoverageResult(new Uint8Array(input.input_bytes));
  } catch {
    corrupt();
  }

  const stageSixteenRequest = input.context.stage_sixteen_request;
  const stageSixteenReceipt = input.context.stage_sixteen_receipt;
  let stageFifteen: Awaited<ReturnType<typeof readCommittedStageLineage>>;
  try {
    stageFifteen = await readCommittedStageLineage(
      new WorkflowCheckpointStore(input.database),
      input.request.operation_id,
      CITATIONS_STAGE,
    );
  } catch {
    corrupt();
  }
  requireCoverageLineage(
    input.request,
    input.principal,
    input.context,
    result,
    stageSixteenRequest,
    stageSixteenReceipt,
    stageFifteen,
  );
  if (stageSixteenReceipt.output_manifest.sha256 !== await evidenceSha256Bytes(input.input_bytes) ||
      stageSixteenReceipt.output_manifest.sha256 !== input.request.input_manifest.sha256) {
    corrupt();
  }
  return result.coverage_receipt;
}

/**
 * Compose the existing REPORT admission/materializer with the committed
 * Stage16 coverage result carried by the MATERIALIZE input object.
 */
export function createResearchCoverageMaterializeStageHandler(
  dependencies: ResearchCoverageMaterializeStageDependencies,
): WorkflowStageHandler {
  const handler = createResearchReportMaterializeStageHandler({
    ...dependencies,
    read_coverage_receipt: (input) => readCoverageReceipt({
      database: dependencies.database,
      request: input.request,
      principal: input.principal,
      context: input.context,
      input_bytes: input.input_bytes,
    }),
  });
  return handler;
}

/** Compose the handler with the canonical frozen MATERIALIZE context reader. */
export function createResearchCoverageMaterializeStageHandlerFromFreeze(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
  dependencies: Omit<ResearchCoverageMaterializeStageDependencies, "context" | "navigation">,
): WorkflowStageHandler {
  return createResearchCoverageMaterializeStageHandler({
    ...dependencies,
    navigation,
    context: createEvidenceFreezeMaterializeContextReader(environment, navigation, readers),
  });
}
