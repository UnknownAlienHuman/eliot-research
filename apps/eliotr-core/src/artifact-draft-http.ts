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

export function parseArtifactRef(value: string): VersionedRef {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ArtifactHttpInputError("artifact reference must end with :revision");
  }
  const id = value.slice(0, separator);
  const rawRevision = value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/u.test(rawRevision)) {
    throw new ArtifactHttpInputError("artifact revision must be a positive integer");
  }
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision)) {
    throw new ArtifactHttpInputError("artifact revision is outside the safe integer range");
  }
  try {
    return VersionedRefSchema.parse({ id, revision });
  } catch {
    throw new ArtifactHttpInputError();
  }
}

const ARTIFACT_READ_CODES = new Set([
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_ACCESS_DENIED",
  "ARTIFACT_SCOPE_STALE",
  "ARTIFACT_INTEGRITY_INVALID",
  "ARTIFACT_READ_UNAVAILABLE",
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
