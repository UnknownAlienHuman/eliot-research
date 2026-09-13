import {
  FederationD1AuthorityError,
  FederationRuntimeAuthorityError,
} from "@eliotr/cloudflare-federation";
import { FederationServiceError } from "./federation-service.js";
import { FederationHttpError } from "./federation-http.js";
import { NavigationError } from "@eliotr/retrieval";
import { OrientationError, ScopeServiceError } from "@eliotr/cloudflare-navigation";
import { EvidenceRuntimeError } from "@eliotr/cloudflare-evidence";
import {
  IngestAuthorityError,
  IngestStorageError,
  RuntimeLimitError,
} from "@eliotr/platform-cloudflare";
import { AccessVerificationError } from "@eliotr/cloudflare-access";
import {
  CapabilityUnavailableError,
  CatalogInputError,
} from "./composition-root.js";
import {
  ArtifactHttpInputError,
  ArtifactReadNotFoundError,
  isArtifactReadError,
} from "./artifact-draft-http.js";
import { EvidenceHttpInputError } from "./evidence-http.js";
import { IngestHttpInputError } from "./ingest-http.js";
import { RawNormalizedAdmissionError } from "./raw-normalized-admission.js";
import { ErasureAdmissionError, ErasureRuntimeError } from "@eliotr/cloudflare-erasure";
import { IngestServiceError } from "./ingest-service.js";
import {
  RawCaptureError,
  RawCaptureHttpError,
  rawCaptureProblem,
} from "@eliotr/cloudflare-raw-ingest";

export class HttpRequestError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly retryable: boolean;

  public constructor(code: string, status: number, message: string, retryable = false) {
    super(message);
    this.name = "HttpRequestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

type ProblemResponse = (
  request: Request,
  status: number,
  code: string,
  title: string,
  retryable: boolean,
  headers?: HeadersInit,
) => Response;

function mapIngestAuthorityError(request: Request, error: IngestAuthorityError, problemResponse: ProblemResponse): Response {
  if (error.code === "INGEST_SETTLEMENT_UNCERTAIN") {
    return problemResponse(request, 503, error.code, "Ingest authority settlement is uncertain", true);
  }
  if (error.code === "INGEST_AUTHORITY_MISSING") {
    return problemResponse(request, 404, error.code, "Ingest authority does not exist", false);
  }
  if (error.code === "INGEST_OWNER_NOT_ACTIVE" || error.code === "INGEST_POLICY_DENIED") {
    return problemResponse(request, 403, error.code, "Ingest admission is not authorized", false);
  }
  if (error.code === "INGEST_AUTHORITY_INPUT_INVALID") {
    return problemResponse(request, 400, error.code, "Ingest authority input is invalid", false);
  }
  return problemResponse(request, 409, error.code, "Ingest authority conflicts with durable state", false);
}

function mapIngestStorageError(request: Request, error: IngestStorageError, problemResponse: ProblemResponse): Response {
  if (error.retryable) {
    return problemResponse(request, 503, error.code, "Ingest storage is temporarily unavailable", true);
  }
  if (error.code === "STAGING_SESSION_NOT_FOUND") {
    return problemResponse(request, 404, error.code, "Staging session does not exist", false);
  }
  if (
    error.code === "BUNDLE_INPUT_INVALID" ||
    error.code === "BUNDLE_RESIDENCY_MISMATCH" ||
    error.code === "BUNDLE_FILE_SET_INVALID" ||
    error.code === "BUNDLE_HASH_MANIFEST_INVALID" ||
    error.code === "BUNDLE_TOTAL_SIZE_MISMATCH" ||
    error.code === "STAGING_FILE_UNKNOWN" ||
    error.code === "STAGING_PART_INVALID"
  ) {
    return problemResponse(request, 400, error.code, "Ingest storage input is invalid", false);
  }
  return problemResponse(request, 409, error.code, "Ingest storage state or integrity conflict", false);
}

export function mapError(request: Request, error: unknown, problemResponse: ProblemResponse): Response {
  if (error instanceof ErasureAdmissionError) {
    return problemResponse(request, error.code === "ERASURE_PERMISSION_DENIED" ? 403 : 409,
      error.code, error.message, false);
  }
  if (error instanceof ErasureRuntimeError) {
    return problemResponse(request, error.retryable ? 503 : error.code === "ERASURE_INPUT_INVALID" ? 400 : 409,
      error.code, error.message, error.retryable);
  }
  if (error instanceof OrientationError) return problemResponse(request, error.status, error.code, "Orientation request cannot be completed", error.retryable);
  if (error instanceof ScopeServiceError) return problemResponse(request, 409, error.code, "Current scope authority could not be established", false);
  if (error instanceof NavigationError) return problemResponse(request, error.code === "NAVIGATION_LIMIT_EXCEEDED" ? 413 : 409,
    error.code, "Navigation is unavailable under the current scope", false);
  if (error instanceof AccessVerificationError) {
    const unavailable = error.code === "ACCESS_CONFIG_INVALID" ||
      error.code === "ACCESS_JWKS_UNAVAILABLE" ||
      error.code === "ACCESS_JWKS_INVALID";
    if (unavailable) {
      return problemResponse(request, 503, error.code, "Authentication service is unavailable", true);
    }
    if (error.code === "ACCESS_SERVICE_PRINCIPAL_DENIED") {
      return problemResponse(request, 403, error.code, "Authenticated service principal is not allowed", false);
    }
    return problemResponse(
      request,
      401,
      error.code,
      "Authentication failed",
      false,
      { "www-authenticate": "Bearer realm=\"Cloudflare Access\"" },
    );
  }
  if (error instanceof HttpRequestError || error instanceof IngestHttpInputError || error instanceof EvidenceHttpInputError || error instanceof ArtifactHttpInputError || error instanceof ArtifactReadNotFoundError || error instanceof RawCaptureHttpError) {
    return problemResponse(request, error.status, error.code, error.message, error.retryable);
  }
  if (isArtifactReadError(error)) {
    const status = error.code === "ARTIFACT_DRAFT_READ_DENIED" ? 403
      : error.code === "ARTIFACT_DRAFT_READ_NOT_FOUND" ? 404
      : error.code === "ARTIFACT_DRAFT_READ_STALE" ? 410
      : error.code === "ARTIFACT_DRAFT_READ_UNAVAILABLE" ? 503
      : error.code === "ARTIFACT_DRAFT_READ_INVALID" ? 400
      : 409;
    const retryable = error.code === "ARTIFACT_DRAFT_READ_UNAVAILABLE";
    return problemResponse(request, status, error.code, status === 400 ? "Artifact reference is invalid"
      : status === 403 ? "Artifact access is not authorized"
      : status === 404 ? "Artifact revision does not exist"
      : status === 410 ? "Artifact scope is no longer current"
      : status === 503 ? "Artifact storage is temporarily unavailable"
      : "Artifact revision integrity could not be verified", retryable);
  }
  if (error instanceof RawNormalizedAdmissionError) {
    return problemResponse(request, error.status, error.code, error.message, error.retryable);
  }
  if (error instanceof IngestServiceError) {
    return problemResponse(request, error.status, error.code, error.message, error.retryable);
  }
  if (error instanceof IngestAuthorityError) return mapIngestAuthorityError(request, error, problemResponse);
  if (error instanceof IngestStorageError) return mapIngestStorageError(request, error, problemResponse);
  if (error instanceof RawCaptureError) { const mapped = rawCaptureProblem(error); return problemResponse(request, mapped.status, error.code, mapped.title, error.retryable); }
  if (error instanceof EvidenceRuntimeError) {
    if (error.retryable) {
      return problemResponse(request, 503, error.code, "Exact evidence resolution is temporarily unavailable", true);
    }
    if (error.code === "EVIDENCE_AUTHORIZATION_DENIED") {
      return problemResponse(request, 403, error.code, "Exact evidence access is not authorized", false);
    }
    if (error.code === "EVIDENCE_SCOPE_NOT_FOUND" || error.code === "EVIDENCE_SOURCE_NOT_FOUND" ||
        error.code === "EVIDENCE_HANDLE_NOT_FOUND" || error.code === "EVIDENCE_OBJECT_NOT_FOUND") {
      return problemResponse(request, 404, error.code, "Exact evidence authority does not exist", false);
    }
    if (error.code === "EVIDENCE_SOURCE_NOT_LIVE" || error.code === "EVIDENCE_HANDLE_NOT_LIVE" ||
        error.code === "EVIDENCE_SCOPE_INVALIDATED" || error.code === "EVIDENCE_SCOPE_EXPIRED") {
      return problemResponse(request, 410, error.code, "Exact evidence is no longer available", false);
    }
    if (error.code === "EVIDENCE_INPUT_INVALID" || error.code === "EVIDENCE_RANGE_INVALID" ||
        error.code === "EVIDENCE_LOCATOR_NOT_RESOLVABLE" || error.code === "EVIDENCE_PRECISION_UNSUPPORTED" ||
        error.code === "CITATION_SET_INVALID") {
      return problemResponse(request, 400, error.code, "Exact evidence request is invalid", false);
    }
    return problemResponse(request, 409, error.code, "Exact evidence authority conflicts with current state", false);
  }
  if (error instanceof FederationHttpError) {
    return problemResponse(
      request,
      error.status,
      error.code,
      error.message,
      error.retryable,
    );
  }
  if (error instanceof FederationRuntimeAuthorityError) {
    const status = error.retryable || error.code === "FEDERATION_RUNTIME_CONFIG_INVALID"
      ? 503
      : error.code.includes("MISSING")
        ? 404
        : error.code.includes("TOO_LARGE")
          ? 413
          : error.code.includes("RANGE")
            ? 416
            : error.code.includes("EXPIRED")
              ? 410
              : error.code.includes("CURSOR_INVALID") ||
                  error.code.includes("SCOPE_INVALID")
                ? 400
                : 409;
    return problemResponse(
      request,
      status,
      error.code,
      error.message,
      error.retryable || status === 503,
    );
  }
  if (error instanceof FederationD1AuthorityError) {
    const status = error.retryable || error.code === "FEDERATION_D1_READ_FAILED"
      ? 503
      : error.code === "FEDERATION_D1_BINDING_MISMATCH"
        ? 403
        : 409;
    return problemResponse(
      request,
      status,
      error.code,
      error.message,
      error.retryable || status === 503,
    );
  }
  if (error instanceof FederationServiceError) {
    const status = error.retryable
      ? 503
      : error.code.includes("NOT_FOUND")
        ? 404
        : error.code.includes("EXPIRED")
          ? 410
          : error.code.includes("AUTH") ||
              error.code.includes("DENIED") ||
              error.code.includes("IDENTITY_MISMATCH")
            ? 403
            : error.code.includes("TOO_LARGE") ||
                error.code.includes("INVALID") ||
                error.code.includes("RANGE")
              ? 400
              : 409;
    return problemResponse(
      request,
      status,
      error.code,
      error.message,
      error.retryable || status === 503,
    );
  }
  if (error instanceof CatalogInputError) {
    return problemResponse(request, error.status, error.code, error.message, error.retryable);
  }
  if (error instanceof CapabilityUnavailableError) {
    return problemResponse(
      request,
      501,
      error.code,
      "The operation is not available in this Worker generation",
      false,
    );
  }
  if (error instanceof RuntimeLimitError) {
    const requestError = error.label.startsWith("http.request");
    return problemResponse(
      request,
      requestError ? 413 : 500,
      requestError ? "REQUEST_BODY_TOO_LARGE" : "RESPONSE_LIMIT_EXCEEDED",
      requestError ? "Request exceeds its bounded runtime envelope" : "Response exceeds its bounded runtime envelope",
      false,
    );
  }
  return problemResponse(request, 500, "INTERNAL_ERROR", "Internal request processing failed", true);
}
