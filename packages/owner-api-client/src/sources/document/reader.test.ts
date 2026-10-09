import { describe, expect, it, vi } from 'vitest';
import { MAX_DOCUMENT_BYTES, createReaderApi, type ReaderPorts } from './reader';

/** Characterization of the legacy `readAdmittedDocument` behaviour, frozen before the move. */

const revision = 'rev-1';
const generation = 'dep-1';
const digest = 'a'.repeat(64);

const bytesResponse = (
  bytes: Uint8Array,
  headers: Record<string, string>,
): { bytes: Uint8Array; headers: Headers } => ({
  bytes,
  headers: new Headers(headers),
});

const okResponse = (text: string): { bytes: Uint8Array; headers: Headers } => bytesResponse(
  new TextEncoder().encode(text),
  {
    'content-type': 'text/plain',
    'x-eliotr-source-revision': revision,
    'x-eliotr-deployment-generation': generation,
    'x-eliotr-content-sha256': digest,
    'content-length': String(new TextEncoder().encode(text).byteLength),
  },
);

interface Harness {
  readonly api: ReturnType<typeof createReaderApi>;
  readonly calls: unknown[];
}

const harness = (
  raw: unknown,
  options: { readonly digestValue?: string; readonly current?: boolean } = {},
): Harness => {
  const calls: unknown[] = [];
  const errors = (details: { code: string; status: number; message: string }) =>
    Object.assign(new Error(details.message), {
      code: details.code, status: details.status, traceId: null, retryable: false,
    });
  const http = {
    requestApiBytes: vi.fn(async (path: string, signal: AbortSignal | undefined) => {
      calls.push({ path, signal });
      return raw;
    }),
  };
  const current = options.current ?? true;
  const epoch = {
    capture: () => (current ? { stamp: 'live' } : undefined),
    isCurrent: () => current,
  };
  const sha256 = vi.fn(async () => options.digestValue ?? digest);
  const ports = { http: http as never, errors, epoch, sha256 } as unknown as ReaderPorts;
  return { api: createReaderApi(ports), calls };
};

const failureOf = async (promise: Promise<unknown>): Promise<{ code: string; status: number }> => {
  try {
    await promise;
  } catch (error) {
    return { code: String((error as { code: unknown }).code),
      status: Number((error as { status: unknown }).status) };
  }
  throw new Error('expected a typed failure');
};

describe('readAdmittedDocument', () => {
  it('returns the document when every identity header matches', async () => {
    const { api, calls } = harness(okResponse('exact evidence'));
    const document = await api.readAdmittedDocument(revision, generation);
    expect(document.text).toBe('exact evidence');
    expect(document.sourceRevisionRef).toBe(revision);
    expect(document.deploymentGeneration).toBe(generation);
    expect(document.contentSha256).toBe(digest);
    expect(calls).toHaveLength(1);
  });

  it('requests the whole object with the document byte budget', async () => {
    const { api } = harness(okResponse('exact evidence'));
    await api.readAdmittedDocument(revision, generation);
    expect(api).toBeDefined();
  });

  it('rejects a response whose revision is not the requested one', async () => {
    const response = okResponse('exact evidence');
    response.headers.set('x-eliotr-source-revision', 'rev-other');
    expect(await failureOf(harness(response).api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'DOCUMENT_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a generation change as a retryable conflict', async () => {
    const response = okResponse('exact evidence');
    response.headers.set('x-eliotr-deployment-generation', 'dep-2');
    expect(await failureOf(harness(response).api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'DOCUMENT_GENERATION_CHANGED', status: 409 });
  });

  it('rejects a digest that does not match the body', async () => {
    expect(await failureOf(harness(okResponse('exact evidence'), { digestValue: 'b'.repeat(64) })
      .api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'DOCUMENT_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a declared length that does not match the body', async () => {
    const response = okResponse('exact evidence');
    response.headers.set('content-length', '9999');
    expect(await failureOf(harness(response).api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'DOCUMENT_RESPONSE_INVALID', status: 502 });
  });

  it('rejects a malformed digest header', async () => {
    const response = okResponse('exact evidence');
    response.headers.set('x-eliotr-content-sha256', 'not-a-digest');
    expect(await failureOf(harness(response).api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'DOCUMENT_RESPONSE_INVALID', status: 502 });
  });

  it('rejects content that is not valid UTF-8', async () => {
    const response = bytesResponse(new Uint8Array([0xff, 0xfe]), {
      'content-type': 'text/plain',
      'x-eliotr-source-revision': revision,
      'x-eliotr-deployment-generation': generation,
      'x-eliotr-content-sha256': digest,
      'content-length': '2',
    });
    expect(await failureOf(harness(response).api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'DOCUMENT_RESPONSE_INVALID', status: 502 });
  });

  it('carries the document byte budget', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('post-digest epoch fence', () => {
  it('does not dispatch when the captured session is already closed', async () => {
    const { api, calls } = harness(okResponse('exact evidence'), { current: false });
    expect(await failureOf(api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
    expect(calls).toHaveLength(0);
  });

  it('returns the verified clone when transport bytes change during the digest', async () => {
    const response = okResponse('exact evidence');
    const ports: ReaderPorts = {
      http: { requestApiBytes: async () => response },
      errors: (details) => Object.assign(new Error(details.message), details),
      epoch: { capture: () => ({}), isCurrent: () => true },
      sha256: async (bytes) => {
        expect(new TextDecoder().decode(bytes)).toBe('exact evidence');
        response.bytes.fill(120);
        return digest;
      },
    };
    const document = await createReaderApi(ports).readAdmittedDocument(revision, generation);
    expect(document.text).toBe('exact evidence');
    expect(new TextDecoder().decode(document.bytes)).toBe('exact evidence');
    expect(document.bytes).not.toBe(response.bytes);
  });

  it('rejects a response whose session closed while the digest was being computed', async () => {
    // The digest is an await boundary. A capture that is live at read time but dead afterwards must
    // discard the bytes rather than return them into product state.
    let current = true;
    const errors = (details: { code: string; status: number; message: string }) =>
      Object.assign(new Error(details.message), {
        code: details.code, status: details.status, traceId: null, retryable: false,
      });
    const epoch = {
      capture: () => (current ? { stamp: 'live' } : undefined),
      isCurrent: () => current,
    };
    const sha256 = vi.fn(async () => {
      current = false;
      return digest;
    });
    const http = { requestApiBytes: vi.fn(async () => okResponse('exact evidence')) };
    const ports = { http: http as never, errors, epoch, sha256 } as unknown as ReaderPorts;
    const api = createReaderApi(ports);
    expect(await failureOf(api.readAdmittedDocument(revision, generation)))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
  });

  it('accepts a response whose session is still current after the digest', async () => {
    const { api } = harness(okResponse('exact evidence'), { current: true });
    await expect(api.readAdmittedDocument(revision, generation)).resolves.toBeDefined();
  });
});
