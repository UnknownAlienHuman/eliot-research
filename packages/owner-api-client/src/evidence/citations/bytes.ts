/** C3-EC evidence byte fencing.
 *
 * Moved mechanically from the legacy browser evidence reader. The two authority reads, the stream
 * headers and the digest cross-check are preserved exactly. The only change is that transport is the
 * injected legacy adapter Pick and hashing is injected, so this module owns no browser global.
 */

import {
  EvidenceHandleSchema,
  IdentifierSchema,
  ResolvedEvidenceSchema,
  Sha256Schema,
  VersionedRefSchema,
  type ResolvedEvidence,
  type VersionedRef,
} from '@eliotr/contracts';
import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http.js';
import type { EpochPort } from '../../transport/client.js';

export const MAX_EVIDENCE_BYTES = 512 * 1024;

const VERIFY_PATH = '/api/v1/research/verify';
const OPEN_PATH = '/api/v1/research/open';

export interface OpenedEvidence {
  readonly text: string;
  readonly handleRef: VersionedRef;
  readonly excerptSha256: string;
  readonly verificationReceiptRef: string;
}

export interface VerifiedEvidence extends OpenedEvidence {
  readonly evidence: ResolvedEvidence;
}

export interface EvidenceBytesPorts {
  readonly request: Pick<LegacyHttpAdapter, 'requestApi' | 'requestApiText'>;
  readonly errors: LegacyErrorFactory;
  readonly epoch: EpochPort;
  /** Injected so this module imports no browser global. */
  readonly digest: (algorithm: string, bytes: Uint8Array) => Promise<ArrayBuffer>;
}

export interface EvidenceBytesApi {
  readonly verifyEvidence: (
    scopeSnapshotRef: VersionedRef,
    handleRef: VersionedRef,
    signal?: AbortSignal,
  ) => Promise<ResolvedEvidence>;
  readonly openEvidence: (handleRef: VersionedRef, signal?: AbortSignal) => Promise<OpenedEvidence>;
  readonly verifyAndOpenEvidence: (
    scopeSnapshotRef: VersionedRef,
    handleRef: VersionedRef,
    signal?: AbortSignal,
  ) => Promise<VerifiedEvidence>;
}

const sameRef = (left: VersionedRef, right: VersionedRef): boolean =>
  left.id === right.id && left.revision === right.revision;

export function createEvidenceBytesApi(ports: EvidenceBytesPorts): EvidenceBytesApi {
  const { request, errors, epoch, digest } = ports;

  function invalid(message?: string): never {
    throw errors({
      code: 'EVIDENCE_RESPONSE_INVALID',
      status: 502,
      message: message ?? 'Evidence response is invalid; run the query again',
      traceId: null,
      retryable: false,
    });
  }

  const record = (value: unknown, required: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some((key) => !required.includes(key)) ||
        required.some((key) => !Object.hasOwn(value, key))) invalid('Evidence response is invalid; run the query again');
    return value as Record<string, unknown>;
  };

  const requiredHeader = (headers: Headers, name: string): string => {
    const value = headers.get(name);
    if (!value || value !== value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
    return value;
  };

  const parseHandleHeader = (value: string): VersionedRef => {
    const separator = value.lastIndexOf(':');
    if (separator <= 0 || separator === value.length - 1 || !/^[1-9][0-9]*$/u.test(value.slice(separator + 1))) {
      invalid('Opened evidence handle is invalid');
    }
    const parsed = VersionedRefSchema.safeParse({
      id: value.slice(0, separator),
      revision: Number(value.slice(separator + 1)),
    });
    if (!parsed.success) invalid('Opened evidence handle is invalid');
    return parsed.data;
  };

  const sha256 = async (value: string): Promise<string> => {
    const bytes = new TextEncoder().encode(value);
    const digestBytes = new Uint8Array(await digest('SHA-256', bytes));
    return [...digestBytes].map((part) => part.toString(16).padStart(2, '0')).join('');
  };

  const fenced = async <T>(operation: () => Promise<T>): Promise<T> => {
    const captured = epoch.capture();
    const value = await operation();
    if (!epoch.isCurrent(captured)) {
      throw errors({
        code: 'API_SESSION_CLOSED',
        status: 503,
        message: 'Response belongs to a closed owner session',
        traceId: null,
        retryable: false,
      });
    }
    return value;
  };

  const verifyEvidence = async (
    scopeSnapshotRef: VersionedRef,
    handleRef: VersionedRef,
    signal?: AbortSignal,
  ): Promise<ResolvedEvidence> => {
    const scope = VersionedRefSchema.parse(scopeSnapshotRef);
    const handle = VersionedRefSchema.parse(handleRef);
    return fenced(async () => {
      const raw = await request.requestApi(VERIFY_PATH, {
        method: 'POST',
        body: JSON.stringify({ scope_snapshot_ref: scope, handle_ref: handle }),
        headers: { 'content-type': 'application/json' },
        ...(signal ? { signal } : {}),
      });
      const envelope = record(raw, ['data', 'trace_id', 'deployment_generation']);
      const data = record(envelope.data, ['resolved_evidence', 'handle']);
      const parsedPair = ((): [ResolvedEvidence, ReturnType<typeof EvidenceHandleSchema.parse>] => {
        try {
          return [
            ResolvedEvidenceSchema.parse(data.resolved_evidence),
            EvidenceHandleSchema.parse(data.handle),
          ];
        } catch {
          return invalid();
        }
      })();
      const evidence = parsedPair[0];
      const returnedHandle = parsedPair[1];
      if (!sameRef(evidence.handle.handle_ref, handle) || !sameRef(evidence.handle.scope_snapshot_ref, scope) ||
          !sameRef(returnedHandle.handle_ref, handle) || !sameRef(returnedHandle.scope_snapshot_ref, scope) ||
          evidence.handle.source_revision_ref !== returnedHandle.source_revision_ref ||
          evidence.handle.excerpt_sha256 !== returnedHandle.excerpt_sha256) {
        invalid('Verified evidence does not match the selected handle or scope');
      }
      return evidence;
    });
  };

  const openEvidence = async (handleRef: VersionedRef, signal?: AbortSignal): Promise<OpenedEvidence> => {
    const handle = VersionedRefSchema.parse(handleRef);
    return fenced(async () => {
      const path = `${OPEN_PATH}/${encodeURIComponent(`${handle.id}:${handle.revision}`)}`;
      const response = await request.requestApiText(path, signal, MAX_EVIDENCE_BYTES);
      const returned = parseHandleHeader(requiredHeader(response.headers, 'x-eliotr-evidence-handle'));
      if (!sameRef(returned, handle)) invalid('Opened evidence handle differs from the selected handle');
      const excerptSha256 = requiredHeader(response.headers, 'x-eliotr-excerpt-sha256');
      if (!Sha256Schema.safeParse(excerptSha256).success) invalid('Opened evidence digest is invalid');
      const verificationReceiptRef = requiredHeader(response.headers, 'x-eliotr-verification-receipt');
      if (!IdentifierSchema.safeParse(verificationReceiptRef).success) invalid('Opened evidence receipt is invalid');
      const length = response.headers.get('content-length');
      const byteLength = new TextEncoder().encode(response.text).byteLength;
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== byteLength)) invalid('Opened evidence length is invalid');
      return { text: response.text, handleRef: returned, excerptSha256, verificationReceiptRef };
    });
  };

  const verifyAndOpenEvidence = async (
    scopeSnapshotRef: VersionedRef,
    handleRef: VersionedRef,
    signal?: AbortSignal,
  ): Promise<VerifiedEvidence> => {
    return fenced(async () => {
      const evidence = await verifyEvidence(scopeSnapshotRef, handleRef, signal);
      const opened = await openEvidence(evidence.handle.handle_ref, signal);
      const contentSha256 = await sha256(opened.text);
    if (contentSha256 !== opened.excerptSha256) invalid('Pinned digest differs from the opened content');
      // Core may mint a new resolution receipt for each authorized reopen. The pinned handle, excerpt
      // digest and exact byte length are the stable identity.
      if (!sameRef(opened.handleRef, evidence.handle.handle_ref) || opened.excerptSha256 !== evidence.handle.excerpt_sha256 ||
          opened.excerptSha256 !== contentSha256 || new TextEncoder().encode(opened.text).byteLength !== evidence.handle.excerpt_byte_length ||
          !IdentifierSchema.safeParse(opened.verificationReceiptRef).success) {
        invalid('Opened evidence does not match the verified excerpt');
      }
      return { evidence, ...opened };
    });
  };

  return { verifyEvidence, openEvidence, verifyAndOpenEvidence };
}
