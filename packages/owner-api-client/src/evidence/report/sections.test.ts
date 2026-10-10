import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SECTION_BYTES,
  createSectionApi,
  type DeclaredSection,
  type SectionPorts,
} from './sections';

/** Characterization of the legacy section byte read and its manifest fence, frozen before the move. */

const artifactRef = { id: 'art-one', revision: 3 };
const sectionRef = { id: 'sec-one', revision: 7 };
const objectRef = 'obj-one';
const generation = 'dep-1';
const digest = 'a'.repeat(64);
const otherDigest = 'b'.repeat(64);

const body = 'exact report section body';
const bodyBytes = new TextEncoder().encode(body);

const declared: DeclaredSection = {
  section_ref: sectionRef,
  body_object_ref: objectRef,
  body_sha256: digest,
};

const okResponse = (): { bytes: Uint8Array; headers: Headers } => ({
  bytes: bodyBytes.slice(),
  headers: new Headers({
    'content-type': 'application/octet-stream',
    'x-eliotr-artifact-ref': `${artifactRef.id}:${artifactRef.revision}`,
    'x-eliotr-section-ref': `${sectionRef.id}:${sectionRef.revision}`,
    'x-eliotr-section-object-ref': objectRef,
    'x-eliotr-section-sha256': digest,
    'x-eliotr-deployment-generation': generation,
    'content-length': String(bodyBytes.byteLength),
  }),
});

interface Harness {
  readonly api: ReturnType<typeof createSectionApi>;
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
    requestApiBytes: vi.fn(async (path: string, signal: AbortSignal | undefined, maximumBytes: number, contentType: string) => {
      calls.push({ path, signal, maximumBytes, contentType });
      return raw;
    }),
  };
  const current = options.current ?? true;
  const epoch = {
    capture: () => (current ? { stamp: 'live' } : undefined),
    isCurrent: () => current,
  };
  const sha256 = vi.fn(async () => options.digestValue ?? digest);
  const ports = { http: http as never, errors, epoch, sha256 } as unknown as SectionPorts;
  return { api: createSectionApi(ports), calls };
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



describe('readResearchArtifactSection', () => {
  it('rejects non-positive and unsafe artifact or section revisions before either byte seam dispatches', async () => {
    const get = vi.fn<SectionPorts['http']['requestApiBytes']>(), post = vi.fn<SectionPorts['http']['requestReauthorizedSectionBytes']>();
    const sha256 = vi.fn<SectionPorts['sha256']>();
    const api = createSectionApi({ http: { requestApiBytes: get, requestReauthorizedSectionBytes: post }, sha256,
      errors: details => Object.assign(new Error(details.message), details), epoch: { capture: () => ({}), isCurrent: () => true } });
    for (const revision of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      for (const read of [api.readResearchArtifactSection, api.readReauthorizedResearchArtifactSection]) {
        await expect(read({ ...artifactRef, revision }, declared)).rejects.toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID' });
        await expect(read(artifactRef, { ...declared, section_ref: { ...sectionRef, revision } })).rejects.toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID' });
      }
    }
    expect(get).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(sha256).not.toHaveBeenCalled();
  });
  it('returns the verified section when every identity header matches', async () => {
    const { api, calls } = harness(okResponse());
    const response = await api.readResearchArtifactSection(artifactRef, declared, {
      expectedDeploymentGeneration: generation,
    });
    expect(new TextDecoder().decode(response.bytes)).toBe(body);
    expect(response.artifact_ref).toEqual(artifactRef);
    expect(response.section_ref).toEqual(sectionRef);
    expect(response.body_object_ref).toBe(objectRef);
    expect(response.body_sha256).toBe(digest);
    expect(response.size_bytes).toBe(bodyBytes.byteLength);
    expect(calls).toHaveLength(1);
  });

  it('requests the section with the exact report byte budget and media type', async () => {
    const { api, calls } = harness(okResponse());
    await api.readResearchArtifactSection(artifactRef, declared);
    expect(calls).toEqual([{
      path: `/api/v1/research/artifact/${artifactRef.id}%3A${artifactRef.revision}` +
        `/sections/${sectionRef.id}%3A${sectionRef.revision}`,
      signal: undefined,
      maximumBytes: MAX_SECTION_BYTES,
      contentType: 'application/octet-stream',
    }]);
  });

  it('rejects a digest that does not match the body', async () => {
    const { api } = harness(okResponse(), { digestValue: otherDigest });
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('rejects a declared length that does not match the body', async () => {
    const response = okResponse();
    response.headers.set('content-length', '9999');
    const { api } = harness(response);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('rejects a malformed digest header', async () => {
    const response = okResponse();
    response.headers.set('x-eliotr-section-sha256', 'not-a-digest');
    const { api } = harness(response);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('rejects swapped artifact and section header refs', async () => {
    const response = okResponse();
    response.headers.set('x-eliotr-artifact-ref', 'art-other:9');
    const { api } = harness(response);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('rejects a generation change as a retryable conflict', async () => {
    const response = okResponse();
    response.headers.set('x-eliotr-deployment-generation', 'dep-2');
    const { api } = harness(response);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared, {
      expectedDeploymentGeneration: generation,
    }))).toMatchObject({ code: 'RESEARCH_RUN_DEPLOYMENT_CHANGED', status: 409 });
  });

  it('blocks the export when the readback object ref does not match the declared row', async () => {
    // The C3-EM mandatory negative: a failed required section blocks a complete export.
    const mismatch: DeclaredSection = { ...declared, body_object_ref: 'obj-other' };
    const { api } = harness(okResponse());
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, mismatch)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('blocks the export when the declared digest does not match the manifest row', async () => {
    const mismatch: DeclaredSection = { ...declared, body_sha256: otherDigest };
    const { api } = harness(okResponse());
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, mismatch)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('rejects a header carrying a control character', async () => {
    const response = okResponse();
    response.headers.set('x-eliotr-section-object-ref', 'obj\u0001one');
    const { api } = harness(response);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });

  it('carries the exact section byte budget', () => {
    expect(MAX_SECTION_BYTES).toBe(1024 * 1024);
  });

  it('accepts URI-component encoded identity ref headers', async () => {
    // The server encodes the three identity headers; equality is checked after decoding.
    const response = okResponse();
    response.headers.set('x-eliotr-artifact-ref', encodeURIComponent(`${artifactRef.id}:${artifactRef.revision}`));
    response.headers.set('x-eliotr-section-ref', encodeURIComponent(`${sectionRef.id}:${sectionRef.revision}`));
    response.headers.set('x-eliotr-section-object-ref', encodeURIComponent(objectRef));
    const { api } = harness(response);
    const result = await api.readResearchArtifactSection(artifactRef, declared);
    expect(result.artifact_ref).toEqual(artifactRef);
    expect(result.section_ref).toEqual(sectionRef);
    expect(result.body_object_ref).toBe(objectRef);
  });

  it('rejects a malformed percent escape in an identity ref header', async () => {
    // A malformed escape is a typed response failure, never a duck-typed or silent pass.
    const response = okResponse();
    response.headers.set('x-eliotr-artifact-ref', '%E0%A4%A');
    const { api } = harness(response);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });
});

describe('epoch fence', () => {
  it('does not dispatch when the captured session is already closed', async () => {
    const { api, calls } = harness(okResponse(), { current: false });
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
    expect(calls).toHaveLength(0);
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
    const http = { requestApiBytes: vi.fn(async () => okResponse()) };
    const ports = { http: http as never, errors, epoch, sha256 } as unknown as SectionPorts;
    const api = createSectionApi(ports);
    expect(await failureOf(api.readResearchArtifactSection(artifactRef, declared)))
      .toMatchObject({ code: 'API_SESSION_CLOSED', status: 503 });
  });

  it('returns the verified clone when transport bytes change during the digest', async () => {
    const response = okResponse();
    const ports: SectionPorts = {
      http: {
        requestApiBytes: async () => response,
        // This fixture exercises the authorized read only, so the reauthorized seam is unused and
        // fails loudly if it is ever dispatched here.
        requestReauthorizedSectionBytes: async () => {
          throw new Error('the authorized read must not dispatch the reauthorized seam');
        },
      },
      errors: (details) => Object.assign(new Error(details.message), details),
      epoch: { capture: () => ({}), isCurrent: () => true },
      sha256: async (bytes) => {
        expect(new TextDecoder().decode(bytes)).toBe(body);
        response.bytes.fill(120);
        return digest;
      },
    };
    const read = await createSectionApi(ports).readResearchArtifactSection(artifactRef, declared);
    expect(new TextDecoder().decode(read.bytes)).toBe(body);
    expect(read.bytes).not.toBe(response.bytes);
  });
});


describe('readReauthorizedResearchArtifactSection', () => {
  it('uses the reauthorized client seam, not the whole-object GET read', async () => {
    const calls: unknown[] = [];
    const errors = (details: { code: string; status: number; message: string }) =>
      Object.assign(new Error(details.message), {
        code: details.code, status: details.status, traceId: null, retryable: false,
      });
    const http = {
      requestApiBytes: vi.fn(async () => {
        throw new Error('the reauthorized read must not issue a whole-object GET');
      }),
      requestReauthorizedSectionBytes: vi.fn(async (path: string, signal: AbortSignal | undefined) => {
        calls.push({ path, signal });
        return okResponse();
      }),
    };
    const epoch = { capture: () => ({}), isCurrent: () => true };
    const sha256 = vi.fn(async () => digest);
    const ports = { http: http as never, errors, epoch, sha256 } as unknown as SectionPorts;
    const api = createSectionApi(ports);
    const result = await api.readReauthorizedResearchArtifactSection(artifactRef, declared);
    expect(new TextDecoder().decode(result.bytes)).toBe(body);
    expect(result.body_object_ref).toBe(objectRef);
    expect(result.body_sha256).toBe(digest);
    expect(calls).toEqual([{
      path: `/api/v1/research/artifact/${artifactRef.id}%3A${artifactRef.revision}` +
        `/sections/${sectionRef.id}%3A${sectionRef.revision}/reauthorize`,
      signal: undefined,
    }]);
  });

  it('applies the same identity, digest and declared-row fences as the authorized read', async () => {
    const errors = (details: { code: string; status: number; message: string }) =>
      Object.assign(new Error(details.message), {
        code: details.code, status: details.status, traceId: null, retryable: false,
      });
    const ok = (): { bytes: Uint8Array; headers: Headers } => ({
      bytes: bodyBytes.slice(),
      headers: new Headers({
        'content-type': 'application/octet-stream',
        'x-eliotr-artifact-ref': `${artifactRef.id}:${artifactRef.revision}`,
        'x-eliotr-section-ref': `${sectionRef.id}:${sectionRef.revision}`,
        'x-eliotr-section-object-ref': 'obj-other',
        'x-eliotr-section-sha256': digest,
        'content-length': String(bodyBytes.byteLength),
      }),
    });
    const http = { requestApiBytes: vi.fn(async () => okResponse()),
      requestReauthorizedSectionBytes: vi.fn(async () => ok()) };
    const epoch = { capture: () => ({}), isCurrent: () => true };
    const sha256 = vi.fn(async () => digest);
    const ports = { http: http as never, errors, epoch, sha256 } as unknown as SectionPorts;
    expect(await failureOf(
      createSectionApi(ports).readReauthorizedResearchArtifactSection(artifactRef, declared),
    )).toMatchObject({ code: 'RESEARCH_ARTIFACT_SECTION_INVALID', status: 502 });
  });
});
