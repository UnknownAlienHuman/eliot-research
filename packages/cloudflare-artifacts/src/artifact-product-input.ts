import type { VersionedRef } from "@eliotr/contracts";
import { IdentifierSchema, VersionedRefSchema } from "@eliotr/contracts";

export interface AcceptArtifactRequest {
  readonly protocol: "eliotr.artifact-publication-accept.v1";
  readonly artifact_ref: VersionedRef;
  readonly expected_draft_head_revision: number;
  readonly expected_publication_revision: number | null;
  readonly idempotency_key: string;
}

export interface ReviseArtifactSectionRequest {
  readonly protocol: "eliotr.artifact-section-revise.v1";
  readonly artifact_ref: VersionedRef;
  readonly section_id: string;
  readonly expected_artifact_revision: number;
  readonly idempotency_key: string;
}

/** Keeps transport error ownership with the caller while sharing the strict input grammar. */
export type ArtifactProductInputFailure = (message: string) => never;

function recordWithKeys(
  value: unknown,
  keys: readonly string[],
  fail: ArtifactProductInputFailure,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("artifact product request must be an object");
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    fail("artifact product request has unknown or missing fields");
  }
  return record;
}

function positiveRevision(
  value: unknown,
  label: string,
  fail: ArtifactProductInputFailure,
  nullable = false,
): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${label} must be a positive safe integer${nullable ? " or null" : ""}`);
  }
  return value as number;
}

function validateIdempotencyKey(key: string, fail: ArtifactProductInputFailure): void {
  if (typeof key !== "string" || key.length < 1 || key.length > 256 ||
      /[\u0000-\u0020\u007f]/u.test(key)) {
    fail("idempotency-key header is required");
  }
}

function exactArtifactRef(value: VersionedRef, fail: ArtifactProductInputFailure): VersionedRef {
  try {
    return VersionedRefSchema.parse(value);
  } catch {
    fail("artifact reference is invalid");
  }
}

/** Strictly decode the bounded ACCEPTED publication request. All authority and verification inputs are server derived. */
export function parseAcceptArtifactProductRequest(
  value: unknown,
  artifactRef: VersionedRef,
  idempotencyKey: string,
  fail: ArtifactProductInputFailure,
): AcceptArtifactRequest {
  const record = recordWithKeys(value, [
    "protocol", "expected_draft_head_revision", "expected_publication_revision",
  ], fail);
  if (record.protocol !== "eliotr.artifact-publication-accept.v1") {
    fail("artifact publication protocol is unsupported");
  }
  const parsedRef = exactArtifactRef(artifactRef, fail);
  const expectedDraftHead = positiveRevision(record.expected_draft_head_revision, "expected draft head", fail) as number;
  if (expectedDraftHead !== parsedRef.revision) {
    fail("expected draft head must match the exact artifact revision in the path");
  }
  validateIdempotencyKey(idempotencyKey, fail);
  return {
    protocol: "eliotr.artifact-publication-accept.v1",
    artifact_ref: parsedRef,
    expected_draft_head_revision: expectedDraftHead,
    expected_publication_revision: positiveRevision(
      record.expected_publication_revision, "expected publication revision", fail, true,
    ),
    idempotency_key: idempotencyKey,
  };
}

/** Strictly decode the bounded COW revise request; section and artifact identities come from the route. */
export function parseReviseArtifactProductSectionRequest(
  value: unknown,
  artifactRef: VersionedRef,
  sectionId: string,
  idempotencyKey: string,
  fail: ArtifactProductInputFailure,
): ReviseArtifactSectionRequest {
  const record = recordWithKeys(value, ["protocol", "expected_artifact_revision"], fail);
  if (record.protocol !== "eliotr.artifact-section-revise.v1") {
    fail("artifact section revise protocol is unsupported");
  }
  const parsedRef = exactArtifactRef(artifactRef, fail);
  const expectedRevision = positiveRevision(record.expected_artifact_revision, "expected artifact revision", fail) as number;
  if (expectedRevision !== parsedRef.revision) {
    fail("expected artifact revision must match the exact artifact revision in the path");
  }
  const parsedSectionId = IdentifierSchema.safeParse(sectionId);
  if (!parsedSectionId.success) fail("artifact section id is invalid");
  validateIdempotencyKey(idempotencyKey, fail);
  return {
    protocol: "eliotr.artifact-section-revise.v1",
    artifact_ref: parsedRef,
    section_id: parsedSectionId.data,
    expected_artifact_revision: expectedRevision,
    idempotency_key: idempotencyKey,
  };
}
