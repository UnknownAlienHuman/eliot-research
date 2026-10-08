import { EvidenceFreezeSchema, VersionedRefSchema, type EvidenceFreeze, type VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { ArtifactSectionReviseRequestSchema, digest, readWorkflowObject, WorkflowCheckpointStore, readCommittedStageLineage } from "@eliotr/cloudflare-workflows";
import { decodeEvidenceFreezeStageInput } from "./research-evidence-freeze.js";

const MAX_COW_ANCESTORS = 32;
const SHA256 = /^[a-f0-9]{64}$/u;

interface DraftLineageRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly spec_digest: unknown;
  readonly evidence_freeze_id: unknown;
  readonly evidence_freeze_revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly expected_head_revision: unknown;
  readonly principal_ref: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly manifest_sha256: unknown;
}

interface ReportOriginRow {
  readonly operation_id: unknown;
  readonly investigation_id: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly source_revision_refs_json: unknown;
  readonly run_principal_ref: unknown;
  readonly run_credential_generation: unknown;
  readonly run_deployment_generation: unknown;
  readonly run_policy_generation: unknown;
  readonly run_policy_authority_ref: unknown;
  readonly run_authorization_receipt_ref: unknown;
  readonly run_scope_snapshot_id: unknown;
  readonly run_scope_snapshot_revision: unknown;
}

interface HistoricalScopeRow {
  readonly member_source_revision_refs_json: unknown;
  readonly snapshot_digest: unknown;
}

interface CowLinkRow {
  readonly operation_id: unknown;
  readonly report_intent_id: unknown;
  readonly report_intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly parent_revision: unknown;
  readonly section_contract_id: unknown;
  readonly principal_ref: unknown;
  readonly request_json: unknown;
  readonly request_sha256: unknown;
  readonly current_attempt_ref: unknown;
  readonly attempt_ref: unknown;
  readonly attempt_request_json: unknown;
  readonly attempt_request_sha256: unknown;
  readonly attempt_state: unknown;
  readonly output_json: unknown;
  readonly intent_operation_kind: unknown;
  readonly intent_principal_ref: unknown;
  readonly intent_policy_decision_ref: unknown;
}

interface DraftIdentity {
  readonly spec_ref: VersionedRef;
  readonly spec_digest: string;
  readonly freeze_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly principal_ref: string;
}

export interface ArtifactCowHistoricalFreeze {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly artifact_ref: VersionedRef;
  readonly spec_ref: VersionedRef;
  readonly spec_digest: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly source_revision_refs: readonly string[];
  readonly freeze: EvidenceFreeze;
  readonly freeze_sha256: string;
}

function fail(message: string): never {
  throw new Error("ARTIFACT_COW_FREEZE_LINEAGE_INVALID: " + message);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label + " is malformed");
  return value as Record<string, unknown>;
}

function parseRef(id: unknown, revision: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse({ id, revision });
  if (!parsed.success) fail(label + " is malformed");
  return parsed.data;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") fail(label + " is missing");
  try { return record(JSON.parse(value) as unknown, label); }
  catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("ARTIFACT_COW_FREEZE_LINEAGE_INVALID:")) throw cause;
    fail(label + " is malformed JSON");
  }
}

function stringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") fail(label + " is missing");
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { fail(label + " is malformed JSON"); }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0) ||
      new Set(parsed).size !== parsed.length) fail(label + " is not a unique string array");
  return parsed as string[];
}

function sameIdentity(left: DraftIdentity, right: DraftIdentity): boolean {
  return sameRef(left.spec_ref, right.spec_ref) && left.spec_digest === right.spec_digest &&
    sameRef(left.freeze_ref, right.freeze_ref) && sameRef(left.scope_snapshot_ref, right.scope_snapshot_ref) &&
    left.principal_ref === right.principal_ref;
}

async function readDraftLineage(database: D1Database, artifactRef: VersionedRef): Promise<DraftLineageRow> {
  const result = await database.prepare(
    "SELECT a.artifact_id,a.revision,a.spec_digest,a.evidence_freeze_id,a.evidence_freeze_revision," +
      "b.intent_id,b.intent_revision,b.expected_head_revision,b.principal_ref,b.spec_ref_id,b.spec_ref_revision," +
      "b.scope_snapshot_id,b.scope_snapshot_revision,b.manifest_sha256 " +
      "FROM artifact_revision a JOIN artifact_draft_binding b ON (b.artifact_id,b.revision)=(a.artifact_id,a.revision) " +
      "WHERE a.artifact_id=?1 AND a.revision=?2 LIMIT 2",
  ).bind(artifactRef.id, artifactRef.revision).all<DraftLineageRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length !== 1) {
    fail("exact artifact revision does not resolve to one draft binding");
  }
  const row = result.results[0];
  if (row === undefined || row.artifact_id !== artifactRef.id || row.revision !== artifactRef.revision ||
      typeof row.spec_digest !== "string" || !SHA256.test(row.spec_digest) ||
      typeof row.principal_ref !== "string" || typeof row.manifest_sha256 !== "string" || !SHA256.test(row.manifest_sha256)) {
    fail("artifact revision or immutable draft binding is malformed");
  }
  parseRef(row.evidence_freeze_id, row.evidence_freeze_revision, "artifact freeze ref");
  parseRef(row.spec_ref_id, row.spec_ref_revision, "artifact spec ref");
  parseRef(row.scope_snapshot_id, row.scope_snapshot_revision, "artifact scope ref");
  if (typeof row.intent_id !== "string" || !Number.isSafeInteger(row.intent_revision) ||
      (row.intent_revision as number) < 1 ||
      row.expected_head_revision !== null && (!Number.isSafeInteger(row.expected_head_revision) || (row.expected_head_revision as number) < 1)) {
    fail("artifact draft intent binding is malformed");
  }
  return row;
}

function identityFromDraft(row: DraftLineageRow): DraftIdentity {
  return {
    spec_ref: parseRef(row.spec_ref_id, row.spec_ref_revision, "artifact spec ref"),
    spec_digest: String(row.spec_digest),
    freeze_ref: parseRef(row.evidence_freeze_id, row.evidence_freeze_revision, "artifact freeze ref"),
    scope_snapshot_ref: parseRef(row.scope_snapshot_id, row.scope_snapshot_revision, "artifact scope ref"),
    principal_ref: String(row.principal_ref),
  };
}

async function readReportOrigin(
  database: D1Database,
  draft: DraftLineageRow,
): Promise<ReportOriginRow[]> {
  const result = await database.prepare(
    "SELECT ra.operation_id,wr.investigation_id,ra.principal_ref,ra.credential_generation,ra.deployment_generation," +
      "ra.policy_generation,ra.policy_authority_ref,ra.authorization_receipt_ref,ra.scope_snapshot_id," +
      "ra.scope_snapshot_revision,ra.source_revision_refs_json,wr.principal_ref AS run_principal_ref," +
      "wr.credential_generation AS run_credential_generation,wr.deployment_generation AS run_deployment_generation," +
      "wr.policy_generation AS run_policy_generation,wr.policy_authority_ref AS run_policy_authority_ref," +
      "wr.authorization_receipt_ref AS run_authorization_receipt_ref,wr.scope_snapshot_id AS run_scope_snapshot_id," +
      "wr.scope_snapshot_revision AS run_scope_snapshot_revision " +
      "FROM research_report_admission ra JOIN research_workflow_run wr ON wr.operation_id=ra.operation_id " +
      "WHERE ra.intent_id=?1 AND ra.intent_revision=?2 LIMIT 2",
  ).bind(draft.intent_id, draft.intent_revision).all<ReportOriginRow>();
  if (result.success !== true || !Array.isArray(result.results)) fail("REPORT origin query is unavailable");
  return result.results;
}

async function readCowLink(database: D1Database, draft: DraftLineageRow): Promise<CowLinkRow[]> {
  const revision = Number(draft.revision);
  if (revision <= 1) return [];
  const parentRevision = revision - 1;
  const result = await database.prepare(
    "SELECT r.operation_id,r.report_intent_id,r.report_intent_revision,r.artifact_id,r.parent_revision," +
      "r.section_contract_id,r.principal_ref,r.request_json,r.request_sha256,r.current_attempt_ref," +
      "a.attempt_ref,a.request_json AS attempt_request_json,a.request_sha256 AS attempt_request_sha256," +
      "a.state AS attempt_state,a.output_json,i.operation_kind AS intent_operation_kind," +
      "i.principal_ref AS intent_principal_ref,i.policy_decision_ref AS intent_policy_decision_ref " +
      "FROM artifact_section_revise_run r " +
      "JOIN artifact_section_revise_attempt a ON a.operation_id=r.operation_id AND a.attempt_ref=r.current_attempt_ref " +
      "JOIN operation_intent i ON (i.intent_id,i.revision)=(r.report_intent_id,r.report_intent_revision) " +
      "WHERE r.artifact_id=?1 AND r.parent_revision=?2 AND r.state='COMPLETED' AND a.state='COMMITTED' " +
      "AND json_extract(a.output_json,'$.draft.artifact_ref.id')=?1 " +
      "AND json_extract(a.output_json,'$.draft.artifact_ref.revision')=?3 LIMIT 2",
  ).bind(draft.artifact_id, parentRevision, revision).all<CowLinkRow>();
  if (result.success !== true || !Array.isArray(result.results)) fail("COW ancestor query is unavailable");
  return result.results;
}

async function resolveHistoricalOrigin(
  database: D1Database,
  requested: VersionedRef,
  expectedFreezeRef: VersionedRef,
  expectedScopeRef: VersionedRef,
): Promise<{ readonly identity: DraftIdentity; readonly origin: ReportOriginRow; readonly sources: readonly string[] }> {
  let current = requested;
  let identity: DraftIdentity | undefined;
  const visited = new Set<string>();

  for (let depth = 0; depth <= MAX_COW_ANCESTORS; depth += 1) {
    const key = current.id + ":" + current.revision;
    if (visited.has(key)) fail("COW ancestor chain contains a cycle");
    visited.add(key);

    const draft = await readDraftLineage(database, current);
    const expectedHeadRevision = current.revision === 1 ? null : current.revision - 1;
    if (draft.expected_head_revision !== expectedHeadRevision) {
      fail("artifact draft binding does not retain its exact immediate parent revision");
    }
    const currentIdentity = identityFromDraft(draft);
    if (!sameRef(currentIdentity.freeze_ref, expectedFreezeRef)) {
      fail("artifact revision does not retain the exact expected freeze");
    }
    if (identity === undefined) identity = currentIdentity;
    else if (!sameIdentity(identity, currentIdentity)) {
      fail("COW ancestor changed the immutable spec, freeze, scope, or principal identity");
    }
    if (!sameRef(currentIdentity.scope_snapshot_ref, expectedScopeRef)) {
      fail("artifact spec scope differs from the expected historical freeze scope");
    }

    const [reportOrigins, cowLinks] = await Promise.all([
      readReportOrigin(database, draft),
      readCowLink(database, draft),
    ]);
    if (reportOrigins.length > 1 || cowLinks.length > 1 || reportOrigins.length + cowLinks.length > 1) {
      fail("draft intent has ambiguous REPORT or COW ancestry");
    }
    const reportOrigin = reportOrigins[0];
    if (reportOrigin !== undefined) {
      if (cowLinks.length !== 0) fail("draft has both direct REPORT and COW ancestry");
      const scopeRef = currentIdentity.scope_snapshot_ref;
      if (typeof reportOrigin.operation_id !== "string" || typeof reportOrigin.investigation_id !== "string" ||
          typeof reportOrigin.principal_ref !== "string" || reportOrigin.principal_ref !== currentIdentity.principal_ref ||
          reportOrigin.credential_generation !== reportOrigin.run_credential_generation ||
          reportOrigin.deployment_generation !== reportOrigin.run_deployment_generation ||
          reportOrigin.policy_generation !== reportOrigin.run_policy_generation ||
          reportOrigin.policy_authority_ref !== reportOrigin.run_policy_authority_ref ||
          reportOrigin.authorization_receipt_ref !== reportOrigin.run_authorization_receipt_ref ||
          reportOrigin.scope_snapshot_id !== scopeRef.id || reportOrigin.scope_snapshot_revision !== scopeRef.revision ||
          reportOrigin.run_scope_snapshot_id !== scopeRef.id || reportOrigin.run_scope_snapshot_revision !== scopeRef.revision ||
          reportOrigin.run_principal_ref !== currentIdentity.principal_ref) {
        fail("original REPORT admission and workflow authority differ from the exact frozen artifact identity");
      }
      const sourceRefs = stringArray(reportOrigin.source_revision_refs_json, "REPORT source revision identity");
      const scopeResult = await database.prepare(
        "SELECT member_source_revision_refs_json,snapshot_digest FROM scope_snapshot " +
          "WHERE snapshot_id=?1 AND revision=?2 LIMIT 2",
      ).bind(scopeRef.id, scopeRef.revision).all<HistoricalScopeRow>();
      if (scopeResult.success !== true || !Array.isArray(scopeResult.results) || scopeResult.results.length !== 1) {
        fail("original frozen scope does not resolve to one immutable source set");
      }
      const scopeRow = scopeResult.results[0];
      if (scopeRow === undefined || typeof scopeRow.snapshot_digest !== "string") {
        fail("original frozen scope identity is malformed");
      }
      const scopeSources = stringArray(scopeRow.member_source_revision_refs_json, "frozen scope source identity");
      if (canonicalEvidenceJson([...sourceRefs].sort()) !== canonicalEvidenceJson([...scopeSources].sort())) {
        fail("REPORT admission source set differs from its exact frozen scope");
      }
      return { identity: currentIdentity, origin: reportOrigin, sources: Object.freeze([...scopeSources].sort()) };
    }

    const cow = cowLinks[0];
    if (cow === undefined) fail("draft intent has no direct REPORT or committed COW ancestor");
    if (depth === MAX_COW_ANCESTORS) fail("COW ancestor chain exceeds its bounded depth");

    const parentRevision = current.revision - 1;
    if (parentRevision < 1 || cow.artifact_id !== current.id || cow.parent_revision !== parentRevision ||
        cow.principal_ref !== currentIdentity.principal_ref || cow.intent_operation_kind !== "REPORT" ||
        cow.intent_principal_ref !== currentIdentity.principal_ref ||
        typeof cow.intent_policy_decision_ref !== "string" ||
        typeof cow.request_json !== "string" || typeof cow.request_sha256 !== "string" ||
        !SHA256.test(cow.request_sha256) || typeof cow.attempt_ref !== "string" ||
        cow.current_attempt_ref !== cow.attempt_ref || cow.attempt_state !== "COMMITTED" ||
        cow.attempt_request_sha256 !== cow.request_sha256 || typeof cow.output_json !== "string") {
      fail("committed COW link does not bind the exact immediate artifact parent");
    }
    if (await digest(new TextEncoder().encode(cow.request_json)) !== cow.request_sha256) {
      fail("COW request bytes do not match the committed attempt digest");
    }
    let request: ReturnType<typeof ArtifactSectionReviseRequestSchema.parse>;
    try {
      request = ArtifactSectionReviseRequestSchema.parse(JSON.parse(cow.request_json) as unknown);
    } catch {
      fail("committed COW request is malformed");
    }
    if (canonicalEvidenceJson(request) !== cow.request_json ||
        request.operation_id !== cow.operation_id ||
        request.report_intent_ref.id !== cow.report_intent_id ||
        request.report_intent_ref.revision !== cow.report_intent_revision ||
        request.artifact_ref.id !== current.id || request.artifact_ref.revision !== parentRevision ||
        request.spec_digest !== currentIdentity.spec_digest ||
        !sameRef(request.evidence_freeze_ref, currentIdentity.freeze_ref) ||
        request.section_id !== cow.section_contract_id ||
        cow.intent_policy_decision_ref !== request.report_admission_witness.decision_sha256) {
      fail("COW REPORT intent does not bind the exact immutable parent identity");
    }
    const material = request.report_admission_witness.material;
    if (material.principal_ref !== cow.principal_ref || material.spec_digest !== currentIdentity.spec_digest ||
        !sameRef(VersionedRefSchema.parse(material.evidence_freeze_ref), currentIdentity.freeze_ref) ||
        canonicalEvidenceJson(material.scope_snapshot_ref) !== canonicalEvidenceJson(request.scope_snapshot_ref) ||
        record(material.request, "COW admission request").artifact_ref === undefined) {
      fail("COW admission witness does not bind its persisted request and immutable source identity");
    }
    const admittedRequest = record(material.request, "COW admission request");
    const admittedArtifactRef = VersionedRefSchema.safeParse(admittedRequest.artifact_ref);
    if (!admittedArtifactRef.success || !sameRef(admittedArtifactRef.data, request.artifact_ref) ||
        admittedRequest.expected_artifact_revision !== parentRevision ||
        admittedRequest.section_id !== request.section_id ||
        admittedRequest.idempotency_key !== request.idempotency_key) {
      fail("COW admission witness request differs from its exact artifact parent");
    }
    const attemptRequest = jsonObject(cow.attempt_request_json, "COW attempt request");
    if (canonicalEvidenceJson(attemptRequest) !== cow.attempt_request_json ||
        attemptRequest.attempt_ref !== cow.attempt_ref ||
        canonicalEvidenceJson(attemptRequest.request) !== cow.request_json) {
      fail("committed COW attempt does not retain its exact W2 request bytes");
    }
    const output = jsonObject(cow.output_json, "COW committed output");
    const outputDraft = record(output.draft, "COW child draft receipt");
    const outputRef = VersionedRefSchema.safeParse(outputDraft.artifact_ref);
    if (!outputRef.success || !sameRef(outputRef.data, current) ||
        outputDraft.manifest_sha256 !== draft.manifest_sha256) {
      fail("committed COW receipt does not bind the exact child manifest readback");
    }

    current = { id: current.id, revision: parentRevision };
  }
  fail("COW ancestor chain exceeds its bounded depth");
}

/**
 * Reads the immutable freeze from the original REPORT's committed W2 lineage.
 * A COW child is resolved through its committed W2 output to the exact parent
 * revision until the original REPORT binding is reached. Historical credentials
 * remain provenance; callers reauthorize evidence under current owner authority.
 */
export async function readArtifactCowHistoricalFreeze(input: {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly artifact_ref: VersionedRef;
  readonly expected_freeze_ref: VersionedRef;
  readonly expected_scope_snapshot_ref: VersionedRef;
}): Promise<ArtifactCowHistoricalFreeze> {
  const artifactRef = VersionedRefSchema.parse(input.artifact_ref);
  const freezeRef = VersionedRefSchema.parse(input.expected_freeze_ref);
  const scopeRef = VersionedRefSchema.parse(input.expected_scope_snapshot_ref);
  const lineage = await resolveHistoricalOrigin(input.database, artifactRef, freezeRef, scopeRef);
  const row = lineage.origin;
  const checkpoints = new WorkflowCheckpointStore(input.database);
  const [reconcile, frozen] = await Promise.all([
    readCommittedStageLineage(checkpoints, String(row.operation_id), "RECONCILE"),
    readCommittedStageLineage(checkpoints, String(row.operation_id), "FREEZE_EVIDENCE"),
  ]);
  if (reconcile.request.operation_id !== row.operation_id || frozen.request.operation_id !== row.operation_id ||
      reconcile.request.stage !== "RECONCILE" || frozen.request.stage !== "FREEZE_EVIDENCE" ||
      reconcile.request.investigation_ref.id !== row.investigation_id || frozen.request.investigation_ref.id !== row.investigation_id ||
      reconcile.receipt.investigation_ref.id !== row.investigation_id || frozen.receipt.investigation_ref.id !== row.investigation_id ||
      frozen.request.input_manifest.object_ref !== reconcile.receipt.output_manifest.object_ref ||
      frozen.request.input_manifest.sha256 !== reconcile.receipt.output_manifest.sha256 ||
      frozen.receipt.attempt_ref !== frozen.attempt_ref || frozen.receipt.request_sha256 !== frozen.request_sha256) {
    fail("historical RECONCILE and FREEZE_EVIDENCE checkpoints are not contiguous");
  }
  const stageInputBytes = await readWorkflowObject(input.work_bucket, frozen.request.input_manifest, true);
  const stageInput = await decodeEvidenceFreezeStageInput(stageInputBytes);
  if (!sameRef(stageInput.freeze_ref, freezeRef)) {
    fail("historical freeze input does not name the exact artifact freeze");
  }
  const freezeBytes = await readWorkflowObject(input.work_bucket, frozen.receipt.output_manifest, true);
  let freeze: EvidenceFreeze;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(freezeBytes);
    freeze = EvidenceFreezeSchema.parse(JSON.parse(text));
    if (canonicalEvidenceJson(freeze) !== text) fail("historical freeze bytes are not canonical");
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("ARTIFACT_COW_FREEZE_LINEAGE_INVALID:")) throw cause;
    fail("historical EvidenceFreeze object is malformed");
  }
  if (!sameRef(freeze.freeze_ref, freezeRef) || !sameRef(freeze.scope_snapshot_ref, scopeRef) ||
      frozen.receipt.output_manifest.residency.scope_domain_id !== scopeRef.id) {
    fail("historical freeze output differs from the exact artifact freeze or scope");
  }
  return Object.freeze({
    operation_id: String(row.operation_id),
    investigation_ref: frozen.request.investigation_ref,
    artifact_ref: artifactRef,
    spec_ref: lineage.identity.spec_ref,
    spec_digest: lineage.identity.spec_digest,
    scope_snapshot_ref: lineage.identity.scope_snapshot_ref,
    source_revision_refs: lineage.sources,
    freeze,
    freeze_sha256: await digest(freezeBytes),
  });
}
