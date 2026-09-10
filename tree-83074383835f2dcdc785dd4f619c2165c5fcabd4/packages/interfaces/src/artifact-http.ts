import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";

export interface ArtifactSectionBody {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly body_object_ref: string;
  readonly body_sha256: string;
  readonly size_bytes: number;
  readonly body: Uint8Array;
}

export function artifactSectionResponse(section: ArtifactSectionBody): Response {
  const body = new ArrayBuffer(section.body.byteLength);
  new Uint8Array(body).set(section.body);
  // These identity headers use URI-component encoding; consumers decode with decodeURIComponent.
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(section.size_bytes),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-eliotr-artifact-ref": encodeURIComponent(`${section.artifact_ref.id}:${section.artifact_ref.revision}`),
      "x-eliotr-section-ref": encodeURIComponent(`${section.section_ref.id}:${section.section_ref.revision}`),
      "x-eliotr-section-object-ref": encodeURIComponent(section.body_object_ref),
      "x-eliotr-section-sha256": section.body_sha256,
    },
  });
}

export class ArtifactHttpInputError extends Error {
  public readonly code = "ARTIFACT_REF_INVALID";
  public readonly status = 400;
  public readonly retryable = false;

  public constructor(message = "artifact reference is invalid") {
    super(message);
    this.name = "ArtifactHttpInputError";
  }
}

export class ArtifactReadNotFoundError extends Error {
  public readonly code = "ARTIFACT_DRAFT_READ_NOT_FOUND";
  public readonly status = 404;
  public readonly retryable = false;

  public constructor(message = "artifact revision does not exist") {
    super(message);
    this.name = "ArtifactReadNotFoundError";
  }
}

function parseRef(value: string, label: string, invalidMessage: string): VersionedRef {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ArtifactHttpInputError(`${label} must end with :revision`);
  }
  const id = value.slice(0, separator);
  const rawRevision = value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(rawRevision)) {
    throw new ArtifactHttpInputError(`${label} revision must be a positive integer`);
  }
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision)) {
    throw new ArtifactHttpInputError(`${label} revision is outside the safe integer range`);
  }
  try {
    return VersionedRefSchema.parse({ id, revision });
  } catch {
    throw new ArtifactHttpInputError(invalidMessage);
  }
}

export function parseArtifactRef(value: string): VersionedRef {
  return parseRef(value, "artifact reference", "artifact reference is invalid");
}

export function parseArtifactSectionRef(value: string): VersionedRef {
  return parseRef(value, "section reference", "section reference is invalid");
}

const ARTIFACT_READ_CODES = new Set([
  "ARTIFACT_DRAFT_READ_NOT_FOUND",
  "ARTIFACT_DRAFT_READ_INVALID",
  "ARTIFACT_DRAFT_READ_DENIED",
  "ARTIFACT_DRAFT_READ_STALE",
  "ARTIFACT_DRAFT_READ_INTEGRITY",
  "ARTIFACT_DRAFT_READ_UNAVAILABLE",
]);

export interface ArtifactReadErrorLike {
  readonly code: string;
  readonly retryable?: boolean;
}

export function isArtifactReadError(error: unknown): error is ArtifactReadErrorLike {
  return typeof error === "object" && error !== null &&
    "code" in error && typeof (error as { readonly code?: unknown }).code === "string" &&
    ARTIFACT_READ_CODES.has((error as { readonly code: string }).code);
}
