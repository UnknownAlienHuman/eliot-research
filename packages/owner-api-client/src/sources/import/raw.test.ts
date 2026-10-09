import { describe, expect, it, vi } from 'vitest';
import { createRawFileApi, RAW_FILE_MAX_BYTES } from './raw';
import { createOwnerApiClient } from '../../transport/client';
import { createLegacyHttpAdapter, type LegacyErrorDetails } from '../../legacy/http';
import { createSessionEpoch } from '../../transport/session/epoch';
import type { RawMarkdownConversionRequest } from '@eliotr/contracts';

class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(details: LegacyErrorDetails) { super(details.message); this.status = details.status; this.code = details.code; }
}
const errors = (details: LegacyErrorDetails) => new RequestError(details);
const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer))].map(value => value.toString(16).padStart(2, '0')).join('');
const now = '2026-10-09T12:00:00.000Z';
const captureId = `raw-capture-${'c'.repeat(48)}`;
const operationId = 'd'.repeat(64);
const bytes = new TextEncoder().encode('research source');
const file = { name: 'research.txt', size: bytes.length, type: 'text/plain', arrayBuffer: async () => new Uint8Array(bytes).buffer };
const captureFor = async (key = `raw-upload-${'a'.repeat(64)}`) => ({
  protocol: 'eliotr.raw-file-capture.v1' as const, disposition: 'CAPTURED' as const,
  capture_id: captureId, idempotency_key: key, original_file_name: file.name,
  content_sha256: await digest(bytes), size_bytes: bytes.length, content_type: file.type, captured_at: now,
});
const envelope = (data: unknown, generation = 'deploy-1') => ({ data, trace_id: 'trace-1', deployment_generation: generation });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function setup(reply: (path: string, init: RequestInit) => Promise<Response> = async () => response({})) {
  const epoch = createSessionEpoch();
  const transport = vi.fn<typeof fetch>(async (input, init) => reply(String(input), init ?? {}));
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const ports = { fetch: transport, timers, epoch, baseUrl: 'https://owner.example/' };
  const binary = createOwnerApiClient(ports);
  const http = createLegacyHttpAdapter(ports, errors);
  const api = createRawFileApi(binary, http, { digest }, errors, epoch, (value): value is RequestError => value instanceof RequestError);
  return { api, epoch, transport, binary, http };
}
const selected: RawMarkdownConversionRequest = {
  idempotency_key: `raw-markdown-${'b'.repeat(64)}`, max_output_bytes: 3210,
  max_tokens: 200, timeout_ms: 1000, conversion_options: { output: { format: 'text' } },
};
describe('raw capture, explicit conversion and recovery through the real transport', () => {
  it('retains the original namespace/version identity derivation', async () => {
    const { api } = setup();
    const selection = await api.prepareRawFileSelection(file, undefined, 'namespace-1', { target_source_id: 'source-1', expected_head_revision_ref: 'revision-1' });
    const original = await digest(new TextEncoder().encode(`eliotr.raw-file-upload.v1\0${file.name}\0${await digest(bytes)}\0${file.type}`));
    const namespace = await digest(new TextEncoder().encode(JSON.stringify(['eliotr.raw-file-upload.namespace.v1', 'namespace-1', `raw-upload-${original}`])));
    const version = await digest(new TextEncoder().encode(JSON.stringify(['eliotr.raw-file-upload.version.v1', 'source-1', 'revision-1', `raw-upload-${namespace}`])));
    expect(selection.idempotency_key).toBe(`raw-upload-${version}`);
    expect(selection.bytes).toEqual(bytes);
  });
  it('uses bounded binary upload with the original identity and CSRF headers', async () => {
    let actualBody: BodyInit | null | undefined;
    let actualHeaders = new Headers();
    const { api } = setup(async (_path, init) => {
      actualBody = init.body; actualHeaders = new Headers(init.headers);
      return response(envelope(await captureFor(actualHeaders.get('idempotency-key') ?? undefined)));
    });
    const selection = await api.prepareRawFileSelection(file);
    expect(await api.captureRawFile(selection, 'deploy-1')).toEqual(await captureFor(selection.idempotency_key));
    expect(actualBody).toEqual(bytes);
    expect(actualHeaders.get('x-eliotr-csrf')).toBe('1');
    expect(actualHeaders.get('content-type')).toBe('text/plain');
    expect(actualHeaders.get('x-eliotr-content-sha256')).toBe(await digest(bytes));
  });
  it('rejects selected bytes changed before capture without dispatch', async () => {
    const { api, transport } = setup();
    const selection = await api.prepareRawFileSelection(file);
    selection.bytes[0] = 0;
    await expect(api.captureRawFile(selection, 'deploy-1')).rejects.toMatchObject({ code: 'RAW_FILE_INPUT_INVALID' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects oversize raw file before reading or dispatching', async () => {
    const { api, transport } = setup();
    const read = vi.fn(file.arrayBuffer);
    await expect(api.prepareRawFileSelection({ ...file, size: RAW_FILE_MAX_BYTES + 1, arrayBuffer: read })).rejects.toMatchObject({ code: 'RAW_FILE_INPUT_INVALID' });
    expect(read).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it('requires a caller-selected conversion request without minting or dispatch', async () => {
    const { api, transport } = setup();
    await expect(api.convertRawFileToMarkdown(await captureFor(), undefined as unknown as RawMarkdownConversionRequest, 'deploy-1')).rejects.toMatchObject({ code: 'RAW_MARKDOWN_INPUT_INVALID' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('sends the exact selected conversion bounds/options and preserves operation identity', async () => {
    let body: unknown;
    const capture = await captureFor();
    const { api, transport } = setup(async (_path, init) => {
      body = JSON.parse(String(init.body));
      return response(envelope({ protocol: 'eliotr.raw-markdown-conversion.v1', state: 'STARTED', operation_id: operationId, capture_id: capture.capture_id, content_sha256: capture.content_sha256 }));
    });
    const result = await api.convertRawFileToMarkdown(capture, selected, 'deploy-1');
    expect(body).toEqual(selected); expect(result.operation_id).toBe(operationId); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign conversion capture identity', async () => {
    const capture = await captureFor();
    const { api } = setup(async () => response(envelope({ protocol: 'eliotr.raw-markdown-conversion.v1', state: 'STARTED', operation_id: operationId, capture_id: `raw-capture-${'e'.repeat(48)}`, content_sha256: capture.content_sha256 })));
    await expect(api.convertRawFileToMarkdown(capture, selected, 'deploy-1')).rejects.toMatchObject({ code: 'RAW_MARKDOWN_RESPONSE_INVALID' });
  });
  it('discards raw receipt from a foreign deployment', async () => {
    const capture = await captureFor();
    const { api } = setup(async () => response(envelope(capture, 'deploy-2')));
    await expect(api.readRawFileByIdempotency({ ...capture, bytes }, 'deploy-1')).rejects.toMatchObject({ code: 'API_GENERATION_MISMATCH' });
  });
  it('returns null only for a real typed 404 response', async () => {
    const { api } = setup(async () => response({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND', trace_id: 'trace-1', retryable: false }, 404));
    expect(await api.readRawFileByIdempotency({ ...await captureFor(), bytes }, 'deploy-1')).toBeNull();
  });
  it('does not accept a duck-typed 404 thrown by a foreign collaborator', async () => {
    const epoch = createSessionEpoch();
    const foreign = { status: 404, code: 'NOT_FOUND' };
    const api = createRawFileApi({ requestBinaryJson: async () => ({}) }, { requestApi: async () => { throw foreign; } }, { digest }, errors, epoch, (value): value is RequestError => value instanceof RequestError);
    await expect(api.readRawFileByIdempotency({ ...await captureFor(), bytes }, 'deploy-1')).rejects.toBe(foreign);
  });
  it('rejects closed epoch before file reading and HTTP dispatch', async () => {
    const { api, epoch, transport } = setup(); epoch.close();
    const read = vi.fn(file.arrayBuffer);
    await expect(api.prepareRawFileSelection({ ...file, arrayBuffer: read })).rejects.toMatchObject({ code: 'API_SESSION_CLOSED' });
    expect(read).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  });
  it('rejects late file bytes from an old epoch', async () => {
    const { api, epoch } = setup();
    let finish!: (value: ArrayBuffer) => void;
    const pending = api.prepareRawFileSelection({ ...file, arrayBuffer: () => new Promise(resolve => { finish = resolve; }) });
    epoch.advance(); finish(new Uint8Array(bytes).buffer);
    await expect(pending).rejects.toMatchObject({ code: 'API_SESSION_CLOSED' });
  });
  it('keeps STARTED conversion separate from admission without requests', async () => {
    const { api, transport } = setup();
    const capture = await captureFor();
    await expect(api.admitRawFileToLibrary(capture, { protocol: 'eliotr.raw-markdown-conversion.v1', state: 'STARTED', operation_id: operationId, capture_id: captureId, content_sha256: capture.content_sha256 }, 'deploy-1')).rejects.toMatchObject({ code: 'RAW_MARKDOWN_NOT_COMPLETE' });
    expect(transport).not.toHaveBeenCalled();
  });
});
