import { describe, expect, it, vi } from "vitest";
import type { ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  declareAiSearchGeneration,
} from "@eliotr/cloudflare-ai";
import type { AiSearchInstanceLike, EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { AiSearchFunctionalProbeError } from "./ai-search-functional-probe.js";
import {
  createAiSearchFunctionalProbe,
  type AiSearchFunctionalProbeDependencies,
  type AiSearchFunctionalProbeInput,
} from "./ai-search-functional-probe.js";

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

const HANDLE = {
  handle_ref: { id: "handle-example", revision: 1 }, source_namespace_id: "namespace-example",
  source_owner_generation: "owner-generation-1", source_revision_ref: REVISION,
  scope_snapshot_ref: { id: SCOPE.snapshot_id, revision: SCOPE.revision },
  anchor: { kind: "normalized_byte_range" as const, start: 0, end: 16 }, excerpt_sha256: "c".repeat(64),
  excerpt_byte_length: 16, object_residency_key_digest: "d".repeat(64), source_assurance_ceiling: "CAPTURED" as const,
  materializer_assurance_ceiling: "CAPTURED" as const, terminal_state: "LIVE" as const, created_at: new Date(NOW).toISOString(),
};

const SEARCH_RESULT = {
  search_query: QUERY,
  chunks: [{ id: "chunk-example", type: "text", score: 0.9, text: "private index preview",
    item: { key: "item-example.md", metadata: {
      canonical_section_id: "section-example", content_sha256: "e".repeat(64), instruction_taint: "CLEARED",
      projection_generation: AI_SEARCH_PRIMARY_GENERATION, source_revision_ref: REVISION,
    } },
  }],
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

async function fixture(search = vi.fn(async () => SEARCH_RESULT), clock = { value: NOW }) {
  const store = objectStore(), registry = await registrySnapshot();
  const instance: AiSearchInstanceLike = { search, items: {
    async createOrUpdate() { throw new Error("unused"); }, async uploadAndPoll() { throw new Error("unused"); },
    async delete() { throw new Error("unused"); }, async get() { throw new Error("unused"); },
  } };
  const get = vi.fn((id: string) => { if (id !== AI_SEARCH_PRIMARY_INSTANCE_ID) throw new Error("wrong instance"); return instance; });
  const dependencies: AiSearchFunctionalProbeDependencies = {
    ai_search: { get, list: async () => ({}), create: async () => instance, update: async () => instance, search: async () => ({}) },
    registry: { read: async () => registry }, work_object_store: store.port,
    require_current_scope: vi.fn(async () => undefined),
    resolve_candidate: vi.fn(async () => ({ handle: HANDLE, exact_excerpt: "do not persist exact source body" } as ResolvedEvidence)),
    now: () => clock.value,
  };
  return { service: createAiSearchFunctionalProbe(dependencies), store, dependencies, search, clock };
}

describe("AI Search functional shadow probe", () => {
  it("claims once, resolves a live exact handle, and replays only the immutable terminal receipt", async () => {
    const f = await fixture();
    const result = await f.service.probe(input());
    expect(result).toMatchObject({ outcome: "SUCCEEDED", qualification: "NONE", evidence_handle: HANDLE });
    expect(result.functional_ref).toMatch(/^functional-probe:/u);
    expect(result.functional_ref).not.toContain("golden");
    expect(f.search).toHaveBeenCalledTimes(1);
    expect(f.search).toHaveBeenCalledWith({ query: QUERY, ai_search_options: { retrieval: {
      retrieval_type: "vector", match_threshold: 0, max_num_results: 1, context_expansion: 0, boost_by: [], metadata_only: false,
    } } });
    expect(f.dependencies.ai_search.get).toHaveBeenCalledWith(AI_SEARCH_PRIMARY_INSTANCE_ID);
    expect(f.dependencies.resolve_candidate).toHaveBeenCalledTimes(1);
    f.clock.value += 1;
    const replay = await f.service.probe(input());
    expect(replay).toEqual(result);
    expect(f.search).toHaveBeenCalledTimes(1);
    const stored = [...f.store.objects.values()].map((item) => new TextDecoder().decode(item.bytes)).join("\n");
    expect(stored).not.toContain(QUERY);
    expect(stored).not.toContain("private index preview");
    expect(stored).not.toContain("do not persist exact source body");
    expect(stored).not.toContain("golden_set_result_ref");
  });

  it("returns UNKNOWN for a concurrent duplicate with a durable START but no terminal receipt", async () => {
    let releaseSearch!: (value: typeof SEARCH_RESULT) => void, announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const pending = new Promise<typeof SEARCH_RESULT>((resolve) => { releaseSearch = resolve; });
    const search = vi.fn(() => { announceStarted(); return pending; });
    const f = await fixture(search);
    const first = f.service.probe(input());
    await started;
    const duplicate = await f.service.probe(input());
    expect(duplicate.outcome).toBe("UNKNOWN");
    expect(duplicate.reason_code).toBe("AI_SEARCH_FUNCTIONAL_PROBE_START_ALREADY_CLAIMED");
    expect(f.search).toHaveBeenCalledTimes(1);
    releaseSearch(SEARCH_RESULT);
    expect((await first).outcome).toBe("SUCCEEDED");
    expect(f.search).toHaveBeenCalledTimes(1);
  });

  it("rejects a wider or mismatched scope before writing a claim or calling Search", async () => {
    const f = await fixture();
    await expect(f.service.probe(input({ project_id: "other-project" }))).rejects.toMatchObject({
      code: "AI_SEARCH_FUNCTIONAL_PROBE_SCOPE_MISMATCH",
    } satisfies Partial<AiSearchFunctionalProbeError>);
    expect(f.store.objects.size).toBe(0);
    expect(f.search).not.toHaveBeenCalled();
  });
});
