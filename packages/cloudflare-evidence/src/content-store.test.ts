/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "vitest";
import { createR2EvidenceContentPort } from "./content-store.js";
import { evidenceSha256Bytes } from "./canonical.js";
import type { EvidenceSourceAuthority } from "./types.js";

const encode = (text: string) => new TextEncoder().encode(text);
const lines = (start_line: number, end_line = start_line) => ({
  kind: "normalized_line_range" as const, start_line, end_line,
});

// Controlled R2 binding; real Web Streams, UTF-8, hashing and production content adapter.
async function fixture(text: string | Uint8Array, chunkSize = 4096) {
  const bytes = typeof text === "string" ? encode(text) : text;
  const sha = await evidenceSha256Bytes(bytes);
  const source = {
    source_id: "source-1", owner_system_id: "owner-1", source_namespace_id: "namespace-1",
    source_owner_generation: "generation-1", source_revision_ref: "revision-1",
    content_sha256: sha, object_residency_key_digest: "b".repeat(64),
    admission_receipt_ref: "admission-1",
  } as EvidenceSourceAuthority;
  const state = {
    gets: [] as { offset: number; length: number }[], heads: 0, cancellations: 0,
    changedGet: 0, changedHead: 0, truncatedGet: 0, invalidMetadataGet: 0,
  };
  function metadata(key: string) {
    return {
      key, version: "v1", etag: "etag-1", httpEtag: '"etag-1"', size: bytes.length,
      checksums: { sha256: Uint8Array.from(sha.match(/../gu) ?? [], (hex) => parseInt(hex, 16)).buffer },
      customMetadata: {
        eliotr_immutable: "true", eliotr_sha256: sha, eliotr_size_bytes: String(bytes.length),
        source_namespace_id: source.source_namespace_id,
        source_owner_generation: source.source_owner_generation,
        admission_receipt_ref: source.admission_receipt_ref,
      },
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    };
  }
  const bucket = {
    async head(key: string) {
      state.heads += 1;
      return { ...metadata(key), version: state.heads === state.changedHead ? "v2" : "v1" };
    },
    async get(key: string, options?: R2GetOptions) {
      const range = options?.range;
      assert.ok(range && !(range instanceof Headers) && "offset" in range);
      assert.ok(typeof range.offset === "number" && typeof range.length === "number");
      const condition = options?.onlyIf;
      assert.ok(condition && !(condition instanceof Headers));
      assert.equal(condition.etagMatches, '"etag-1"');
      state.gets.push({ offset: range.offset, length: range.length });
      const index = state.gets.length;
      const selected = bytes.slice(range.offset, range.offset + range.length - (index === state.truncatedGet ? 1 : 0));
      let cursor = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (cursor === selected.length) { controller.close(); return; }
          controller.enqueue(selected.slice(cursor, cursor + chunkSize));
          cursor = Math.min(cursor + chunkSize, selected.length);
        },
        cancel() { state.cancellations += 1; },
      });
      const object = metadata(key);
      if (index === state.invalidMetadataGet) object.customMetadata.admission_receipt_ref = "foreign";
      return { ...object, version: index === state.changedGet ? "v2" : "v1", range, body };
    },
  } as unknown as R2Bucket;
  return { source, state, port: createR2EvidenceContentPort({ evidence_bucket: bucket }) };
}

// Versioned normalized-line IO vectors; future pure-coordinate parity owner: eliotr-evidence.
const vectors = [
  { text: "one\ntwo\nthree", start: 2, end: 2, expected: "two\n" },
  { text: "one\ntwo\nthree", start: 2, end: 3, expected: "two\nthree" },
  { text: "\ufeffПривет\r\n😀\r\nlast", start: 1, end: 2, expected: "\ufeffПривет\r\n😀\r\n" },
  { text: "first\n\nlast\n", start: 2, end: 2, expected: "\n" },
  { text: "last", start: 1, end: 1, expected: "last" },
];
for (const [index, vector] of vectors.entries()) {
  test(`normalized-line-read.v1 vector ${index}: exact bytes and pinned conditional reread`, async () => {
    const f = await fixture(vector.text, 1);
    const result = await f.port.materialize(f.source, lines(vector.start, vector.end));
    assert.equal(result.exact_excerpt, vector.expected);
    assert.equal(result.excerpt_byte_length, encode(vector.expected).length);
    assert.equal(result.excerpt_sha256, await evidenceSha256Bytes(encode(vector.expected)));
    assert.equal(f.state.gets.length, 2);
    assert.equal(f.state.gets[1]?.length, result.excerpt_byte_length);
    assert.equal(f.state.heads, 2);
  });
}

test("line bounds fail before R2; EOF is not a fabricated empty line", async () => {
  const f = await fixture("line\n");
  for (const anchor of [lines(0), lines(2, 1), lines(1.5), lines(Infinity)]) {
    await assert.rejects(f.port.materialize(f.source, anchor), { code: "EVIDENCE_RANGE_INVALID" });
  }
  assert.equal(f.state.heads, 0);
  await assert.rejects(f.port.materialize(f.source, lines(2)), { code: "EVIDENCE_RANGE_INVALID" });
});

test("line scan cap is a typed limitation, not absence or a partial excerpt", async () => {
  const f = await fixture("x".repeat(4 * 1024 * 1024) + "\nanswer");
  await assert.rejects(f.port.materialize(f.source, lines(2)), { code: "EVIDENCE_PRECISION_UNSUPPORTED" });
  assert.deepEqual(f.state.gets, [{ offset: 0, length: 4 * 1024 * 1024 }]);
});

test("256 KiB excerpt bound accepts the maximum and rejects maximum plus one", async () => {
  for (const size of [256 * 1024, 256 * 1024 + 1]) {
    const f = await fixture("x".repeat(size));
    if (size === 256 * 1024) {
      assert.equal((await f.port.materialize(f.source, lines(1))).excerpt_byte_length, size);
    } else {
      await assert.rejects(f.port.materialize(f.source, lines(1)), { code: "EVIDENCE_RANGE_INVALID" });
      assert.equal(f.state.gets.length, 1);
    }
  }
});

for (const fault of ["changedGet", "changedHead", "truncatedGet"] as const) {
  test(`line read fails closed on ${fault}`, async () => {
    const f = await fixture("first\nsecond");
    f.state[fault] = 2;
    await assert.rejects(f.port.materialize(f.source, lines(2)), { code: "EVIDENCE_SETTLEMENT_UNCERTAIN" });
  });
}

test("invalid metadata cancels the opened body before exposing bytes", async () => {
  const f = await fixture("first\nsecond", 1);
  f.state.invalidMetadataGet = 1;
  await assert.rejects(f.port.materialize(f.source, lines(1)), { code: "EVIDENCE_OBJECT_INTEGRITY" });
  assert.equal(f.state.cancellations, 1);
});

test("byte reads retain BOM, reject negative offsets and reject split UTF-8", async () => {
  const f = await fixture("\ufeff😀\n");
  const result = await f.port.materialize(f.source, { kind: "normalized_byte_range", start: 0, end: 8 });
  assert.equal(result.exact_excerpt, "\ufeff😀\n");
  for (const [start, end] of [[-1, 1], [3, 4]] as const) {
    await assert.rejects(f.port.materialize(f.source, { kind: "normalized_byte_range", start, end }), {
      code: "EVIDENCE_RANGE_INVALID",
    });
  }
});

test("page, table and code anchors do not fall back to normalized lines", async () => {
  const f = await fixture("content");
  for (const anchor of [
    { kind: "page_region", page: 1, bbox: [0, 0, 1, 1] },
    { kind: "table_cell", table_id: "table-1", row: 0, column: 0 },
    { kind: "code_range", commit_sha: "c".repeat(64), path: "file.ts", start_line: 1, end_line: 1 },
  ] as const) {
    await assert.rejects(f.port.materialize(f.source, anchor as Parameters<typeof f.port.materialize>[1]), {
      code: "EVIDENCE_PRECISION_UNSUPPORTED",
    });
  }
  assert.equal(f.state.heads, 0);
});
