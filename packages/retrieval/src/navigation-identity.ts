import { DocumentMapRevisionSchema, ProjectAtlasRevisionSchema, SourceCardSchema, type VersionedRef } from "@eliotr/contracts";
import { canonicalJson, fail, requireCanonicalSize, sha256Hex } from "./navigation-codec.js";

function sourceDigest(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) fail("NAVIGATION_INPUT_INVALID", "invalid source content digest");
  return value;
}

/** The builder and persistent reader use the same established v1 identity rules. */
export async function sourceCardIdentity(
  value: unknown, contentSha256: string,
): Promise<VersionedRef> {
  requireCanonicalSize(value);
  const body = SourceCardSchema.omit({ card_ref: true }).parse(value);
  const payload = { protocol: "eliotr.source-card.v1", ...body, source_content_sha256: sourceDigest(contentSha256) };
  requireCanonicalSize(payload);
  return { id: `source-card-${(await sha256Hex(canonicalJson(payload))).slice(0, 48)}`, revision: 1 };
}

export async function documentMapIdentity(
  value: unknown, contentSha256: string,
): Promise<VersionedRef> {
  requireCanonicalSize(value);
  const body = DocumentMapRevisionSchema.omit({ map_ref: true }).parse(value);
  const payload = { protocol: "eliotr.document-map.v1", ...body, source_content_sha256: sourceDigest(contentSha256) };
  requireCanonicalSize(payload);
  return { id: `document-map-${(await sha256Hex(canonicalJson(payload))).slice(0, 48)}`, revision: 1 };
}

export async function projectAtlasIdentity(
  value: unknown,
): Promise<{ readonly atlas_ref: VersionedRef; readonly digest: string }> {
  requireCanonicalSize(value);
  const body = ProjectAtlasRevisionSchema.omit({ atlas_ref: true, digest: true }).parse(value);
  const identity = await sha256Hex(canonicalJson({ protocol: "eliotr.project-atlas.identity.v1", ...body }));
  const atlasRef = { id: `project-atlas-${identity.slice(0, 48)}`, revision: 1 };
  const digest = await sha256Hex(canonicalJson({ protocol: "eliotr.project-atlas.v1", atlas_ref: atlasRef, ...body }));
  return { atlas_ref: atlasRef, digest };
}
