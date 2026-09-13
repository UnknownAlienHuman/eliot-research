import {
  AllowedReferenceManifestSchema,
  ObjectResidencyKeySchema,
  VersionedRefSchema,
  type AllowedReferenceManifest,
  type ObjectResidencyKey,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  evidenceSha256Bytes,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import {
  bufferBounded,
  createR2EvidenceObjectStore,
  objectResidencyKeyDigest,
} from "@eliotr/platform-cloudflare";
import type { ReferenceManifestStore } from "@eliotr/policy";
import { ReferenceManifestError } from "./research-reference-manifest.js";

const MAX_BYTES = 256 * 1024;
const PROTOCOL = "eliotr.qualification-manifest.v1";

/** Private qualification storage; it creates no workflow attempt or report record. */
export function createResearchQualificationManifestStore(input: {
  readonly work_bucket: R2Bucket;
  readonly navigation: NavigationReadAuthority;
  readonly residency_template: Omit<ObjectResidencyKey, "content_digest">;
}): ReferenceManifestStore {
  const navigation = input.navigation;
  const template = ObjectResidencyKeySchema.omit({ content_digest: true }).parse(input.residency_template);
  const store = createR2EvidenceObjectStore(input.work_bucket);
  const binding = Object.freeze({
    protocol: PROTOCOL,
    principal_ref: navigation.access.principal_ref,
    credential_generation: navigation.access.credential_generation,
    scope_snapshot_ref: { id: navigation.scope.snapshot_id, revision: navigation.scope.revision },
    scope_snapshot_digest: navigation.scope.digest,
    residency_template: template,
  });

  function corrupt(message: string): never {
    throw new ReferenceManifestError("REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN", message);
  }

  function invalid(message: string): never {
    throw new ReferenceManifestError("REFERENCE_MANIFEST_INPUT_INVALID", message);
  }

  async function manifestContractDigest(manifest: AllowedReferenceManifest): Promise<string> {
    const { manifest_digest: _digest, ...digestPayload } = manifest;
    return evidenceSha256(digestPayload);
  }

  function requireBinding(manifest: AllowedReferenceManifest, ref: VersionedRef): void {
    if (manifest.manifest_ref.id !== ref.id || manifest.manifest_ref.revision !== ref.revision ||
        manifest.scope_snapshot_ref.id !== binding.scope_snapshot_ref.id ||
        manifest.scope_snapshot_ref.revision !== binding.scope_snapshot_ref.revision ||
        Date.parse(manifest.expires_at) <= Date.parse(navigation.timestamp())) {
      corrupt("qualification manifest identity or scope is stale");
    }
  }

  async function key(ref: VersionedRef): Promise<string> {
    return `research/model-qualification/manifests/${await evidenceSha256({ ...binding, manifest_ref: ref })}.json`;
  }

  async function metadata(digest: string) {
    const residency = ObjectResidencyKeySchema.parse({
      ...template, content_digest: { algorithm: "sha256", digest },
    });
    return {
      qualification_manifest_protocol: PROTOCOL,
      qualification_residency_sha256: await objectResidencyKeyDigest(residency),
      qualification_scope_digest: binding.scope_snapshot_digest,
    };
  }

  async function get(rawRef: VersionedRef): Promise<AllowedReferenceManifest | null> {
    const ref = VersionedRefSchema.parse(rawRef);
    await navigation.current();
    const stored = await input.work_bucket.get(await key(ref));
    if (stored === null) {
      await navigation.current();
      return null;
    }
    if (stored.size < 1 || stored.size > MAX_BYTES) corrupt("qualification manifest exceeds its byte bound");
    const bytes = await bufferBounded(stored.body, MAX_BYTES);
    const digest = await evidenceSha256Bytes(bytes);
    const expectedMetadata = await metadata(digest);
    if (bytes.byteLength !== stored.size || stored.customMetadata?.eliotr_sha256 !== digest ||
        stored.customMetadata.eliotr_size_bytes !== String(bytes.byteLength) ||
        stored.customMetadata.eliotr_immutable !== "true" ||
        Object.entries(expectedMetadata).some(([name, value]) => stored.customMetadata?.[name] !== value)) {
      corrupt("qualification manifest storage binding does not match its bytes");
    }
    let manifest: AllowedReferenceManifest;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      manifest = AllowedReferenceManifestSchema.parse(JSON.parse(text));
    } catch {
      return corrupt("qualification manifest is invalid");
    }
    if (canonicalEvidenceJson(manifest) !== text) corrupt("qualification manifest is not canonical");
    if (await manifestContractDigest(manifest) !== manifest.manifest_digest) {
      corrupt("qualification manifest digest does not match its canonical payload");
    }
    requireBinding(manifest, ref);
    await navigation.current();
    return manifest;
  }

  return Object.freeze({
    get,
    async put(rawManifest: AllowedReferenceManifest): Promise<VersionedRef> {
      const manifest = AllowedReferenceManifestSchema.parse(rawManifest);
      const ref = VersionedRefSchema.parse(manifest.manifest_ref);
      requireBinding(manifest, ref);
      if (await manifestContractDigest(manifest) !== manifest.manifest_digest) {
        invalid("qualification manifest digest does not match its canonical payload");
      }
      const bytes = new TextEncoder().encode(canonicalEvidenceJson(manifest));
      if (bytes.byteLength > MAX_BYTES) corrupt("qualification manifest exceeds its byte bound");
      const digest = await evidenceSha256Bytes(bytes);
      await navigation.current();
      await store.putImmutable({
        key: await key(ref),
        body: new Blob([bytes]).stream(),
        expected_sha256: digest,
        expected_size_bytes: bytes.byteLength,
        content_type: "application/json",
        custom_metadata: await metadata(digest),
      });
      const readback = await get(ref);
      if (readback === null || canonicalEvidenceJson(readback) !== canonicalEvidenceJson(manifest)) {
        corrupt("qualification manifest write has no identical readback");
      }
      return Object.freeze({ ...ref });
    },
  });
}
