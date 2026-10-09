// C2-D owner-client move of the readable half of packages/pwa-source-workspace/src/document-reader-api.ts.
// Wire/value implementation moves here verbatim; only the transport, digest and epoch seams are injected.
// The legacy route is a whole 200 object. No range, no conditional request and no ETag contract is
// invented, because no owner endpoint method declares one.
import { IdentifierSchema, Sha256Schema } from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

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

/** Byte transport only. Status, budget and header policy stays in the injected owner client. */
export type ReaderHttp = Pick<LegacyHttpAdapter, 'requestApiBytes'>;

/**
 * Digest is injected rather than acquired from an ambient `crypto` global, so this module imports under
 * Node and a worker, a test or a future runtime supplies its own. The bytes are the caller's, not
 * the module's.
 */
export type ReaderDigest = (bytes: Uint8Array) => Promise<string>;

export interface ReaderApi {
  readonly readAdmittedDocument: (
    sourceRevisionRef: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ) => Promise<AdmittedDocument>;
}

export interface ReaderPorts {
  readonly http: ReaderHttp;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
  readonly sha256: ReaderDigest;
}

export function createReaderApi(ports: ReaderPorts): ReaderApi {
  const { http, errors, epoch, sha256 } = ports;

  const failure: (code: string, status: number, message: string, retryable?: boolean) => never = (code, status, message, retryable = false) => {
    throw errors({ code, status, message, traceId: null, retryable });
  };

  const identifier = (value: unknown, label: string): string => {
    const parsed = IdentifierSchema.safeParse(value);
    if (!parsed.success) failure('DOCUMENT_INPUT_INVALID', 400, `${label} is invalid`);
    return parsed.data;
  };

  const header = (headers: Headers, name: string): string => {
    const value = headers.get(name);
    if (value === null || value.length === 0 || value !== value.trim() ||
        /[\u0000-\u001f\u007f]/u.test(value) || value.length > 1024) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, `Document response is missing a valid ${name} header`);
    }
    return value;
  };

  const closed = (): never => failure(
    'API_SESSION_CLOSED', 503, 'Response belongs to a closed owner session',
  );

  /** Everything after the transport read is a pure function of the bytes and their headers. */
  /**
   * Private UTF-8 helper. The legacy module had no exported decoder, and inventing one would publish
   * an AdmittedDocument whose verified identities are empty. Text is decoded from the immutable clone
   * the caller passes in, so an AdmittedDocument can only be built after every identity check passes.
   */
  const decodeUtf8 = (bytes: Uint8Array): string => {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document content is not valid UTF-8');
    }
    if (text.length === 0) failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document content is empty');
    return text;
  };

  const readAdmittedDocument = async (
    sourceRevisionRef: string,
    expectedDeploymentGeneration: string,
    signal?: AbortSignal,
  ): Promise<AdmittedDocument> => {
    const revision = identifier(sourceRevisionRef, 'source revision');
    const generation = identifier(expectedDeploymentGeneration, 'deployment generation');
    const capture = epoch.capture();
    // Preflight fence. A session that is already closed must never reach the network at all, so the
    // captured epoch is re-checked before the request rather than only after it.
    if (!epoch.isCurrent(capture)) closed();

    const query = new URLSearchParams({ source_revision_ref: revision });
    const response = await http.requestApiBytes(
      `/api/v1/library/content?${query.toString()}`,
      signal,
      MAX_DOCUMENT_BYTES,
      'text/plain',
    );

    // The response bytes are cloned before any await, so the caller always reads back the exact same
    // bytes that were verified, never a value that could be reassigned while the digest computed.
    const immutableBytes = response.bytes.slice();
    if (immutableBytes.byteLength === 0) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document response body is empty');
    }

    const returnedRevision = header(response.headers, 'x-eliotr-source-revision');
    if (returnedRevision !== revision) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document response does not match the selected revision');
    }
    const returnedGeneration = header(response.headers, 'x-eliotr-deployment-generation');
    if (returnedGeneration !== generation) {
      failure('DOCUMENT_GENERATION_CHANGED', 409, 'The application changed; refresh the document', true);
    }
    const contentSha256 = header(response.headers, 'x-eliotr-content-sha256');
    if (!Sha256Schema.safeParse(contentSha256).success) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document content digest is invalid');
    }
    const contentLength = header(response.headers, 'content-length');
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLength)) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document content length is invalid');
    }
    const sizeBytes = Number(contentLength);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes !== immutableBytes.byteLength) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document content length does not match the response body');
    }

    // The digest is an await boundary a stale response can cross, so the epoch is re-checked after it.
    // A response from another session is discarded here and never returned to the caller.
    const digest = await sha256(immutableBytes);
    if (digest !== contentSha256) {
      failure('DOCUMENT_RESPONSE_INVALID', 502, 'Document content digest does not match the response body');
    }

    const text = decodeUtf8(immutableBytes);
    // Final fence after the asynchronous digest and synchronous decode, before product state.
    if (!epoch.isCurrent(capture)) closed();

    // The caller decodes and returns the exact same clone that was verified above.
    return {
      sourceRevisionRef: revision,
      deploymentGeneration: generation,
      contentSha256,
      sizeBytes,
      bytes: immutableBytes,
      text,
    };
  };

  return { readAdmittedDocument };
}
