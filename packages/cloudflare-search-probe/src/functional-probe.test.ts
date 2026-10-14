import { describe, expect, it, vi } from "vitest";
import type { ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import {
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  declareAiSearchGeneration,
} from "@eliotr/cloudflare-ai";
import { decodeAiSearchSearchResult, type AiSearchInstanceLike, type EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { RetrievalRequest } from "@eliotr/retrieval";
import type { AiSearchFunctionalProbeError } from "./index.js";
import {
  createAiSearchFunctionalProbe,
  type AiSearchFunctionalProbeDependencies,
  type AiSearchFunctionalProbeInput,
} from "./index.js";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const ACCESS = { principal_ref: "owner-example", client_class: "owner_pwa" as const, credential_generation: "credential-example" };
const PROJECT = "project-example", SOURCE = "source-example", REVISION = "revision-example";
const QUERY = "How does the example source work?";

interface StoredObject { readonly bytes: Uint8Array; readonly sha: string; readonly content_type: string; readonly metadata: Readonly<Record<string, string>>; }

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength); new Uint8Array(copy).set(bytes);
  const value = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

async function streamBytes(value: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = value.getReader(), chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); size += part.value.byteLength; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

function objectStore(): { readonly port: EvidenceObjectStore; readonly objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  const port = {
    async putImmutable(write: Parameters<EvidenceObjectStore["putImmutable"]>[0]) {
      const bytes = await streamBytes(write.body), sha = await digest(bytes);
      if (sha !== write.expected_sha256 || bytes.byteLength !== write.expected_size_bytes) throw new Error("fixture write digest mismatch");
      const metadata = { ...write.custom_metadata, eliotr_sha256: sha, eliotr_size_bytes: String(bytes.byteLength), eliotr_immutable: "true" };
      const previous = objects.get(write.key);
      if (previous !== undefined) {
        if (previous.sha !== sha || previous.content_type !== write.content_type ||
            JSON.stringify(previous.metadata) !== JSON.stringify(metadata) || previous.bytes.byteLength !== bytes.byteLength) {
          throw new Error("fixture immutable key conflict");
        }
        return { key: write.key, expected_sha256: sha, readback_sha256: sha, size_bytes: bytes.byteLength, etag: "fixture-etag", existed_identically: true };
      }
      objects.set(write.key, { bytes, sha, content_type: write.content_type, metadata });
      return { key: write.key, expected_sha256: sha, readback_sha256: sha, size_bytes: bytes.byteLength, etag: "fixture-etag", existed_identically: false };
    },
    async open(key: string) {
      const saved = objects.get(key); if (saved === undefined) return null;
      return {
        size: saved.bytes.byteLength,
        customMetadata: saved.metadata,
        httpMetadata: { contentType: saved.content_type },
        body: stream(saved.bytes),
      } as never;
    },
    async putResidencyObject() { throw new Error("unused"); },
    async deleteForErasure() { throw new Error("unused"); },
  };
  return { port: port as EvidenceObjectStore, objects };
}

const SCOPE: ScopeSnapshot = {
  snapshot_id: "scope-example", revision: 1,
  resolved_scope_expression: { kind: "INTERSECT", left: { kind: "PROJECT", project_id: PROJECT }, right: { kind: "SELECTED_SOURCES", source_ids: [SOURCE] } },
  participant_generations: { "project-example": "project-generation-1" },
  member_source_revision_refs: [REVISION], source_owner_generations: { [REVISION]: "owner-generation-1" },
  policy_authority_ref: "policy-example", disclosure_closure_digest: "a".repeat(64), purge_ledger_revision: 1,
  digest: "b".repeat(64), created_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60_000).toISOString(),
};

async function registrySnapshot() {
  const record = declareAiSearchGeneration([], {
    namespace: AI_SEARCH_PRIMARY_NAMESPACE, profile: AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    expected_item_count: 1, declared_at: new Date(NOW).toISOString(),
  });
  const artifact = buildAiSearchGenerationRegistryArtifact(AI_SEARCH_PRIMARY_NAMESPACE, 1, {
    active_head_generation: null, generations: [record],
  });
  return { artifact, artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact) };
}

function input(overrides: Partial<AiSearchFunctionalProbeInput> = {}): AiSearchFunctionalProbeInput {
  return {
    access: ACCESS, project_id: PROJECT, source_id: SOURCE, source_revision_ref: REVISION,
    scope_snapshot: SCOPE, query: QUERY, idempotency_key: "fresh-probe-key-1",
    deadline_ms: NOW + 8_000, signal: new AbortController().signal, ...overrides,
  };
}

async function fixture() {
  const search = vi.fn(async () => ({}));
  const clock = { value: NOW };
  const store = objectStore(), registry = await registrySnapshot();
  const readRegistry = vi.fn(async () => registry);
  const instance: AiSearchInstanceLike = { search, items: {
    async createOrUpdate() { throw new Error("unused"); }, async uploadAndPoll() { throw new Error("unused"); },
    async delete() { throw new Error("unused"); }, async get() { throw new Error("unused"); },
  } };
  const get = vi.fn((id: string) => { if (id !== AI_SEARCH_PRIMARY_INSTANCE_ID) throw new Error("wrong instance"); return instance; });
  const dependencies: AiSearchFunctionalProbeDependencies = {
    ai_search: { get, list: async () => ({}), create: async () => instance, update: async () => instance, search: async () => ({}) },
    registry: { read: readRegistry }, work_object_store: store.port,
    require_current_scope: vi.fn(async () => undefined),
    resolve_candidate: vi.fn(async () => ({} as ResolvedEvidence)),
    now: () => clock.value,
  };
  return { service: createAiSearchFunctionalProbe(dependencies), store, dependencies, search, clock, readRegistry };
}

describe("AI Search functional shadow probe", () => {
  it("fails closed before claim or provider I/O when Core project-copy scope is unavailable", async () => {
    const f = await fixture();
    await expect(f.service.probe(input())).rejects.toMatchObject({
      code: "AI_SEARCH_FUNCTIONAL_PROBE_AUTHORITY_UNAVAILABLE",
    });
    expect(f.dependencies.require_current_scope).toHaveBeenCalledTimes(1);
    expect(f.readRegistry).toHaveBeenCalledTimes(1);
    expect(f.store.objects.size).toBe(0);
    expect(f.dependencies.ai_search.get).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable scope before writing a claim or calling Search", async () => {
    const f = await fixture();
    const revision = "r".repeat(65);
    await expect(f.service.probe(input({
      source_revision_ref: revision,
      scope_snapshot: { ...SCOPE, member_source_revision_refs: [revision],
        source_owner_generations: { [revision]: "owner-generation-1" } },
    }))).rejects.toMatchObject({ code: "AI_SEARCH_FUNCTIONAL_PROBE_INPUT_INVALID" });
    expect(f.store.objects.size).toBe(0);
    expect(f.dependencies.ai_search.get).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
  });

  it("rejects a wider or mismatched scope before writing a claim or calling Search", async () => {
    const f = await fixture();
    await expect(f.service.probe(input({ project_id: "other-project" }))).rejects.toMatchObject({
      code: "AI_SEARCH_FUNCTIONAL_PROBE_SCOPE_MISMATCH",
    } satisfies Partial<AiSearchFunctionalProbeError>);
    expect(f.store.objects.size).toBe(0);
    expect(f.search).not.toHaveBeenCalled();
  });

  it("accepts a flat provider key only when the decoder receives its exact historical generation", () => {
    const historicalGeneration = "legacy-flat-generation";
    const request: RetrievalRequest = {
      raw_query: QUERY, product: "FAST_SEARCH", scope_snapshot: SCOPE, literals: [],
      requested_limit: 1, deadline_ms: NOW + 8_000,
    };
    const rawResult = {
      search_query: QUERY,
      chunks: [{ id: "legacy-chunk", type: "text", score: 0.9, text: "preview",
        item: { key: "legacy-item.md", metadata: {
          canonical_section_id: "section-example", content_sha256: "e".repeat(64), instruction_taint: "CLEARED",
          projection_generation: historicalGeneration, source_revision_ref: REVISION,
        } },
      }],
    };
    const options = {
      project_copy_layout: "LEGACY_FLAT" as const,
      requested_lanes: ["SEM"] as const,
      max_results: 1,
      max_preview_bytes: 4096,
    };
    expect(() => decodeAiSearchSearchResult(request, rawResult, {
      ...options, expected_index_generation: "current-generation", historical_generation: historicalGeneration,
    })).toThrow(/exact historical generation/u);
    expect(decodeAiSearchSearchResult(request, rawResult, {
      ...options, expected_index_generation: historicalGeneration, historical_generation: historicalGeneration,
    })).toHaveLength(1);
  });
});
