import type { VersionedRef } from "@eliotr/contracts";
import { IdentifierSchema, VersionedRefSchema } from "@eliotr/contracts";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { parseArtifactRef } from "./artifact-draft-http.js";
import { HttpRequestError } from "./http-errors.js";

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

export class ArtifactProductInputError extends HttpRequestError {
  public constructor(message = "artifact product request is invalid") {
    super("ARTIFACT_PRODUCT_INPUT_INVALID", 400, message);
    this.name = "ArtifactProductInputError";
  }
}

function recordWithKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ArtifactProductInputError("artifact product request must be an object");
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new ArtifactProductInputError("artifact product request has unknown or missing fields");
  }
  return record;
}

function positiveRevision(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ArtifactProductInputError(`${label} must be a positive safe integer${nullable ? " or null" : ""}`);
  }
  return value as number;
}

function readIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (key === null || key.length < 1 || key.length > 256 || /[\u0000-\u0020\u007f]/u.test(key)) {
    throw new ArtifactProductInputError("idempotency-key header is required");
  }
  return key;
}

/** Strictly decode the bounded ACCEPTED publication request. All authority and verification inputs are server derived. */
export function parseAcceptArtifactRequest(
  value: unknown,
  artifactRef: VersionedRef,
  idempotencyKey: string,
): AcceptArtifactRequest {
  const record = recordWithKeys(value, [
    "protocol", "expected_draft_head_revision", "expected_publication_revision",
  ]);
  if (record.protocol !== "eliotr.artifact-publication-accept.v1") {
    throw new ArtifactProductInputError("artifact publication protocol is unsupported");
  }
  let parsedRef: VersionedRef;
  try {
    parsedRef = VersionedRefSchema.parse(artifactRef);
  } catch {
    throw new ArtifactProductInputError("artifact reference is invalid");
  }
  const expectedDraftHead = positiveRevision(record.expected_draft_head_revision, "expected draft head") as number;
  if (expectedDraftHead !== parsedRef.revision) {
    throw new ArtifactProductInputError("expected draft head must match the exact artifact revision in the path");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256 ||
      /[\u0000-\u0020\u007f]/u.test(idempotencyKey)) {
    throw new ArtifactProductInputError("idempotency-key header is required");
  }
  return {
    protocol: "eliotr.artifact-publication-accept.v1",
    artifact_ref: parsedRef,
    expected_draft_head_revision: expectedDraftHead,
    expected_publication_revision: positiveRevision(record.expected_publication_revision,
      "expected publication revision", true),
    idempotency_key: idempotencyKey,
  };
}

export async function readAcceptArtifactRequest(
  request: Request,
  artifactRefPathValue: string,
  maximumBytes: number,
): Promise<AcceptArtifactRequest> {
  return parseAcceptArtifactRequest(
    await readJsonBodyWithinBytes(request, maximumBytes),
    parseArtifactRef(artifactRefPathValue),
    readIdempotencyKey(request),
  );
}

/** Strictly decode the bounded COW revise request; section and artifact identities come from the route. */
export function parseReviseArtifactSectionRequest(
  value: unknown,
  artifactRef: VersionedRef,
  sectionId: string,
  idempotencyKey: string,
): ReviseArtifactSectionRequest {
  const record = recordWithKeys(value, ["protocol", "expected_artifact_revision"]);
  if (record.protocol !== "eliotr.artifact-section-revise.v1") {
    throw new ArtifactProductInputError("artifact section revise protocol is unsupported");
  }
  let parsedRef: VersionedRef;
  try {
    parsedRef = VersionedRefSchema.parse(artifactRef);
  } catch {
    throw new ArtifactProductInputError("artifact reference is invalid");
  }
  const expectedRevision = positiveRevision(record.expected_artifact_revision, "expected artifact revision") as number;
  if (expectedRevision !== parsedRef.revision) {
    throw new ArtifactProductInputError("expected artifact revision must match the exact artifact revision in the path");
  }
  const parsedSectionId = IdentifierSchema.safeParse(sectionId);
  if (!parsedSectionId.success) throw new ArtifactProductInputError("artifact section id is invalid");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1 || idempotencyKey.length > 256 ||
      /[\u0000-\u0020\u007f]/u.test(idempotencyKey)) {
    throw new ArtifactProductInputError("idempotency-key header is required");
  }
  return {
    protocol: "eliotr.artifact-section-revise.v1",
    artifact_ref: parsedRef,
    section_id: parsedSectionId.data,
    expected_artifact_revision: expectedRevision,
    idempotency_key: idempotencyKey,
  };
}

export async function readReviseArtifactSectionRequest(
  request: Request,
  artifactRefPathValue: string,
  sectionId: string,
  maximumBytes: number,
): Promise<ReviseArtifactSectionRequest> {
  return parseReviseArtifactSectionRequest(
    await readJsonBodyWithinBytes(request, maximumBytes),
    parseArtifactRef(artifactRefPathValue),
    sectionId,
    readIdempotencyKey(request),
  );
}
