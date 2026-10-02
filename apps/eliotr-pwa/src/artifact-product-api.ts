import { ArtifactRevisionSchema, Sha256Schema, type ArtifactRevision, type VersionedRef } from "@eliotr/contracts";
import { ApiRequestError, requestApi, requestApiWithStatuses } from "./api.js";
import { envelope, record, identifier, versionedRef, sameRef, isoTimestamp, checkGeneration, invalid } from "./research-run-wire.js";

export interface ArtifactPublicationView {
  readonly revision: ArtifactRevision;
  readonly receipt: {
    readonly publication_ref: string; readonly artifact_ref: VersionedRef; readonly publication_revision: number;
    readonly manifest_sha256: string; readonly verification_set_sha256: string; readonly evidence_currentness_sha256: string;
    readonly acceptance_decision_ref: string; readonly acceptance_provenance_ref: string; readonly acceptance_decision_sha256: string;
    readonly principal_ref: string; readonly authorization_receipt_ref: string; readonly created_at: string;
  };
}
export interface ArtifactSectionRevisionView {
  readonly operation_id: string; readonly attempt_ref: string;
  readonly state: "STARTED" | "OUTPUT_RECORDED" | "COMMITTED" | "UNKNOWN" | "CANCELLED";
  readonly draft?: { readonly artifact_ref: VersionedRef; readonly manifest_sha256: string };
}
const basePath = (ref: VersionedRef): string => {
  const parsed = versionedRef(ref, "artifact reference");
  return "/api/v1/research/artifact/" + encodeURIComponent(parsed.id + ":" + parsed.revision);
};
const sha = (value: unknown): string => { const parsed = Sha256Schema.safeParse(value); if (!parsed.success) invalid(); return parsed.data; };
const positive = (value: unknown): number => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(); return value; };
const disposition = (value: unknown): void => { if (value !== "CREATED" && value !== "EXISTING") invalid(); };

/** Stable across reload/retry; an uncertain effect retains the same transport identity. */
async function mutationKey(kind: string, ref: VersionedRef, expected: string | number | null): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind, artifact_ref: versionedRef(ref, "artifact reference"), expected }));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "artifact-" + kind + "-" + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function decodePublication(raw: unknown, ref: VersionedRef, generation: string, mutation: boolean, current: boolean): ArtifactPublicationView {
  const outer = envelope(raw); checkGeneration(outer.deployment_generation, generation);
  const data = record(outer.data, ["protocol", "revision", "receipt", ...(mutation ? ["disposition"] : [])]);
  if (data.protocol !== "eliotr.artifact-publication.v1") invalid();
  if (mutation) disposition(data.disposition);
  const parsed = ArtifactRevisionSchema.safeParse(data.revision); if (!parsed.success) invalid();
  const receipt = record(data.receipt, ["publication_ref", "artifact_ref", "publication_revision", "manifest_sha256",
    "verification_set_sha256", "evidence_currentness_sha256", "acceptance_decision_ref", "acceptance_provenance_ref",
    "acceptance_decision_sha256", "principal_ref", "authorization_receipt_ref", "created_at"]);
  const artifactRef = versionedRef(receipt.artifact_ref, "publication artifact");
  if (!sameRef(artifactRef, parsed.data.artifact_ref) || artifactRef.id !== ref.id ||
      (!current && !sameRef(artifactRef, ref)) || (current && artifactRef.revision > ref.revision)) invalid();
  return { revision: parsed.data, receipt: {
    publication_ref: identifier(receipt.publication_ref, "publication reference"), artifact_ref: artifactRef,
    publication_revision: positive(receipt.publication_revision), manifest_sha256: sha(receipt.manifest_sha256),
    verification_set_sha256: sha(receipt.verification_set_sha256), evidence_currentness_sha256: sha(receipt.evidence_currentness_sha256),
    acceptance_decision_ref: identifier(receipt.acceptance_decision_ref, "acceptance decision"),
    acceptance_provenance_ref: identifier(receipt.acceptance_provenance_ref, "acceptance provenance"),
    acceptance_decision_sha256: sha(receipt.acceptance_decision_sha256), principal_ref: identifier(receipt.principal_ref, "principal"),
    authorization_receipt_ref: identifier(receipt.authorization_receipt_ref, "authorization receipt"),
    created_at: isoTimestamp(receipt.created_at, "publication timestamp"),
  } };
}
export async function readArtifactPublication(ref: VersionedRef, generation: string, signal?: AbortSignal,
  current = false): Promise<ArtifactPublicationView | null> {
  try {
    return decodePublication(await requestApi(basePath(ref) + "/publication" + (current ? "/current" : ""), { ...(signal === undefined ? {} : { signal }) }), ref, generation, false, current);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404 && error.code === "ARTIFACT_PUBLICATION_NOT_FOUND") return null;
    throw error;
  }
}
export async function acceptArtifact(ref: VersionedRef, expectedPublicationRevision: number | null, generation: string,
  signal?: AbortSignal): Promise<ArtifactPublicationView> {
  if (expectedPublicationRevision !== null) positive(expectedPublicationRevision);
  const raw = await requestApiWithStatuses(basePath(ref) + "/accept", {
    method: "POST", ...(signal === undefined ? {} : { signal }), headers: { "content-type": "application/json",
      "idempotency-key": await mutationKey("accept", ref, expectedPublicationRevision) },
    body: JSON.stringify({ protocol: "eliotr.artifact-publication-accept.v1", expected_draft_head_revision: ref.revision,
      expected_publication_revision: expectedPublicationRevision }),
  }, [200, 201]);
  const result = decodePublication(raw, ref, generation, true, false);
  if (result.revision.status !== "ACCEPTED") invalid("Acceptance readback did not confirm ACCEPTED");
  return result;
}
export async function reviseArtifactSection(ref: VersionedRef, sectionId: string, generation: string,
  signal?: AbortSignal): Promise<ArtifactSectionRevisionView> {
  const section = identifier(sectionId, "section contract");
  const raw = await requestApiWithStatuses(basePath(ref) + "/sections/" + encodeURIComponent(section) + "/revise", {
    method: "POST", ...(signal === undefined ? {} : { signal }), headers: { "content-type": "application/json", "idempotency-key": await mutationKey("revise", ref, section) },
    body: JSON.stringify({ protocol: "eliotr.artifact-section-revise.v1", expected_artifact_revision: ref.revision }),
  }, [200, 201], 120_000);
  const outer = envelope(raw); checkGeneration(outer.deployment_generation, generation);
  const data = record(outer.data, ["protocol", "operation_id", "attempt_ref", "state", "parent_artifact_ref", "section_id", "disposition"], ["draft"]);
  if (data.protocol !== "eliotr.artifact-section-revise-status.v1" || !sameRef(versionedRef(data.parent_artifact_ref, "parent artifact"), ref) || data.section_id !== section) invalid();
  disposition(data.disposition);
  const state = data.state;
  if (state !== "STARTED" && state !== "OUTPUT_RECORDED" && state !== "COMMITTED" && state !== "UNKNOWN" && state !== "CANCELLED") invalid();
  let draft: ArtifactSectionRevisionView["draft"];
  if (data.draft !== undefined) {
    const value = record(data.draft, ["artifact_ref", "manifest_sha256"]);
    const child = versionedRef(value.artifact_ref, "child artifact");
    if (state !== "COMMITTED" || child.id !== ref.id || child.revision !== ref.revision + 1) invalid();
    draft = { artifact_ref: child, manifest_sha256: sha(value.manifest_sha256) };
  }
  if (state === "COMMITTED" && draft === undefined) invalid();
  return { operation_id: identifier(data.operation_id, "operation"), attempt_ref: identifier(data.attempt_ref, "attempt"), state,
    ...(draft === undefined ? {} : { draft }) };
}
