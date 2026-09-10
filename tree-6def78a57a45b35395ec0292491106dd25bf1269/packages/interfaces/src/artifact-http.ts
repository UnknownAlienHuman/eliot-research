import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";

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
