import type { VersionedRef } from "@eliotr/contracts";
import {
  parseAcceptArtifactProductRequest,
  parseReviseArtifactProductSectionRequest,
  type AcceptArtifactRequest,
  type ArtifactProductInputFailure,
  type ReviseArtifactSectionRequest,
} from "@eliotr/cloudflare-artifacts/artifact-product-input.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { parseArtifactRef } from "@eliotr/interfaces";
import { HttpRequestError } from "./http-errors.js";

export type { AcceptArtifactRequest, ReviseArtifactSectionRequest };

export class ArtifactProductInputError extends HttpRequestError {
  public constructor(message = "artifact product request is invalid") {
    super("ARTIFACT_PRODUCT_INPUT_INVALID", 400, message);
    this.name = "ArtifactProductInputError";
  }
}

const inputFailure: ArtifactProductInputFailure = (message) => {
  throw new ArtifactProductInputError(message);
};

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
  return parseAcceptArtifactProductRequest(value, artifactRef, idempotencyKey, inputFailure);
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
  return parseReviseArtifactProductSectionRequest(value, artifactRef, sectionId, idempotencyKey, inputFailure);
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
