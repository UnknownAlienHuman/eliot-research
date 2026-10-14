import { describe, expect, it, vi } from 'vitest';
import { MAX_CHUNKS, readBoundedBody, readJsonBody, readWholeObject, readObjectRange, isStrongValidator } from './body';

const response = (body: BodyInit, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });
const range = (headers: Record<string, string> = {}, body = 'abcde') => response(body, 206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-4/100', etag: '"revision-a"', ...headers });
const policy = { requestedStart: 0, requestedEnd: 4, expectedTotal: 100, expectedETag: '"revision-a"', expectedContentType: 'text/plain' };

describe('bounded response consumers', () => {
  it('rejects oversized declarations and wrong media before acquiring a reader', async () => {
    const oversized = response('short', 200, { 'content-length': '1000' });
    await expect(readBoundedBody(oversized, 100)).rejects.toMatchObject({ code: 'API_RESPONSE_TOO_LARGE' });
    expect(oversized.bodyUsed).toBe(false);
    const html = response('<html>login</html>', 200, { 'content-type': 'text/html' });
    await expect(readJsonBody(html)).rejects.toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH' });
    expect(html.bodyUsed).toBe(false);
  });
  it('bounds understated declarations and chunk count authoritatively', async () => {
    await expect(readBoundedBody(response('x'.repeat(101), 200, { 'content-length': '1' }), 100)).rejects.toMatchObject({ code: 'API_RESPONSE_TOO_LARGE' });
    const chunks = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i <= MAX_CHUNKS; i++) controller.enqueue(new Uint8Array(0)); controller.close(); } });
    await expect(readBoundedBody(response(chunks), 100)).rejects.toMatchObject({ code: 'API_RESPONSE_TOO_LARGE' });
    for (const limit of [0, -1, NaN, Infinity, 1.5, 8 * 1024 * 1024 + 1]) await expect(readBoundedBody(response('x'), limit)).rejects.toMatchObject({ code: 'API_BODY_BUDGET_INVALID' });
  });
  it('an abort settles a pending hostile read/cancel, keeps its cause and removes its listener', async () => {
    const controller = new AbortController();
    const cause = new Error('caller stopped');
    const removal = vi.spyOn(controller.signal, 'removeEventListener');
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
    const input = response(stream);
    const reading = readBoundedBody(input, 100, controller.signal);
    const assertion = expect(reading).rejects.toMatchObject({ code: 'API_REQUEST_ABORTED', cause });
    controller.abort(cause);
    await assertion;
    expect(input.body?.locked).toBe(false);
    expect(removal).toHaveBeenCalledWith('abort', expect.any(Function));
    removal.mockRestore();
  });
  it('stream failure retains cause and a distinct body interruption code', async () => {
    const cause = new Error('stream failed');
    const input = response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(cause); } }));
    await expect(readBoundedBody(input, 100)).rejects.toMatchObject({ code: 'API_BODY_INTERRUPTED', cause });
    expect(input.body?.locked).toBe(false);
  });
  it('JSON uses fatal UTF8 and finite explicit completion statuses', async () => {
    expect(await readJsonBody(response('{"ready":true}'))).toEqual({ ready: true });
    await expect(readJsonBody(response(new Uint8Array([0xff])))).rejects.toMatchObject({ code: 'MALFORMED_JSON_RESPONSE' });
    await expect(readJsonBody(response('{}', 201))).rejects.toMatchObject({ code: 'API_STATUS_INVALID' });
    expect(await readJsonBody(response('{}', 201), undefined, 100, [201])).toEqual({});
  });
  it('whole and partial representations cannot substitute for one another', async () => {
    const partial = range();
    await expect(readWholeObject(partial, { expectedContentType: 'text/plain' })).rejects.toMatchObject({ code: 'API_STATUS_INVALID' });
    expect(partial.bodyUsed).toBe(false);
    await expect(readObjectRange(response('abcde', 200, { 'content-type': 'text/plain' }), policy)).rejects.toMatchObject({ code: 'API_STATUS_INVALID' });
    expect(new TextDecoder().decode((await readWholeObject(response('abcde'), { expectedContentType: 'application/json' })).bytes)).toBe('abcde');
  });
  it('reads exact single coordinates including the legitimate Content-Range space', async () => {
    expect(new TextDecoder().decode((await readObjectRange(range(), policy)).bytes)).toBe('abcde');
  });
  it.each([
    [{ 'content-range': 'bytes 5-9/100' }, 'abcde', 'API_RANGE_MISMATCH'],
    [{ 'content-range': 'bytes 0-4/4' }, 'abcde', 'API_RANGE_MISMATCH'],
    [{ 'content-range': 'bytes 0-4/200' }, 'abcde', 'API_RANGE_MISMATCH'],
    [{ 'content-range': 'bytes 0-4/*' }, 'abcde', 'API_RESPONSE_SCHEMA_MISMATCH'],
    [{ 'content-range': 'bytes 0-4/9007199254740992' }, 'abcde', 'API_RANGE_MISMATCH'],
    [{ etag: 'W/"revision-a"' }, 'abcde', 'API_VALIDATOR_INVALID'],
    [{ etag: '"revision-b"' }, 'abcde', 'API_VALIDATOR_MISMATCH'],
    [{ 'content-encoding': 'gzip' }, 'abcde', 'API_RESPONSE_TRANSFORMED'],
    [{ 'content-type': 'multipart/byteranges; boundary=x' }, 'abcde', 'API_RESPONSE_SCHEMA_MISMATCH'],
    [{}, 'abc', 'API_RANGE_MISMATCH'],
  ] as const)('rejects changed or ambiguous admitted representation %#', async (headers, body, code) => {
    await expect(readObjectRange(range(headers, body), policy)).rejects.toMatchObject({ code });
  });
  it('rejects an invalid requested range and weak/unquoted/list validators', async () => {
    await expect(readObjectRange(range(), { ...policy, requestedStart: 9 })).rejects.toMatchObject({ code: 'API_RANGE_INVALID' });
    expect(isStrongValidator('"revision-a"')).toBe(true);
    for (const tag of ['W/"a"', 'a', '"a","b"', '""', '"a"b"']) expect(isStrongValidator(tag)).toBe(false);
  });
});

/**
 * A producer may reuse or alias one buffer across reads, so every chunk this reader
 * admits is snapshotted before the next read can mutate bytes it already accepted.
 */
describe('admitted chunk snapshots', () => {
  /** Chunks A then B: one reused Uint8Array, mutated on the read that follows its admission. */
  const reusingProducer = () => {
    const shared = new Uint8Array(1);
    let step = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 2) { controller.close(); return; }
        shared[0] = 65 + step++;
        controller.enqueue(shared);
      },
    });
  };
  /** Chunks C then D: a real Buffer, which is a Uint8Array subclass that also reuses its allocation. */
  const bufferSubclassProducer = () => {
    const shared = (globalThis as { Buffer?: { allocUnsafe(length: number): Uint8Array } }).Buffer?.allocUnsafe(1);
    if (!shared) throw new Error('Buffer is unavailable for the reused-buffer subclass case');
    let step = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 2) { controller.close(); return; }
        shared[0] = 67 + step++;
        controller.enqueue(shared);
      },
    });
  };
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const exactPolicy = { requestedStart: 0, requestedEnd: 1, expectedTotal: 2, expectedETag: '"revision-a"', expectedContentType: 'text/plain' };

  it('snapshots a reused Uint8Array before the next read mutates it', async () => {
    expect(decode(await readBoundedBody(response(reusingProducer()), 8))).toBe('AB');
  });
  it('snapshots a reused Buffer-subclass chunk before the next read mutates it', async () => {
    expect(decode(await readBoundedBody(response(bufferSubclassProducer()), 8))).toBe('CD');
  });
  it('an exact-range consumer keeps snapshots after representation and length guards pass', async () => {
    const partial = response(reusingProducer(), 206, { 'content-type': 'text/plain', 'content-range': 'bytes 0-1/2', etag: '"revision-a"' });
    expect(decode((await readObjectRange(partial, exactPolicy)).bytes)).toBe('AB');
  });
  it('rejects a non-byte chunk with a bounded client error and releases the reader', async () => {
    const hostile = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue('text' as unknown as Uint8Array); controller.close(); } });
    await expect(readBoundedBody(response(hostile), 8)).rejects.toMatchObject({ code: 'API_RESPONSE_SCHEMA_MISMATCH' });
    expect(hostile.locked).toBe(false);
  });
});
