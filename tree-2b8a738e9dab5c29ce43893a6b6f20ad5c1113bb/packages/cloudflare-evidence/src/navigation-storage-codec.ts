import type { DocumentMapRevision, ProjectAtlasRevision, SourceCard, VersionedRef } from "@eliotr/contracts";
import {
  NavigationError, canonicalNavigationJson, documentMapIdentity, parseDocumentMapArtifact,
  parseProjectAtlasArtifact, parseSourceCardArtifact, projectAtlasIdentity, sameVersionedRef,
  sourceCardIdentity,
} from "@eliotr/retrieval";

export type NavigationArtifactKind = "SOURCE_CARD" | "DOCUMENT_MAP" | "PROJECT_ATLAS";
export type NavigationArtifact = SourceCard | DocumentMapRevision | ProjectAtlasRevision;
export const NAVIGATION_BODY_BYTES = 1_000_000;
export const NAVIGATION_READ_BYTES = 4_000_000;
export const NAVIGATION_ROW_BYTES = 1_800_000;
export const NAVIGATION_BATCH_SIZE = 512;

export function navigationStorageFailure(message: string): never {
  throw new NavigationError("NAVIGATION_ARTIFACT_INVALID", message);
}
export function navigationStorageLimit(): never {
  throw new NavigationError("NAVIGATION_LIMIT_EXCEEDED", "navigation storage resource bound exceeded");
}

/** Bound traversal before recursive schema decoding; accessors and non-JSON state are never evaluated. */
export function navigationStorageJson(value: unknown, maxBytes = NAVIGATION_BODY_BYTES): string {
  let nodes = 0;
  let minimumBytes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): void {
    if (++nodes > 32_768 || depth > 32) navigationStorageLimit();
    if (typeof item === "string") minimumBytes += new TextEncoder().encode(item).byteLength;
    else if (typeof item === "number") {
      if (!Number.isSafeInteger(item)) navigationStorageFailure("non-integer navigation JSON");
    } else if (item !== null && typeof item !== "boolean") {
      if (typeof item !== "object") navigationStorageFailure("non-JSON navigation value");
      if (ancestors.has(item)) navigationStorageFailure("cyclic navigation value");
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item) as object | null)) {
        navigationStorageFailure("non-plain navigation value");
      }
      const keys = Reflect.ownKeys(item);
      if (keys.length > 32_768) navigationStorageLimit();
      if (Array.isArray(item) && (item.length > 32_768 || keys.length !== item.length + 1)) {
        navigationStorageFailure("sparse or augmented navigation array");
      }
      ancestors.add(item);
      for (const key of keys) {
        if (Array.isArray(item) && key === "length") continue;
        if (typeof key !== "string") navigationStorageFailure("symbol navigation key");
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          navigationStorageFailure("hidden navigation state or accessor");
        }
        minimumBytes += new TextEncoder().encode(key).byteLength;
        if (minimumBytes > maxBytes) navigationStorageLimit();
        visit(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    }
    if (minimumBytes > maxBytes) navigationStorageLimit();
  }
  visit(value, 0);
  const encoded = canonicalNavigationJson(value);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) navigationStorageLimit();
  return encoded;
}

export function parseStoredNavigationJson(value: unknown, maxBytes = NAVIGATION_BODY_BYTES): unknown {
  if (typeof value !== "string") navigationStorageFailure("stored navigation is not JSON text");
  if (new TextEncoder().encode(value).byteLength > maxBytes) navigationStorageLimit();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { navigationStorageFailure("malformed stored navigation JSON"); }
  if (navigationStorageJson(parsed, maxBytes) !== value) navigationStorageFailure("noncanonical stored navigation JSON");
  return parsed;
}

export function parseNavigationArtifact(kind: NavigationArtifactKind, raw: unknown): NavigationArtifact {
  navigationStorageJson(raw);
  switch (kind) {
    case "SOURCE_CARD": return parseSourceCardArtifact(raw);
    case "DOCUMENT_MAP": return parseDocumentMapArtifact(raw);
    case "PROJECT_ATLAS": return parseProjectAtlasArtifact(raw);
    default: return navigationStorageFailure("unknown navigation artifact kind");
  }
}

export function navigationArtifactIdentity(artifact: NavigationArtifact): {
  readonly ref: VersionedRef; readonly subject_id: string; readonly subject_revision: number;
} {
  if ("card_ref" in artifact) return { ref: artifact.card_ref, subject_id: artifact.source_revision_ref, subject_revision: 1 };
  if ("map_ref" in artifact) return { ref: artifact.map_ref, subject_id: artifact.source_revision_ref, subject_revision: 1 };
  return { ref: artifact.atlas_ref, subject_id: artifact.project_ref.id, subject_revision: artifact.project_ref.revision };
}

export async function verifyNavigationIdentity(artifact: NavigationArtifact, sourceDigest?: string): Promise<void> {
  if ("card_ref" in artifact) {
    const { card_ref, ...body } = artifact;
    if (!sourceDigest || !sameVersionedRef(card_ref, await sourceCardIdentity(body, sourceDigest))) {
      navigationStorageFailure("SourceCard content identity mismatch");
    }
  } else if ("map_ref" in artifact) {
    const { map_ref, ...body } = artifact;
    if (!sourceDigest || !sameVersionedRef(map_ref, await documentMapIdentity(body, sourceDigest))) {
      navigationStorageFailure("DocumentMap content identity mismatch");
    }
  } else {
    const { atlas_ref, digest, ...body } = artifact;
    const expected = await projectAtlasIdentity(body);
    if (!sameVersionedRef(atlas_ref, expected.atlas_ref) || digest !== expected.digest) {
      navigationStorageFailure("ProjectAtlas content identity mismatch");
    }
  }
}
