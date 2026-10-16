import { describe, expect, it } from "vitest";
import type { AllowedReferenceManifest, EvidenceContextBlock, ResolvedEvidence } from "@eliotr/contracts";
import {
  ContextCompilationBlockedError,
  createEvidenceContextCompiler,
  type ContextRequestProjection,
} from "./context-compiler.js";

const NOW = Date.parse("2026-10-16T16:39:00.000Z");
const encoder = new TextEncoder();
const compiler = createEvidenceContextCompiler({ now: () => NOW });
const key = (ref: { readonly id: string; readonly revision: number }) => `${ref.id}:${ref.revision}`;
const bytes = (value: string) => encoder.encode(value).byteLength;

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture evidence");
  return value;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((name) => `${JSON.stringify(name)}:${canonical(record[name])}`).join(",")}}`;
}

async function evidence(id: string, source: string, text = 'quoted α "text" \\\n'.repeat(80)): Promise<ResolvedEvidence> {
  return {
    handle: {
      handle_ref: { id, revision: 1 }, source_namespace_id: `namespace-${source}`,
      source_owner_generation: "owner-1", source_revision_ref: source,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      anchor: { kind: "normalized_byte_range", start: 0, end: bytes(text) },
      excerpt_sha256: await sha256(text), excerpt_byte_length: bytes(text),
      object_residency_key_digest: "a".repeat(64), source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT", terminal_state: "LIVE", created_at: new Date(NOW).toISOString(),
    },
    exact_excerpt: text, source_title: "Same untrusted title for every source",
    verification_receipt_ref: `verification-${id}`, authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1", source_revision_content_sha256: "b".repeat(64),
    scope_snapshot_digest: "c".repeat(64), instruction_taint: "UNTRUSTED", allowed_effects: "READ_ONLY",
    resolved_at: new Date(NOW).toISOString(),
  };
}

async function manifestFor(values: readonly ResolvedEvidence[], sources = [...new Set(values.map((value) => value.handle.source_revision_ref))]): Promise<AllowedReferenceManifest> {
  const payload = {
    manifest_ref: { id: "manifest-1", revision: 1 }, scope_snapshot_ref: { id: "scope-1", revision: 1 },
    allowed_source_revision_refs: sources, allowed_evidence_handle_refs: values.map((value) => value.handle.handle_ref),
    allowed_tool_definition_refs: [], allowed_verifier_refs: [], permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: { policy: "policy-1" }, stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "private", allowed_use: ["research"],
    expires_at: "2026-10-17T00:00:00.000Z", client_fence_ref: "credential-1",
  };
  return { ...payload, manifest_digest: await sha256(canonical(payload)) };
}

function serialize(projection: ContextRequestProjection): string {
  return canonical({
    model: "owner-selected-model", max_tokens: 100, stream: false,
    messages: [
      { role: "system", content: projection.system_instructions.join("\n") },
      { role: "user", content: canonical({ wrapper: 'server "wrapper" \\ α', blocks: projection.blocks,
        manifest_ref: projection.manifest_ref, selection_receipt: projection.selection_receipt,
        system_instructions: projection.system_instructions }) },
    ],
  });
}

// Receipt digest characters have fixed UTF-8 width. Measure the complete desired
// emitted body, including its membership/rejection lists and nested JSON escaping.
async function inputFor(values: readonly ResolvedEvidence[], selected: readonly number[], sources?: string[]) {
  const manifest = await manifestFor(values, sources);
  const input = { manifest, evidence: values, modelRouteRef: "route-1", serializeRequestBody: serialize };
  const full = await compiler.compile({ ...input, maxBytes: 1_000_000 });
  const selectedRefs = new Set(selected.map((index) => key(present(values[index]).handle.handle_ref)));
  const invalid = new Map(full.selection_receipt.rejected_candidates.map((item) => [item.ref, item.reason_code]));
  const receipt = {
    ...full.selection_receipt,
    admitted_candidate_refs: full.selection_receipt.input_candidate_refs.filter((ref) => selectedRefs.has(ref)),
    rejected_candidates: full.selection_receipt.input_candidate_refs.filter((ref) => !selectedRefs.has(ref))
      .map((ref) => ({ ref, reason_code: invalid.get(ref) ?? "CONTEXT_BYTE_BUDGET_EXCEEDED" })),
  };
  const maxBytes = bytes(serialize({ ...full,
    blocks: full.blocks.filter((block) => selectedRefs.has(key(block.evidence_handle_ref))),
    selection_receipt: receipt,
  }));
  return { ...input, maxBytes };
}

function refs(blocks: readonly EvidenceContextBlock[]): string[] {
  return blocks.map((block) => key(block.evidence_handle_ref));
}

describe("owner-controlled source diversity in context transport packing", () => {
  it("covers distinct canonical sources before extras while retaining packet/receipt order and exact body bounds", async () => {
    const values = await Promise.all([
      evidence("h-01", "source-a"), evidence("h-02", "source-a"), evidence("h-03", "source-a"),
      evidence("h-04", "source-b"), evidence("h-05", "source-c"),
    ]);
    const input = await inputFor(values, [0, 3, 4]);
    const legacy = await compiler.compile(input);
    expect(refs(legacy.blocks)).toEqual(["h-01:1", "h-02:1", "h-03:1"]);
    expect(await compiler.compile({ ...input, preferSourceDiversity: false })).toEqual(legacy);

    const result = await compiler.compile({ ...input, preferSourceDiversity: true });
    expect(refs(result.blocks)).toEqual(["h-01:1", "h-04:1", "h-05:1"]);
    expect(result.selection_receipt.input_candidate_refs).toEqual(values.map((value) => key(value.handle.handle_ref)));
    expect(result.selection_receipt.admitted_candidate_refs).toEqual(refs(result.blocks));
    expect(result.selection_receipt.rejected_candidates).toEqual([
      { ref: "h-02:1", reason_code: "CONTEXT_BYTE_BUDGET_EXCEEDED" },
      { ref: "h-03:1", reason_code: "CONTEXT_BYTE_BUDGET_EXCEEDED" },
    ]);
    expect(result.selection_receipt.untrusted_structure_changed_membership).toBe(false);
    expect(result.total_utf8_bytes).toBe(bytes(serialize(result)));
    expect(result.total_utf8_bytes).toBe(input.maxBytes);
    expect(await compiler.compile({ ...input, preferSourceDiversity: true })).toEqual(result);
    const withExtra = await compiler.compile({ ...await inputFor(values, [0, 1, 3, 4]), preferSourceDiversity: true });
    expect(refs(withExtra.blocks)).toEqual(["h-01:1", "h-02:1", "h-04:1", "h-05:1"]);
    for (const block of result.blocks) {
      const original = present(values.find((value) => key(value.handle.handle_ref) === key(block.evidence_handle_ref)));
      expect(block.quoted_content).toBe(original.exact_excerpt);
      expect(block.excerpt_sha256).toBe(original.handle.excerpt_sha256);
    }
  });

  it("keeps all required handles ahead of optional source coverage and blocks an oversized required set", async () => {
    const values = await Promise.all([
      evidence("h-01", "source-a"), evidence("h-02", "source-a"), evidence("h-03", "source-a"),
      evidence("h-04", "source-b"), evidence("h-05", "source-c"),
    ]);
    const input = await inputFor(values, [1, 2, 3]);
    const requiredHandleRefs = [present(values[1]).handle.handle_ref, present(values[2]).handle.handle_ref];
    const result = await compiler.compile({ ...input, requiredHandleRefs, preferSourceDiversity: true });
    expect(refs(result.blocks)).toEqual(["h-02:1", "h-03:1", "h-04:1"]);
    const tooSmall = await inputFor(values, [1]);
    await expect(compiler.compile({ ...input, maxBytes: tooSmall.maxBytes, requiredHandleRefs, preferSourceDiversity: true }))
      .rejects.toMatchObject({ code: "CONTEXT_COMPILATION_BLOCKED", blockers: requiredHandleRefs.map((handle_ref) => ({
        handle_ref, reason_code: "REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED",
      })), selection_receipt: { admitted_candidate_refs: [] } });
  });

  it("tries the next viable block within a source and preserves invalid-source/integrity failures", async () => {
    const values = await Promise.all([
      evidence("h-01", "source-a", "oversize ".repeat(10_000)), evidence("h-02", "source-a"),
      evidence("h-03", "source-a"), evidence("h-04", "source-x"), evidence("h-05", "source-b"),
      evidence("h-06", "source-c"), evidence("h-07", "source-c"),
    ]);
    values[5] = { ...present(values[5]), exact_excerpt: "tampered source text" };
    const input = await inputFor(values, [1, 4, 6], ["source-a", "source-b", "source-c"]);
    const result = await compiler.compile({ ...input, preferSourceDiversity: true });
    expect(refs(result.blocks)).toEqual(["h-02:1", "h-05:1", "h-07:1"]);
    expect(result.selection_receipt.rejected_candidates).toEqual([
      { ref: "h-01:1", reason_code: "CONTEXT_BYTE_BUDGET_EXCEEDED" },
      { ref: "h-03:1", reason_code: "CONTEXT_BYTE_BUDGET_EXCEEDED" },
      { ref: "h-04:1", reason_code: "SOURCE_REVISION_NOT_ALLOWLISTED" },
      { ref: "h-06:1", reason_code: "EVIDENCE_INTEGRITY_FAILED" },
    ]);
    expect(result.total_utf8_bytes).toBe(bytes(serialize(result)));
    expect(result.total_utf8_bytes).toBeLessThanOrEqual(input.maxBytes);
    const blocked = compiler.compile({ ...input, preferSourceDiversity: true, requiredHandleRefs: [present(values[3]).handle.handle_ref] });
    await expect(blocked).rejects.toBeInstanceOf(ContextCompilationBlockedError);
    await expect(blocked).rejects.toMatchObject({ blockers: [{
      handle_ref: present(values[3]).handle.handle_ref, reason_code: "REQUIRED_SOURCE_REVISION_NOT_ALLOWLISTED",
    }] });
  });
});
