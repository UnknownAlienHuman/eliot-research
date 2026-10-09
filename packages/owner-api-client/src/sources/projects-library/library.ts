/**
 * C2-L library (catalog) wire/value implementation, moved from `@eliotr/pwa-source-workspace`.
 *
 * The strict decoder, every size limit and the generation/ordering rules are carried over unchanged.
 * Requests go through the injected legacy seam, so path policy, protected headers, deadlines and
 * authorization observation stay with the transport owner instead of being reimplemented here.
 *
 * Extraction is not claimed complete: the original module stays in place until the manager's explicit
 * compatibility handoff, and this module owns no shared barrel.
 */

import type { LegacyErrorFactory, LegacyHttpAdapter } from '../../legacy/http';
import type { EpochPort } from '../../transport/client';

export interface LibraryPage {
  readonly projects: readonly { id: string; title: string; generation: string }[];
  readonly sources: readonly { id: string; title: string; readiness_ref: string }[];
  readonly next_cursor?: string;
  readonly generation: string;
  readonly trace: string;
}

export const LIBRARY_PAGE_SIZE = 20;

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const cursor = /^[A-Za-z0-9_-]{1,2048}$/u;

export type LibraryHttp = Pick<LegacyHttpAdapter, 'requestApi'>;

/**
 * `epoch` is a required third argument, never constructed here and never inferred from the
 * deployment generation. The caller's transport fence already refuses a request that starts
 * against a closed session, but it cannot observe the microtask between a response resolving
 * and this factory returning, so each async operation captures the shared epoch before the
 * request and re-checks it after decoding, immediately before returning. Pure decode-only calls
 * stay independent of the epoch.
 */
export function createLibraryApi(
  http: LibraryHttp,
  errors: LegacyErrorFactory,
  epoch: EpochPort,
) {
  function invalid(): never {
    throw errors({
      code: 'CATALOG_RESPONSE_INVALID',
      status: 502,
      message: 'Library response is invalid; reload the first page',
      traceId: null,
      retryable: false,
    });
  }

  /** A page that arrived after the shared epoch advanced is stale output, never a usable page. */
  function stale(): never {
    throw errors({
      code: 'API_SESSION_CLOSED',
      status: 503,
      message: 'Response belongs to a closed owner session',
      traceId: null,
      retryable: false,
    });
  }

  function record(raw: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || keys.some((key) => !Object.hasOwn(raw, key)) ||
        Object.keys(raw).some((key) => ![...keys, ...optional].includes(key))) invalid();
    return raw as Record<string, unknown>;
  }

  function text(raw: unknown, maxBytes: number): string {
    if (typeof raw !== 'string' || !raw.length || raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw) ||
        new TextEncoder().encode(raw).byteLength > maxBytes) invalid();
    return raw;
  }

  function id(raw: unknown): string {
    const value = text(raw, 256);
    if (!identifier.test(value)) invalid();
    return value;
  }

  function list(raw: unknown): unknown[] {
    if (!Array.isArray(raw) || raw.length > LIBRARY_PAGE_SIZE) invalid();
    return raw;
  }

  function ordered(values: readonly { id: string }[]): void {
    if (values.some((value, index) => {
      const previous = values[index - 1];
      return previous !== undefined && value.id <= previous.id;
    })) invalid();
  }

  /** Unchanged strict decoder. Exported through the factory so callers keep the original name. */
  function decodeLibraryPage(raw: unknown, expectedGeneration?: string): LibraryPage {
    const envelope = record(raw, ['data', 'trace_id', 'deployment_generation']);
    const generation = id(envelope.deployment_generation);
    const trace = id(envelope.trace_id);
    if (expectedGeneration !== undefined && generation !== expectedGeneration) {
      throw errors({
        code: 'CATALOG_GENERATION_CHANGED',
        status: 409,
        message: 'Application changed; reload the first page',
        traceId: null,
        retryable: true,
      });
    }
    const data = record(envelope.data, ['projects', 'sources'], ['next_cursor']);
    const projects = list(data.projects).map((raw) => {
      const row = record(raw, ['id', 'title', 'generation']);
      return { id: id(row.id), title: text(row.title, 4096), generation: id(row.generation) };
    });
    const sources = list(data.sources).map((raw) => {
      const row = record(raw, ['id', 'title', 'readiness_ref']);
      const sourceId = id(row.id);
      const readiness = text(row.readiness_ref, 1024);
      const prefix = `readiness:${sourceId}:`;
      if (!readiness.startsWith(prefix)) invalid();
      id(readiness.slice(prefix.length));
      return { id: sourceId, title: text(row.title, 4096), readiness_ref: readiness };
    });
    ordered(projects);
    ordered(sources);
    if (data.next_cursor !== undefined && (typeof data.next_cursor !== 'string' || !cursor.test(data.next_cursor) ||
        (projects.length === 0 && sources.length === 0))) invalid();
    return {
      projects,
      sources,
      generation,
      trace,
      ...(data.next_cursor === undefined ? {} : { next_cursor: String(data.next_cursor) }),
    };
  }

  async function readLibraryPage(
    input: { project?: string; cursor?: string; generation?: string } = {},
    signal?: AbortSignal,
  ): Promise<LibraryPage> {
    const query = new URLSearchParams({ limit: String(LIBRARY_PAGE_SIZE) });
    if (input.project !== undefined) {
      id(input.project);
      query.set('project_id', input.project);
    }
    if (input.cursor !== undefined) {
      if (!cursor.test(input.cursor)) invalid();
      query.set('cursor', input.cursor);
    }
    const captured = epoch.capture();
    if (!captured || !epoch.isCurrent(captured)) stale();
    const page = decodeLibraryPage(
      await http.requestApi(`/api/v1/research/catalog?${query}`, signal ? { signal } : {}),
      input.generation,
    );
    if (page.next_cursor !== undefined && page.next_cursor === input.cursor) invalid();
    if (!epoch.isCurrent(captured)) stale();
    return page;
  }

  return { decodeLibraryPage, readLibraryPage };
}
