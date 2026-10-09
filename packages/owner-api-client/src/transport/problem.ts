/** Strict problem decoder.
 *
 * Field set, bounds and the HTTP status match are copied from `decodeApiProblem` in
 * `packages/pwa-http-client/src/api.ts`. Two differences are deliberate:
 *
 * - the problem budget is fixed at 16 KiB and independent of the success budget, so a document-sized
 *   error body cannot consume the object ceiling;
 * - a value this decoder fails on yields a typed error instead of a synthesized problem object.
 */

import { MAX_PROBLEM_BYTES, OwnerBodyError, readJsonBody } from './body.js';

export interface DecodedProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly traceId: string;
  readonly retryable: boolean;
}

const PROBLEM_FIELDS = ['type', 'title', 'status', 'code', 'trace_id', 'retryable'] as const;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// Control characters only. Space is deliberately allowed, because titles are prose and the legacy
// requiredString bound is used for identifiers, not for human-readable strings.
const CONTROL_CHARACTERS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + ']',
  'u',
);

function rejected(fallbackStatus: number): OwnerBodyError {
  return new OwnerBodyError({
    status: fallbackStatus,
    code: 'MALFORMED_API_PROBLEM',
    message: 'API returned an invalid typed problem',
  });
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
      value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    throw new OwnerBodyError({
      status: 502, code: 'API_RESPONSE_SCHEMA_MISMATCH', message: `${label} is not a valid bounded string`,
    });
  }
  return value;
}

export function decodeProblemBody(value: unknown, httpStatus: number): DecodedProblem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw rejected(httpStatus);
  const record = value as Record<string, unknown>;

  // Exact keys. An unknown field is a contract drift, not an extra convenience.
  const keys = Object.keys(record);
  if (keys.length !== PROBLEM_FIELDS.length) throw rejected(httpStatus);
  for (const field of PROBLEM_FIELDS) {
    if (!Object.hasOwn(record, field)) throw rejected(httpStatus);
  }

  const type = boundedString(record.type, 'problem.type', 256);
  if (!type.startsWith('urn:eliotr:problem:')) throw rejected(httpStatus);

  const status = record.status;
  if (typeof status !== 'number' || !Number.isSafeInteger(status) || status < 400 || status > 599 ||
      status !== httpStatus) {
    throw rejected(httpStatus);
  }

  if (typeof record.retryable !== 'boolean') throw rejected(httpStatus);

  const trace = boundedString(record.trace_id, 'problem.trace_id', 128);
  if (!SAFE_TRACE_ID.test(trace)) throw rejected(httpStatus);

  return {
    type,
    title: boundedString(record.title, 'problem.title', 512),
    status,
    code: boundedString(record.code, 'problem.code', 128),
    traceId: trace,
    retryable: record.retryable as boolean,
  };
}

/** Budget a caller must allow when reading a problem body. */
export const problemBudget = (): number => MAX_PROBLEM_BYTES;

/** Error bodies use their own small budget, independent of the requested object ceiling. */
export async function readProblemBody(response: Response, signal?: AbortSignal): Promise<DecodedProblem> {
  if (!isProblemStatus(response.status)) throw rejected(response.status);
  return decodeProblemBody(await readJsonBody(response, signal, MAX_PROBLEM_BYTES, [response.status]), response.status);
}

/** True when an HTTP status can legally carry a typed problem body. */
export function isProblemStatus(status: number): boolean {
  return Number.isSafeInteger(status) && status >= 400 && status <= 599;
}
