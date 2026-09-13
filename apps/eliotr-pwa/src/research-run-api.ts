import { ArtifactRevisionSchema, IdentifierSchema, ScopeExpressionSchema, Sha256Schema, VersionedRefSchema, type ArtifactRevision, type VersionedRef } from "@eliotr/contracts";
import { ApiRequestError, requestApi, requestApiBytes } from "./api.js";

export interface ResearchRunLaunchView {
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly workflow_instance_id: string;
  readonly deployment_generation: string;
}

export interface ResearchRunStatusView {
  readonly workflow_instance_id: string;
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly execution_state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  readonly next_stage_index: number;
  readonly answer:
    | { readonly availability: "unavailable" }
    | { readonly availability: "draft"; readonly artifact_ref: { readonly id: string; readonly revision: number } };
  readonly cancellation_receipt_ref?: string;
  readonly deployment_generation: string;
}

export interface ResearchRunHistoryEntry {
  readonly created_at: string;
  readonly status: ResearchRunStatusView;
}

export interface ResearchRunHistoryView {
  readonly protocol: "eliotr.research-runs.v1";
  readonly runs: readonly ResearchRunHistoryEntry[];
  readonly configuration_state: "INSTALLED" | "MISSING";
  readonly checked_at: string;
  readonly deployment_generation: string;
}

export interface ResearchArtifactSectionView {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly body_sha256: string;
  readonly size_bytes: number;
  readonly bytes: Uint8Array;
}

export interface ResearchArtifactSectionCitation {
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
}

export type ResearchArtifactSectionCitationAuditDisposition =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "CONTRADICTED"
  | "NOT_VERIFIABLE_IN_SCOPE";

export interface ResearchArtifactSectionCitationAuditClaim {
  readonly claim_ref: VersionedRef;
  readonly claim_text: string;
  readonly claim_text_digest: string;
  readonly disposition: ResearchArtifactSectionCitationAuditDisposition;
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
}

export interface ResearchArtifactSectionCitationAudit {
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly output_sha256: string;
  readonly synthesis_output_sha256: string;
  readonly normalization_binding_sha256: string;
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly model_receipt_ref: string;
  readonly claims: readonly ResearchArtifactSectionCitationAuditClaim[];
}

interface ResearchArtifactSectionCitationsBase {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly verification_receipt_ref: string;
  readonly cited_evidence: readonly ResearchArtifactSectionCitation[];
}

export interface ResearchArtifactSectionCitationsNotExecuted extends ResearchArtifactSectionCitationsBase {
  readonly protocol: "eliotr.artifact-section-citations.v1";
  readonly semantic_verification: "NOT_EXECUTED";
}

export interface ResearchArtifactSectionCitationsExecuted extends ResearchArtifactSectionCitationsBase {
  readonly protocol: "eliotr.artifact-section-citations.v2";
  readonly semantic_verification: "EXECUTED";
  readonly audit: ResearchArtifactSectionCitationAudit;
}

export interface ResearchArtifactSectionCitationsNotExecutedView extends ResearchArtifactSectionCitationsNotExecuted {
  readonly deployment_generation: string;
}

export interface ResearchArtifactSectionCitationsExecutedView extends ResearchArtifactSectionCitationsExecuted {
  readonly deployment_generation: string;
}

export type ResearchArtifactSectionCitationsView =
  | ResearchArtifactSectionCitationsNotExecutedView
  | ResearchArtifactSectionCitationsExecutedView;

const MAX_RESULTS = 16;
const MAX_WORKFLOW_STAGE_INDEX = 18;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function invalid(message = "Research run response is invalid; try again"): never {
  throw new ApiRequestError({ status: 502, code: "RESEARCH_RUN_RESPONSE_INVALID", message });
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const object = objectRecord(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !allowed.has(key))) invalid();
  return object;
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) invalid(`${label} is invalid`);
  return timestamp;
}

function identifier(value: unknown, label: string): string {
  try { return IdentifierSchema.parse(value); } catch { invalid(`${label} is invalid`); }
}

function versionedRef(value: unknown, label: string): { readonly id: string; readonly revision: number } {
  try { return VersionedRefSchema.parse(value); } catch { invalid(`${label} is invalid`); }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function envelope(value: unknown): { readonly data: Record<string, unknown>; readonly deployment_generation: string } {
  const outer = record(value, ["data", "trace_id", "deployment_generation"]);
  const trace = boundedString(outer.trace_id, "trace_id", 128);
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  return { data: objectRecord(outer.data), deployment_generation: identifier(outer.deployment_generation, "deployment_generation") };
}

function checkGeneration(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new ApiRequestError({ status: 409, code: "RESEARCH_RUN_DEPLOYMENT_CHANGED", message: "Application changed; refresh the Research run", retryable: true });
  }
}

function checkWorkflowId(value: unknown): string {
  const id = identifier(value, "workflow_instance_id");
  if (!SAFE_IDENTIFIER.test(id)) invalid("workflow_instance_id is invalid");
  return id;
}

const AUDIT_DISPOSITIONS: readonly ResearchArtifactSectionCitationAuditDisposition[] = [
  "SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "NOT_VERIFIABLE_IN_SCOPE",
];
const MAX_AUDIT_CLAIMS = 512;
const MAX_AUDIT_REFS = 512;

function sha256Digest(value: unknown, label: string): string {
  const digest = boundedString(value, label, 64);
  if (!Sha256Schema.safeParse(digest).success) invalid(`${label} is invalid`);
  return digest;
}

function claimText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16_384) invalid(`${label} is invalid`);
  return value;
}

function auditDisposition(value: unknown, label: string): ResearchArtifactSectionCitationAuditDisposition {
  if (typeof value !== "string" || !AUDIT_DISPOSITIONS.includes(value as ResearchArtifactSectionCitationAuditDisposition)) invalid(`${label} is invalid`);
  return value as ResearchArtifactSectionCitationAuditDisposition;
}

function versionedRefList(value: unknown, label: string): VersionedRef[] {
  if (!Array.isArray(value) || value.length > MAX_AUDIT_REFS) invalid(`${label} is invalid`);
  const refs = value.map((item, index) => versionedRef(item, `${label}[${index}]`));
  if (new Set(refs.map((ref) => `${ref.id}:${ref.revision}`)).size !== refs.length) invalid(`${label} contains duplicate references`);
  return refs;
}

function decodeCitationAuditClaim(value: unknown, index: number): ResearchArtifactSectionCitationAuditClaim {
  const claim = record(value, ["claim_ref", "claim_text", "claim_text_digest", "disposition", "support_handle_refs", "counterevidence_handle_refs"]);
  const support = versionedRefList(claim.support_handle_refs, `audit.claims[${index}].support_handle_refs`);
  const counter = versionedRefList(claim.counterevidence_handle_refs, `audit.claims[${index}].counterevidence_handle_refs`);
  const allRefs = [...support, ...counter];
  if (new Set(allRefs.map((ref) => `${ref.id}:${ref.revision}`)).size !== allRefs.length) invalid(`audit.claims[${index}] contains duplicate evidence references`);
  return {
    claim_ref: versionedRef(claim.claim_ref, `audit.claims[${index}].claim_ref`),
    claim_text: claimText(claim.claim_text, `audit.claims[${index}].claim_text`),
    claim_text_digest: sha256Digest(claim.claim_text_digest, `audit.claims[${index}].claim_text_digest`),
    disposition: auditDisposition(claim.disposition, `audit.claims[${index}].disposition`),
    support_handle_refs: support,
    counterevidence_handle_refs: counter,
  };
}

function decodeCitationAudit(value: unknown): ResearchArtifactSectionCitationAudit {
  const audit = record(value, ["stage_attempt_ref", "stage_request_sha256", "output_sha256", "synthesis_output_sha256", "normalization_binding_sha256", "verifier_ref", "verifier_schema_generation", "model_receipt_ref", "claims"]);
  if (!Array.isArray(audit.claims) || audit.claims.length < 1 || audit.claims.length > MAX_AUDIT_CLAIMS) invalid("audit claims are invalid");
  const claims = audit.claims.map((claim, index) => decodeCitationAuditClaim(claim, index));
  if (new Set(claims.map((claim) => `${claim.claim_ref.id}:${claim.claim_ref.revision}`)).size !== claims.length) invalid("audit claims contain duplicate references");
  return {
    stage_attempt_ref: identifier(audit.stage_attempt_ref, "audit.stage_attempt_ref"),
    stage_request_sha256: sha256Digest(audit.stage_request_sha256, "audit.stage_request_sha256"),
    output_sha256: sha256Digest(audit.output_sha256, "audit.output_sha256"),
    synthesis_output_sha256: sha256Digest(audit.synthesis_output_sha256, "audit.synthesis_output_sha256"),
    normalization_binding_sha256: sha256Digest(audit.normalization_binding_sha256, "audit.normalization_binding_sha256"),
    verifier_ref: identifier(audit.verifier_ref, "audit.verifier_ref"),
    verifier_schema_generation: identifier(audit.verifier_schema_generation, "audit.verifier_schema_generation"),
    model_receipt_ref: identifier(audit.model_receipt_ref, "audit.model_receipt_ref"),
    claims,
  };
}

function artifactRevision(value: unknown): ArtifactRevision {
  try { return ArtifactRevisionSchema.parse(value); }
  catch { invalid("research artifact response is invalid"); }
}

function header(headers: Headers, name: string, label: string): string {
  const value = headers.get(name);
  if (value === null || value.length === 0 || value !== value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} header is invalid`);
  return value;
}

function decodedHeader(headers: Headers, name: string, label: string): string {
  try { return decodeURIComponent(header(headers, name, label)); }
  catch { invalid(`${label} header is invalid`); }
}

function headerRef(headers: Headers, name: string, label: string): VersionedRef {
  const value = decodedHeader(headers, name, label);
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || !/^[1-9][0-9]*$/u.test(value.slice(separator + 1))) invalid(`${label} header is invalid`);
  return versionedRef({ id: value.slice(0, separator), revision: Number(value.slice(separator + 1)) }, label);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", owned))].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export function researchRunBody(query: string, sourceIds: readonly string[], maxResults = MAX_RESULTS): string {
  if (typeof query !== "string" || query.trim().length === 0 || new TextEncoder().encode(query).byteLength > 1024 || /[\u0000-\u001f\u007f]/u.test(query)) invalid("query is invalid");
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) invalid("max_results is invalid");
  if (sourceIds.length > 64 || new Set(sourceIds).size !== sourceIds.length) invalid("source scope is invalid");
  for (const sourceId of sourceIds) identifier(sourceId, "source id");
  const scope = sourceIds.length ? { kind: "SELECTED_SOURCES" as const, source_ids: [...sourceIds] } : { kind: "GLOBAL_LIBRARY" as const };
  if (!ScopeExpressionSchema.safeParse(scope).success) invalid("source scope is invalid");
  return JSON.stringify({ query, product: "RESEARCH", scope_expression: scope, literals: [], evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: maxResults });
}

export function decodeResearchRunLaunch(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunLaunchView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["investigation_ref", "workflow_instance_id"]);
  return { investigation_ref: versionedRef(data.investigation_ref, "investigation_ref"), workflow_instance_id: checkWorkflowId(data.workflow_instance_id), deployment_generation: parsed.deployment_generation };
}

export function decodeResearchRunStatus(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunStatusView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["protocol", "workflow_instance_id", "investigation_ref", "execution_state", "next_stage_index", "answer"], ["cancellation_receipt_ref"]);
  if (data.protocol !== "eliotr.research-run-status.v1") invalid("research run protocol is invalid");
  const state = data.execution_state;
  if (state !== "ACTIVE" && state !== "CANCELLED" && state !== "ENGINE_COMPLETED") invalid("research run state is invalid");
  if (!Number.isSafeInteger(data.next_stage_index) || (data.next_stage_index as number) < 0 || (data.next_stage_index as number) > MAX_WORKFLOW_STAGE_INDEX) invalid("research run stage index is invalid");
  const workflowId = checkWorkflowId(data.workflow_instance_id);
  const stageIndex = data.next_stage_index as number;
  if ((state === "ENGINE_COMPLETED" && stageIndex !== MAX_WORKFLOW_STAGE_INDEX) || (state === "ACTIVE" && stageIndex >= MAX_WORKFLOW_STAGE_INDEX)) invalid("research run state and stage index do not match");
  const answer = objectRecord(data.answer);
  const answerKeys = Object.keys(answer);
  if (answer.availability === "unavailable") {
    if (answerKeys.length !== 1) invalid("research run answer availability is invalid");
  } else if (answer.availability === "draft") {
    if (answerKeys.length !== 2 || !Object.hasOwn(answer, "artifact_ref") || state !== "ENGINE_COMPLETED") invalid("research run draft answer is invalid");
    versionedRef(answer.artifact_ref, "answer artifact_ref");
  } else invalid("research run answer availability is invalid");
  const cancellation = Object.hasOwn(data, "cancellation_receipt_ref") ? boundedString(data.cancellation_receipt_ref, "cancellation_receipt_ref") : undefined;
  if (state === "CANCELLED" && cancellation !== `workflow-cancelled:${workflowId}`) invalid("cancelled run receipt does not match the workflow");
  if (state !== "CANCELLED" && cancellation !== undefined) invalid("non-cancelled run cannot carry a cancellation receipt");
  return { workflow_instance_id: workflowId, investigation_ref: versionedRef(data.investigation_ref, "investigation_ref"), execution_state: state, next_stage_index: stageIndex, answer: answer.availability === "draft" ? { availability: "draft", artifact_ref: versionedRef(answer.artifact_ref, "answer artifact_ref") } : { availability: "unavailable" }, ...(cancellation === undefined ? {} : { cancellation_receipt_ref: cancellation }), deployment_generation: parsed.deployment_generation };
}

export function decodeResearchRunHistory(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunHistoryView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["protocol", "runs", "configuration_state", "checked_at"]);
  if (data.protocol !== "eliotr.research-runs.v1") invalid("research run history protocol is invalid");
  if (data.configuration_state !== "INSTALLED" && data.configuration_state !== "MISSING") invalid("research run configuration state is invalid");
  const checkedAt = isoTimestamp(data.checked_at, "checked_at");
  if (!Array.isArray(data.runs) || data.runs.length > 8) invalid("research run history is invalid");
  const seen = new Set<string>();
  const runs = data.runs.map((value, index) => {
    const entry = record(value, ["created_at", "status"]);
    const createdAt = isoTimestamp(entry.created_at, `runs[${index}].created_at`);
    const status = decodeResearchRunStatus({ data: entry.status, trace_id: "research-history", deployment_generation: parsed.deployment_generation }, parsed.deployment_generation);
    if (seen.has(status.workflow_instance_id)) invalid("research run history contains a duplicate run");
    seen.add(status.workflow_instance_id);
    return { created_at: createdAt, status };
  });
  return { protocol: "eliotr.research-runs.v1", runs, configuration_state: data.configuration_state, checked_at: checkedAt, deployment_generation: parsed.deployment_generation };
}

export async function readResearchArtifact(artifactRef: { readonly id: string; readonly revision: number }, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ArtifactRevision> {
  const ref = versionedRef(artifactRef, "artifact_ref");
  const raw = await requestApi(`/api/v1/research/artifact/${encodeURIComponent(`${ref.id}:${ref.revision}`)}`, signal ? { signal } : {});
  const parsed = envelope(raw);
  checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const artifact = artifactRevision(parsed.data);
  if (artifact.artifact_ref.id !== ref.id || artifact.artifact_ref.revision !== ref.revision) invalid("research artifact identity does not match the requested ref");
  return artifact;
}

export async function readResearchArtifactSection(
  artifactRef: { readonly id: string; readonly revision: number },
  section: ArtifactRevision["sections"][number],
  signal?: AbortSignal,
): Promise<ResearchArtifactSectionView> {
  const artifact = versionedRef(artifactRef, "artifact_ref");
  const sectionRef = versionedRef(section.section_ref, "section_ref");
  const raw = await requestApiBytes(`/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}/sections/${encodeURIComponent(`${sectionRef.id}:${sectionRef.revision}`)}`, signal, 1024 * 1024);
  const returnedArtifact = headerRef(raw.headers, "x-eliotr-artifact-ref", "artifact");
  const returnedSection = headerRef(raw.headers, "x-eliotr-section-ref", "section");
  const objectRef = decodedHeader(raw.headers, "x-eliotr-section-object-ref", "section object");
  const returnedSha = header(raw.headers, "x-eliotr-section-sha256", "section digest");
  if (!Sha256Schema.safeParse(returnedSha).success) invalid("section digest header is invalid");
  const length = header(raw.headers, "content-length", "content length");
  if (!/^[0-9]+$/u.test(length) || Number(length) !== raw.bytes.byteLength) invalid("section content length does not match the response body");
  if (!sameRef(returnedArtifact, artifact) || !sameRef(returnedSection, sectionRef) || objectRef !== section.body_object_ref || returnedSha !== section.body_sha256) invalid("section response identity does not match the declared section");
  const actualSha = await sha256(raw.bytes);
  if (actualSha !== returnedSha) invalid("section response digest does not match the response body");
  return { artifact_ref: returnedArtifact, section_ref: returnedSection, body_object_ref: objectRef, body_sha256: returnedSha, size_bytes: raw.bytes.byteLength, bytes: raw.bytes };
}

export function decodeResearchArtifactSectionCitations(raw: unknown, expectedArtifact: VersionedRef, expectedSection: VersionedRef, expectedDeploymentGeneration?: string, expectedVerificationReceiptRef?: string): ResearchArtifactSectionCitationsView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["protocol", "artifact_ref", "section_ref", "scope_snapshot_ref", "verification_receipt_ref", "semantic_verification", "cited_evidence"], ["audit"]);
  const artifact = versionedRef(data.artifact_ref, "artifact_ref");
  const section = versionedRef(data.section_ref, "section_ref");
  const scope = versionedRef(data.scope_snapshot_ref, "scope_snapshot_ref");
  if (!sameRef(artifact, expectedArtifact) || !sameRef(section, expectedSection)) invalid("research citation identity does not match the requested section");
  const receipt = boundedString(data.verification_receipt_ref, "verification_receipt_ref");
  if (!IdentifierSchema.safeParse(receipt).success) invalid("verification_receipt_ref is invalid");
  if (expectedVerificationReceiptRef !== undefined && receipt !== expectedVerificationReceiptRef) invalid("research citation receipt does not match the requested section");
  if (!Array.isArray(data.cited_evidence) || data.cited_evidence.length < 1 || data.cited_evidence.length > 512) invalid("cited evidence is invalid");
  const seen = new Set<string>();
  const citedEvidence = data.cited_evidence.map((value, index) => {
    const citation = record(value, ["handle_ref", "excerpt_sha256"]);
    const handle = versionedRef(citation.handle_ref, `cited_evidence[${index}].handle_ref`);
    const digest = sha256Digest(citation.excerpt_sha256, `cited_evidence[${index}].excerpt_sha256`);
    const key = `${handle.id}:${handle.revision}`;
    if (seen.has(key)) invalid("cited evidence contains a duplicate handle");
    seen.add(key);
    return { handle_ref: handle, excerpt_sha256: digest };
  });
  const base = { artifact_ref: artifact, section_ref: section, scope_snapshot_ref: scope, verification_receipt_ref: receipt, cited_evidence: citedEvidence, deployment_generation: parsed.deployment_generation };
  if (data.protocol === "eliotr.artifact-section-citations.v1" && data.semantic_verification === "NOT_EXECUTED" && !Object.hasOwn(data, "audit")) {
    return { ...base, protocol: "eliotr.artifact-section-citations.v1", semantic_verification: "NOT_EXECUTED" };
  }
  if (data.protocol === "eliotr.artifact-section-citations.v2" && data.semantic_verification === "EXECUTED" && Object.hasOwn(data, "audit")) {
    const audit = decodeCitationAudit(data.audit);
    for (const claim of audit.claims) {
      for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
        if (!seen.has(`${ref.id}:${ref.revision}`)) invalid("audit evidence is not present in cited_evidence");
      }
    }
    return { ...base, protocol: "eliotr.artifact-section-citations.v2", semantic_verification: "EXECUTED", audit };
  }
  invalid("research citation protocol is invalid");
}

export async function readResearchArtifactSectionCitations(
  artifactRef: { readonly id: string; readonly revision: number },
  sectionRef: { readonly id: string; readonly revision: number },
  expectedDeploymentGeneration?: string,
  signal?: AbortSignal,
  expectedVerificationReceiptRef?: string,
): Promise<ResearchArtifactSectionCitationsView> {
  const artifact = versionedRef(artifactRef, "artifact_ref");
  const section = versionedRef(sectionRef, "section_ref");
  const path = `/api/v1/research/artifact/${encodeURIComponent(`${artifact.id}:${artifact.revision}`)}/sections/${encodeURIComponent(`${section.id}:${section.revision}`)}/citations`;
  const raw = await requestApi(path, signal ? { signal } : {});
  return decodeResearchArtifactSectionCitations(raw, artifact, section, expectedDeploymentGeneration, expectedVerificationReceiptRef);
}

export async function startResearchRun(body: string, idempotencyKey: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunLaunchView> {
  const raw = await requestApi("/api/v1/research/run", { method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, ...(signal ? { signal } : {}) });
  return decodeResearchRunLaunch(raw, expectedDeploymentGeneration);
}

export async function readResearchRunStatus(workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunStatusView> {
  const id = checkWorkflowId(workflowInstanceId);
  const raw = await requestApi(`/api/v1/research/run/${encodeURIComponent(id)}`, signal ? { signal } : {});
  const view = decodeResearchRunStatus(raw, expectedDeploymentGeneration);
  if (view.workflow_instance_id !== id) invalid("research run identity does not match the requested run");
  return view;
}

export async function readResearchRunHistory(expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunHistoryView> {
  const raw = await requestApi("/api/v1/research/runs", signal ? { signal } : {});
  return decodeResearchRunHistory(raw, expectedDeploymentGeneration);
}
