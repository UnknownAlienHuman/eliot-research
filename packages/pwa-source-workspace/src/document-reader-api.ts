import { IdentifierSchema, Sha256Schema } from "@eliotr/contracts";
import { ApiRequestError, requestApiBytes } from "./api.js";

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export interface AdmittedDocument {
  readonly sourceRevisionRef: string;
  readonly deploymentGeneration: string;
  readonly contentSha256: string;
  readonly sizeBytes: number;
  /** Exact verified response bytes, retained for lossless explicit download. */
  readonly bytes: Uint8Array;
  readonly text: string;
}

function invalid(message: string): never {
  throw new ApiRequestError({ status: 502, code: "DOCUMENT_RESPONSE_INVALID", message });
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiRequestError({ status: 400, code: "DOCUMENT_INPUT_INVALID", message: `${label} is invalid` });
  }
  return parsed.data;
}

function header(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (value === null || value.length === 0 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || value.length > 1024) {
    invalid(`Document response is missing a valid ${name} header`);
  }
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

/** Read the exact admitted normalized text without falling back to raw or conversion storage. */
export async function readAdmittedDocument(
  sourceRevisionRef: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<AdmittedDocument> {
  const revision = identifier(sourceRevisionRef, "source revision");
  const generation = identifier(expectedDeploymentGeneration, "deployment generation");
  const query = new URLSearchParams({ source_revision_ref: revision });
  const response = await requestApiBytes(
    `/api/v1/library/content?${query.toString()}`,
    signal,
    MAX_DOCUMENT_BYTES,
    "text/plain",
  );
  const returnedRevision = header(response.headers, "x-eliotr-source-revision");
  if (returnedRevision !== revision) invalid("Document response does not match the selected revision");
  const returnedGeneration = header(response.headers, "x-eliotr-deployment-generation");
  if (returnedGeneration !== generation) {
    throw new ApiRequestError({ status: 409, code: "DOCUMENT_GENERATION_CHANGED", message: "The application changed; refresh the document", retryable: true });
  }
  const contentSha256 = header(response.headers, "x-eliotr-content-sha256");
  if (!Sha256Schema.safeParse(contentSha256).success) invalid("Document content digest is invalid");
  const contentLength = header(response.headers, "content-length");
  if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) invalid("Document content length is invalid");
  const sizeBytes = Number(contentLength);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes !== response.bytes.byteLength) {
    invalid("Document content length does not match the response body");
  }
  if (await sha256(response.bytes) !== contentSha256) invalid("Document content digest does not match the response body");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes); }
  catch { invalid("Document content is not valid UTF-8"); }
  if (text.length === 0) invalid("Document content is empty");
  return { sourceRevisionRef: revision, deploymentGeneration: generation, contentSha256, sizeBytes, bytes: response.bytes.slice(), text };
}
