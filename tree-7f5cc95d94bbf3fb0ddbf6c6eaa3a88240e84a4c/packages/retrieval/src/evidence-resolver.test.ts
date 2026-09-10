import { describe, expect, it } from "vitest";
import {
  verifyPinnedExactEvidence,
  type PinnedSourceAuthority,
  type VerifyPinnedExactInput,
} from "./evidence-resolver.js";
import type { EvidenceHandle, ScopeSnapshot } from "@eliotr/contracts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function shaHex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const hex64 = (seed: string): string => seed.repeat(64).slice(0, 64);

function scopeFixture(): ScopeSnapshot {
  return {
    snapshot_id: "scope-1",
    revision: 1,
    resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
    participant_generations: { library: "library-1" },
    member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "generation-1" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: hex64("b"),
    purge_ledger_revision: 1,
    digest: hex64("c"),
    created_at: "2026-08-31T21:00:00.000Z",
    expires_at: "2026-09-30T21:00:00.000Z",
  };
}

function sourceFixture(contentSha: string): PinnedSourceAuthority {
  return {
    source_revision_ref: "revision-1",
    source_namespace_id: "namespace-1",
    source_owner_generation: "generation-1",
    content_sha256: contentSha,
    object_residency_key_digest: hex64("d"),
    purge_state: "LIVE",
  };
}

async function handleFixture(
  fullText: string,
  anchor: EvidenceHandle["anchor"],
  overrides: Partial<EvidenceHandle> = {},
): Promise<{ handle: EvidenceHandle; excerpt: string; fullBytes: Uint8Array }> {
  const fullBytes = encode(fullText);
  let excerpt: string;
  if (anchor.kind === "normalized_byte_range") {
    excerpt = new TextDecoder("utf-8", { fatal: true }).decode(fullBytes.slice(anchor.start, anchor.end));
  } else if (anchor.kind === "normalized_line_range") {
    const lines = fullText.split(/(?<=\n)/u);
    excerpt = lines.slice(anchor.start_line - 1, anchor.end_line).join("");
  } else {
    excerpt = fullText;
  }
  const excerptBytes = encode(excerpt);
  const handle: EvidenceHandle = {
    handle_ref: { id: "evidence-1", revision: 1 },
    source_namespace_id: "namespace-1",
    source_owner_generation: "generation-1",
    source_revision_ref: "revision-1",
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    anchor,
    excerpt_sha256: await shaHex(excerptBytes),
    excerpt_byte_length: excerptBytes.byteLength,
    object_residency_key_digest: hex64("d"),
    source_assurance_ceiling: "QUALIFIED",
    materializer_assurance_ceiling: "EXACT",
    terminal_state: "LIVE",
    created_at: "2026-08-31T22:00:00.000Z",
    ...overrides,
  };
  return { handle, excerpt, fullBytes };
}

async function baseInput(
  fullText: string,
  anchor: EvidenceHandle["anchor"],
  overrides: Partial<VerifyPinnedExactInput> = {},
): Promise<VerifyPinnedExactInput> {
  const { handle, excerpt, fullBytes } = await handleFixture(fullText, anchor);
  const contentSha = await shaHex(fullBytes);
  return {
    handle,
    scope: scopeFixture(),
    source: sourceFixture(contentSha),
    materialized: {
      exact_excerpt: excerpt,
      excerpt_sha256: await shaHex(encode(excerpt)),
      excerpt_byte_length: encode(excerpt).byteLength,
      source_object_size: fullBytes.byteLength,
      source_object_sha256: contentSha,
    },
    pinned_object_bytes: fullBytes,
    ...overrides,
  };
}

async function rejectsWith(input: Promise<unknown>, code: string): Promise<void> {
  await expect(input).rejects.toMatchObject({ name: "ExactVerificationError", code });
}

describe("ER-07 Q2 pinned exact verification", () => {
  it("verifies a byte-range excerpt, its probe offsets and a reused receipt", async () => {
    const input = await baseInput("alpha needle beta", { kind: "normalized_byte_range", start: 0, end: 16 }, {
      exact_probes: ["needle"],
      prior_receipts: [{
        handle_id: "evidence-1",
        handle_revision: 1,
        excerpt_sha256: "",
        scope_snapshot_digest: hex64("c"),
        receipt_digest: hex64("e"),
      }],
    });
    const receipt = input.prior_receipts?.[0];
    if (receipt === undefined) throw new Error("receipt fixture missing");
    const fixed = {
      ...input,
      prior_receipts: [{ ...receipt, excerpt_sha256: input.materialized.excerpt_sha256 }],
    };
    const verified = await verifyPinnedExactEvidence(fixed);
    expect(verified.anchor_byte_range).toEqual({ start: 0, end: 16 });
    expect(verified.probe_matches).toHaveLength(1);
    // "alpha " is 6 ASCII bytes, so the literal starts at byte offset 6.
    expect(verified.probe_matches[0]?.byte_offsets).toEqual([6]);
    expect(verified.reused_receipt_digest).toBe(hex64("e"));
    expect(verified.scope_snapshot_digest).toBe(hex64("c"));
  });

  it("mandatory negative: mutated bytes mid-resolution are rejected, never substituted", async () => {
    const original = "pinned revision alpha";
    const input = await baseInput(original, { kind: "normalized_byte_range", start: 0, end: 20 });
    const tamperedBytes = encode("current bytes BETA!!!");
    // The store changed under the old handle: the pinned window no longer
    // reproduces the admitted excerpt.
    await rejectsWith(
      verifyPinnedExactEvidence({ ...input, pinned_object_bytes: tamperedBytes }),
      "EXACT_CURRENT_BYTE_SUBSTITUTION",
    );
    // And presenting the new bytes as the admitted revision also fails: the
    // materialized excerpt digest no longer matches the handle.
    const tamperedExcerpt = "current bytes BETA!!!";
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        materialized: {
          ...input.materialized,
          exact_excerpt: tamperedExcerpt,
          excerpt_sha256: await shaHex(encode(tamperedExcerpt)),
          excerpt_byte_length: encode(tamperedExcerpt).byteLength,
        },
      }),
      "EXACT_DIGEST_MISMATCH",
    );
  });

  it("rejects an old revision while the head advances", async () => {
    const input = await baseInput("head one", { kind: "normalized_byte_range", start: 0, end: 8 });
    const headBytes = encode("head two!!");
    const headSha = await shaHex(headBytes);
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        source: { ...input.source, source_revision_ref: "revision-2", content_sha256: headSha },
        materialized: { ...input.materialized, source_object_sha256: headSha },
      }),
      "EXACT_REVISION_MISMATCH",
    );
  });

  it("resolves Unicode line anchors with UTF-8 byte offsets", async () => {
    const text = "﻿Привет\r\n😀\r\nlast";
    const input = await baseInput(text, { kind: "normalized_line_range", start_line: 1, end_line: 2 }, {
      exact_probes: ["😀"],
    });
    const verified = await verifyPinnedExactEvidence(input);
    expect(verified.anchor_byte_range.start).toBe(0);
    expect(verified.anchor_byte_range.end).toBe(input.materialized.excerpt_byte_length);
    const prefixBytes = encode("﻿Привет\r\n");
    expect(verified.probe_matches[0]?.byte_offsets).toEqual([prefixBytes.byteLength]);
  });

  it("resolves table cells through the admitted map; missing maps narrow, corrupt maps fail", async () => {
    const fullText = "cell-A|cell-B";
    const anchor = { kind: "table_cell", table_id: "table-1", row: 0, column: 1 } as const;
    const { handle, fullBytes } = await handleFixture(fullText, anchor, { coordinate_map_ref: "map-1" });
    const contentSha = await shaHex(fullBytes);
    const excerpt = "cell-B";
    const good = {
      handle: { ...handle, excerpt_sha256: await shaHex(encode(excerpt)), excerpt_byte_length: encode(excerpt).byteLength },
      scope: scopeFixture(),
      source: sourceFixture(contentSha),
      materialized: {
        exact_excerpt: excerpt,
        excerpt_sha256: await shaHex(encode(excerpt)),
        excerpt_byte_length: encode(excerpt).byteLength,
        source_object_size: fullBytes.byteLength,
        source_object_sha256: contentSha,
      },
      pinned_object_bytes: fullBytes,
      coordinate_map: { map_ref: "map-1", entries: { "table:table-1:0:1": { start: 7, end: 13 } } },
    };
    const verified = await verifyPinnedExactEvidence(good);
    expect(verified.anchor_byte_range).toEqual({ start: 7, end: 13 });
    await rejectsWith(
      verifyPinnedExactEvidence({ ...good, coordinate_map: null }),
      "EXACT_COORDINATE_MAP_MISSING",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...good,
        coordinate_map: { map_ref: "map-1", entries: { "table:table-1:0:1": { start: 0, end: 10_000_000 } } },
      }),
      "EXACT_RANGE_INVALID",
    );
  });

  it("rejects range, length and digest mismatches", async () => {
    const input = await baseInput("0123456789", { kind: "normalized_byte_range", start: 0, end: 4 });
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        handle: { ...(input.handle as EvidenceHandle), anchor: { kind: "normalized_byte_range", start: 0, end: 999 } },
      }),
      "EXACT_RANGE_INVALID",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        materialized: { ...input.materialized, excerpt_byte_length: input.materialized.excerpt_byte_length + 1 },
      }),
      "EXACT_LENGTH_MISMATCH",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        materialized: { ...input.materialized, excerpt_sha256: hex64("f") },
      }),
      "EXACT_DIGEST_MISMATCH",
    );
  });

  it("rejects forged handles before touching pinned bytes", async () => {
    const input = await baseInput("alpha", { kind: "normalized_byte_range", start: 0, end: 5 });
    await rejectsWith(
      verifyPinnedExactEvidence({ ...input, handle: { forged: true } }),
      "EXACT_FORGED_HANDLE",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({ ...input, handle: { ...(input.handle as EvidenceHandle), anchor: { kind: "nope" } } }),
      "EXACT_FORGED_HANDLE",
    );
  });

  it("fails closed on mid-read revocation and terminal handles", async () => {
    const input = await baseInput("alpha", { kind: "normalized_byte_range", start: 0, end: 5 });
    await rejectsWith(verifyPinnedExactEvidence({ ...input, revoked_mid_read: true }), "EXACT_REVOKED_MID_READ");
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        handle: { ...(input.handle as EvidenceHandle), terminal_state: "STALE", invalidation_ref: "inv-1" },
      }),
      "EXACT_REVOKED_MID_READ",
    );
  });

  it("rejects scope, owner, residency and purge drift", async () => {
    const input = await baseInput("alpha", { kind: "normalized_byte_range", start: 0, end: 5 });
    await rejectsWith(
      verifyPinnedExactEvidence({ ...input, scope: { ...input.scope, snapshot_id: "scope-foreign" } }),
      "EXACT_SCOPE_MISMATCH",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        source: { ...input.source, source_owner_generation: "generation-2" },
      }),
      "EXACT_OWNER_GENERATION_MISMATCH",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({
        ...input,
        source: { ...input.source, object_residency_key_digest: hex64("9") },
      }),
      "EXACT_OWNER_GENERATION_MISMATCH",
    );
    await rejectsWith(
      verifyPinnedExactEvidence({ ...input, source: { ...input.source, purge_state: "REDACTED" } }),
      "EXACT_SOURCE_NOT_LIVE",
    );
  });

  it("runs bounded normalized regex scans and rejects unbounded or invalid patterns", async () => {
    const input = await baseInput("needle needle needle", { kind: "normalized_byte_range", start: 0, end: 20 }, {
      regex_probes: [{ pattern: "needle" }],
    });
    const verified = await verifyPinnedExactEvidence(input);
    expect(verified.regex_matches[0]?.match_count).toBe(3);
    await rejectsWith(
      verifyPinnedExactEvidence({ ...input, regex_probes: [{ pattern: "(" }] }),
      "EXACT_REGEX_INVALID",
    );
    const flood = await baseInput("a".repeat(200), { kind: "normalized_byte_range", start: 0, end: 200 }, {
      regex_probes: [{ pattern: "a" }],
    });
    await rejectsWith(verifyPinnedExactEvidence(flood), "EXACT_REGEX_UNBOUNDED");
  });

  it("requires a reviewed projection table for unsupported tokenizers", async () => {
    const input = await baseInput("alpha beta", { kind: "normalized_byte_range", start: 0, end: 10 }, {
      tokenizer: { id: "native-embedded-v9" },
    });
    await rejectsWith(verifyPinnedExactEvidence(input), "EXACT_TOKENIZER_FALLBACK_REQUIRED");
    const verified = await verifyPinnedExactEvidence({
      ...input,
      reviewed_projection_table: {
        table_ref: "projection-table-7",
        reviewer_ref: "reviewer-1",
        token_byte_ranges: { alpha: [{ start: 0, end: 5 }] },
      },
    });
    expect(verified.tokenizer_fallback_table_ref).toBe("projection-table-7");
  });
});
