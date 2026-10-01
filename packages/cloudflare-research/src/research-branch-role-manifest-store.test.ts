import { describe, expect, it } from "vitest";
import {
  AllowedReferenceManifestSchema,
  type AllowedReferenceManifest,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256, type NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { ReferenceManifestError } from "./research-reference-manifest.js";
import { createResearchBranchRoleManifestStore } from "./research-branch-role-manifest-store.js";

const NOW = "2026-10-01T12:00:00.000Z";
const FUTURE = "2030-01-01T00:00:00.000Z";

const RESIDENCY_TEMPLATE = {
  scope_domain_id: "scope",
  access_domain_id: "access",
  confidentiality_domain_id: "conf",
  encryption_key_domain_id: "enc",
  retention_domain_id: "ret",
  erasure_domain_id: "erase",
};

const GRANT = {
  authorization_receipt_ref: "authz-1",
  policy_authority_ref: "auth-1",
  allowed_use: ["research"],
  disclosure_ceiling: "EXACT",
  expires_at: FUTURE,
};

const NAVIGATION = {
  scope: { snapshot_id: "scope-1", revision: 1, digest: "d".repeat(64) },
  access: { principal_ref: "principal-1", client_class: "owner_pwa", credential_generation: "cred-1" },
  current: async () => GRANT,
  sources: async () => [],
  timestamp: () => NOW,
} as unknown as NavigationReadAuthority;

// The immutable R2 readback hashes the streamed body through Cloudflare's
// crypto.DigestStream, which does not exist under Node. Polyfill it with a
// subtle-backed equivalent so the store's exact integrity path is exercised.
// Note: the real DigestStream IS a WritableStream carrying a digest promise.
class NodeDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    if (algorithm !== "SHA-256") throw new Error(`unsupported digest algorithm ${algorithm}`);
    const chunks: Uint8Array[] = [];
    let resolveDigest!: (value: ArrayBuffer) => void;
    let rejectDigest!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    super({
      write(chunk: Uint8Array) {
        chunks.push(chunk.slice());
      },
      async close() {
        try {
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          resolveDigest(await crypto.subtle.digest("SHA-256", body));
        } catch (error) {
          rejectDigest(error);
        }
      },
      abort(reason: unknown) {
        rejectDigest(reason);
      },
    });
    this.digest = digest;
  }
}
(globalThis.crypto as unknown as Record<string, unknown>).DigestStream = NodeDigestStream;

interface StoredObject {
  bytes: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  etag: string;
}

/** In-memory R2 stand-in: honors the conditional-write used by putImmutable. */
function mockBucket() {
  const objects = new Map<string, StoredObject>();
  async function readBody(body: Uint8Array | string | ReadableStream<Uint8Array>): Promise<Uint8Array> {
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof Uint8Array) return body.slice();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  const bucket = {
    async put(
      key: string,
      body: Uint8Array | string | ReadableStream<Uint8Array>,
      options?: {
        readonly onlyIf?: { readonly etagDoesNotMatch?: string };
        readonly customMetadata?: Record<string, string>;
        readonly httpMetadata?: { readonly contentType?: string };
      },
    ): Promise<{ readonly etag: string } | null> {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = await readBody(body);
      const etag = `"mock-etag-${objects.size + 1}"`;
      objects.set(key, {
        bytes,
        customMetadata: { ...(options?.customMetadata ?? {}) },
        contentType: options?.httpMetadata?.contentType ?? "application/octet-stream",
        etag,
      });
      return { etag };
    },
    async get(key: string): Promise<{
      readonly body: ReadableStream<Uint8Array>;
      readonly size: number;
      readonly etag: string;
      readonly customMetadata: Record<string, string>;
      readonly httpMetadata: { readonly contentType?: string };
    } | null> {
      const stored = objects.get(key);
      if (stored === undefined) return null;
      const bytes = stored.bytes;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        size: bytes.byteLength,
        etag: stored.etag,
        customMetadata: stored.customMetadata,
        httpMetadata: { contentType: stored.contentType },
      };
    },
    raw(key: string): StoredObject | undefined {
      return objects.get(key);
    },
    keys(): string[] {
      return [...objects.keys()];
    },
    tamper(key: string): void {
      const stored = objects.get(key);
      if (stored === undefined) throw new Error("no object to tamper");
      stored.bytes[0] = stored.bytes[0] === 0 ? 1 : 0;
    },
    keyCount(): number {
      return objects.size;
    },
  };
  return bucket;
}

async function manifest(
  ref: VersionedRef,
  overrides?: Partial<AllowedReferenceManifest>,
): Promise<AllowedReferenceManifest> {
  const payload = {
    manifest_ref: ref,
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    allowed_source_revision_refs: ["rev-1"],
    allowed_evidence_handle_refs: [{ id: "h-1", revision: 1 }],
    allowed_tool_definition_refs: [],
    allowed_verifier_refs: [],
    permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: {},
    stale_or_revoked_entries: [],
    permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "EXACT",
    allowed_use: ["research"],
    expires_at: FUTURE,
    ...overrides,
  };
  const { manifest_digest: _ignored, ...digestPayload } = payload;
  const manifest_digest = await evidenceSha256(digestPayload);
  return AllowedReferenceManifestSchema.parse({ ...payload, manifest_digest });
}

function setup() {
  const work_bucket = mockBucket();
  const store = createResearchBranchRoleManifestStore({
    work_bucket: work_bucket as unknown as R2Bucket,
    navigation: NAVIGATION,
    residency_template: RESIDENCY_TEMPLATE,
  });
  return { store, work_bucket };
}

const REF: VersionedRef = { id: "manifest-1", revision: 1 };

describe("research branch role manifest store", () => {
  it("round-trips a manifest through put and get", async () => {
    const { store } = setup();
    const value = await manifest(REF);
    const stored = await store.put(value);
    expect(stored).toEqual(REF);
    const read = await store.get(REF);
    expect(read).not.toBeNull();
    expect(canonicalEvidenceJson(read)).toBe(canonicalEvidenceJson(value));
  });

  it("returns null for an unknown ref", async () => {
    const { store } = setup();
    expect(await store.get({ id: "missing", revision: 1 })).toBeNull();
  });

  it("treats a duplicate put of identical bytes as idempotent", async () => {
    const { store, work_bucket } = setup();
    const value = await manifest(REF);
    const first = await store.put(value);
    const second = await store.put(value);
    expect(second).toEqual(first);
    expect(work_bucket.keyCount()).toBe(1);
  });

  it("rejects a second manifest under the same ref with different bytes", async () => {
    const { store } = setup();
    await store.put(await manifest(REF));
    const other = await manifest(REF, {
      allowed_source_revision_refs: ["rev-1", "rev-2", "rev-3"],
    });
    expect(canonicalEvidenceJson(other)).not.toBe(canonicalEvidenceJson(await manifest(REF)));
    await expect(store.put(other)).rejects.toMatchObject({ code: "R2_IMMUTABLE_KEY_CONFLICT" });
    // The original manifest still reads back identically.
    const read = await store.get(REF);
    expect(read?.allowed_source_revision_refs).toEqual(["rev-1"]);
  });

  it("fails closed when stored bytes are tampered", async () => {
    const { store, work_bucket } = setup();
    await store.put(await manifest(REF));
    const [key] = work_bucket.keys();
    if (key === undefined) throw new Error("expected one stored object");
    work_bucket.tamper(key);
    await expect(store.get(REF)).rejects.toBeInstanceOf(ReferenceManifestError);
  });

  it("fails closed when the manifest digest does not match its payload", async () => {
    const { store } = setup();
    const value = await manifest(REF);
    const tampered = AllowedReferenceManifestSchema.parse({
      ...value,
      manifest_digest: "f".repeat(64),
    });
    await expect(store.put(tampered)).rejects.toBeInstanceOf(ReferenceManifestError);
  });

  it("fails closed when the manifest is bound to another scope", async () => {
    const { store } = setup();
    const value = await manifest(REF, { scope_snapshot_ref: { id: "scope-9", revision: 1 } });
    await expect(store.put(value)).rejects.toBeInstanceOf(ReferenceManifestError);
  });

  it("fails closed when the manifest is expired", async () => {
    const { store } = setup();
    const value = await manifest(REF, { expires_at: "2020-01-01T00:00:00.000Z" });
    await expect(store.put(value)).rejects.toBeInstanceOf(ReferenceManifestError);
  });

  it("fails closed when stored metadata is stripped", async () => {
    const { store, work_bucket } = setup();
    await store.put(await manifest(REF));
    const [key] = work_bucket.keys();
    if (key === undefined) throw new Error("expected one stored object");
    const stored = work_bucket.raw(key);
    if (stored === undefined) throw new Error("expected stored bytes");
    delete stored.customMetadata.eliotr_immutable;
    await expect(store.get(REF)).rejects.toBeInstanceOf(ReferenceManifestError);
  });
});
