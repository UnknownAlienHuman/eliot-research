import { backupSha256Hex } from "./shared.js";

// ER-34 O2 FIX2 R2-conformance harness (test support, not product authority).
//
// Direct `miniflare` import is not permitted by repo infra: no declared
// dependency exists for packages/backup-o2, the workspace lockfile is owned
// outside ER-34, and offline determinism forbids ad-hoc installs. This harness
// is therefore a byte-exact, R2-semantics-faithful local adapter driven through
// the PRODUCTION inventory path (`snapshotBackupR2Bucket`): opaque pagination
// cursors, per-put etag/version minting, httpMetadata + customMetadata
// tracking, list/get race hooks, mutation+rollback (re-put), missing version,
// metadata drift and read faults. A workerd-backed R2 run remains a follow-up
// outside this lane; every behavior asserted here executes production code.

export interface ConformantStoredObject {
  bytes: Uint8Array;
  etag: string;
  version: string;
  customMetadata: Record<string, string>;
  httpMetadata: Record<string, string>;
}

export interface ConformanceFaults {
  readonly duplicate_first_key_on_next_page?: boolean;
  readonly vanish_on_get?: ReadonlySet<string>;
  readonly truncate_on_get?: ReadonlySet<string>;
  readonly drop_version_on_get?: ReadonlySet<string>;
  readonly drift_http_metadata_on_get?: ReadonlySet<string>;
  readonly stall_cursor_once?: boolean;
}

export interface ConformanceBucket {
  readonly bucket: R2Bucket;
  readonly objects: Map<string, ConformantStoredObject>;
  putObject(key: string, bytes: Uint8Array, metadata?: { readonly custom?: Record<string, string>; readonly http?: Record<string, string> }): Promise<void>;
  mutateBetweenListAndGet(key: string, mutate: (stored: ConformantStoredObject) => void): void;
}

function encodeCursor(offset: number): string {
  return `conformance-cursor-${offset.toString(36)}`;
}

function decodeCursor(cursor: string): number {
  const match = /^conformance-cursor-([0-9a-z]+)$/u.exec(cursor);
  if (match?.[1] === undefined) throw new Error(`malformed opaque pagination cursor: ${cursor}`);
  return Number.parseInt(match[1], 36);
}

export function createConformantR2Bucket(faults: ConformanceFaults = {}): ConformanceBucket {
  const objects = new Map<string, ConformantStoredObject>();
  const racers = new Map<string, (stored: ConformantStoredObject) => void>();
  let sequence = 0;
  let listCalls = 0;
  let stallRepeats = 0;
  const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice()); c.close(); } });
  const describe = (key: string, stored: ConformantStoredObject): Record<string, unknown> => ({
    key,
    size: stored.bytes.byteLength,
    etag: stored.etag,
    version: stored.version,
    customMetadata: { ...stored.customMetadata },
    httpMetadata: { ...stored.httpMetadata },
  });
  const bucket = {
    async head(key: string) {
      const stored = objects.get(key);
      return stored === undefined ? null : describe(key, stored);
    },
    async get(key: string) {
      const racer = racers.get(key);
      if (racer !== undefined) {
        const stored = objects.get(key);
        if (stored !== undefined) racer(stored);
      }
      if (faults.vanish_on_get?.has(key) === true) return null;
      const stored = objects.get(key);
      if (stored === undefined) return null;
      const body = faults.truncate_on_get?.has(key) === true
        ? stored.bytes.slice(0, Math.max(0, stored.bytes.byteLength - 1))
        : stored.bytes;
      const http = faults.drift_http_metadata_on_get?.has(key) === true
        ? { ...stored.httpMetadata, contentType: "application/x-drifted" }
        : { ...stored.httpMetadata };
      const versioned = faults.drop_version_on_get?.has(key) === true
        ? { key, size: stored.bytes.byteLength, etag: stored.etag, customMetadata: { ...stored.customMetadata }, httpMetadata: http }
        : { ...describe(key, stored), httpMetadata: http };
      const frozen = body.slice();
      return {
        ...versioned,
        size: stored.bytes.byteLength,
        body: streamOf(body),
        bytes: async () => frozen.slice(),
        text: async () => new TextDecoder().decode(frozen),
        arrayBuffer: async () => { const cp = new Uint8Array(frozen.byteLength); cp.set(frozen); return cp.buffer; },
      };
    },
    async put(key: string, value: Uint8Array | ReadableStream<Uint8Array> | string, options?: Record<string, unknown>) {
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value as ReadableStream<Uint8Array>).arrayBuffer());
      const custom = (options?.["customMetadata"] as Record<string, string> | undefined) ?? {};
      const http = (options?.["httpMetadata"] as Record<string, string> | undefined) ?? {};
      const expectSha = options?.["sha256"];
      if (typeof expectSha === "string" && await backupSha256Hex(bytes) !== expectSha) throw new Error("checksum mismatch");
      // Every put mints fresh etag/version even for identical bytes, exactly
      // like R2: a re-put (mutation+rollback) is observable downstream.
      sequence += 1;
      objects.set(key, { bytes, etag: `etag-${sequence}`, version: `version-${sequence}`, customMetadata: { ...custom }, httpMetadata: { ...http } });
      return { key, size: bytes.byteLength, etag: `etag-${sequence}`, version: `version-${sequence}` };
    },
    async delete(input: string | string[]) {
      for (const key of typeof input === "string" ? [input] : input) objects.delete(key);
    },
    async list(options?: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string }) {
      listCalls += 1;
      const start = options?.cursor === undefined ? 0 : decodeCursor(options.cursor);
      const keys = [...objects.keys()].filter((k) => k.startsWith(options?.prefix ?? "")).sort();
      const pageSize = options?.limit ?? 1000;
      const page = keys.slice(start, start + pageSize);
      const next = start + pageSize;
      const listed = page.map((k) => describe(k, objects.get(k) as ConformantStoredObject));
      // Duplicate-key page: the second page re-lists the first key, exactly
      // the pagination duplication production code must refuse.
      if (faults.duplicate_first_key_on_next_page === true && listCalls === 2 && keys.length > 0) {
        listed.push(describe(keys[0] as string, objects.get(keys[0] as string) as ConformantStoredObject));
      }
      if (next < keys.length) {
        // Stalled cursor: repeat the inbound cursor once, so the next
        // truncated response carries a cursor equal to the previous one.
        if (faults.stall_cursor_once === true && stallRepeats < 1 && listCalls >= 2) {
          stallRepeats += 1;
          return { objects: listed, truncated: true, cursor: options?.cursor, delimitedPrefixes: [] };
        }
        return { objects: listed, truncated: true, cursor: encodeCursor(next), delimitedPrefixes: [] };
      }
      return { objects: listed, truncated: false, delimitedPrefixes: [] };
    },
  };
  return {
    bucket: bucket as unknown as R2Bucket,
    objects,
    async putObject(key, bytes, metadata) {
      await (bucket.put as (k: string, v: Uint8Array, o: unknown) => Promise<unknown>)(key, bytes, {
        customMetadata: metadata?.custom ?? {},
        httpMetadata: metadata?.http ?? { contentType: "application/octet-stream" },
      });
    },
    mutateBetweenListAndGet(key, mutate) {
      racers.set(key, mutate);
    },
  };
}
