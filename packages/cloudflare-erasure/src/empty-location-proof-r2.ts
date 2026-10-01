import type { ErasureRequest, PurgeTarget } from "@eliotr/contracts";
import {
  assertErasureText,
  erasureDigest,
  erasureFail,
  erasureSha256Utf8,
  validateErasureRequest,
} from "./canonical.js";
import { readEmptyProofAuthorityDigest, readErasureRootIdentity } from "./empty-location-proof-authority.js";
import {
  assertEmptyProofSubjectRootBinding,
  createEmptyLocationProofTarget,
  parseEmptyLocationProof,
  type EmptyLocationProofBody,
} from "./empty-location-proof.js";

const MAX_KEYS = 100_000;
const MAX_PAGES = 1024;

export function projectionWorkPrefix(sourceRevisionRef: string): Promise<string> {
  return erasureSha256Utf8(["source", sourceRevisionRef].join("\u0000"))
    .then((digest) => `projection/${digest.slice(0, 48)}/`);
}

export async function listR2WorkPrefix(bucket: R2Bucket, prefix: string): Promise<readonly string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: R2Objects;
    try {
      result = await bucket.list({ prefix, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    } catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "R2 Work empty-proof inventory failed", true, cause);
    }
    for (const object of result.objects) {
      const key = assertErasureText(object.key, "R2 Work key", 1024);
      if (!key.startsWith(prefix)) erasureFail("ERASURE_IDENTITY_CONFLICT", "R2 Work inventory escaped its exact prefix");
      keys.push(key);
      if (keys.length > MAX_KEYS) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "R2 Work namespace exceeds its bound");
    }
    if (!result.truncated) return keys.sort();
    const next = assertErasureText(result.cursor, "R2 Work cursor", 2048);
    if (next === cursor || seen.has(next)) erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "R2 Work cursor did not advance", true);
    seen.add(next);
    cursor = next;
  }
  erasureFail("ERASURE_CLOSURE_INCOMPLETE", "R2 Work inventory exceeded its page ceiling");
}

export interface R2WorkEmptySnapshot {
  readonly prefix: string;
  readonly keys: readonly string[];
  readonly namespaceDigest: string;
}

export async function readR2WorkEmptySnapshot(bucket: R2Bucket, sourceRevisionRef: string): Promise<R2WorkEmptySnapshot> {
  const prefix = await projectionWorkPrefix(sourceRevisionRef);
  const keys = await listR2WorkPrefix(bucket, prefix);
  return { prefix, keys, namespaceDigest: await erasureDigest(keys) };
}

export async function makeR2WorkEmptyProofTarget(
  core: D1Database,
  bucket: R2Bucket,
  requestDigest: string,
  subjectRef: string,
  sourceRevisionRef: string,
): Promise<{ readonly target: PurgeTarget | null; readonly prefix: string }> {
  const [root, authorityDigest, snapshot] = await Promise.all([
    readErasureRootIdentity(core, sourceRevisionRef),
    readEmptyProofAuthorityDigest(core, sourceRevisionRef, subjectRef, "Projection"),
    readR2WorkEmptySnapshot(bucket, sourceRevisionRef),
  ]);
  if (snapshot.keys.length > 0) return { target: null, prefix: snapshot.prefix };
  const body: EmptyLocationProofBody = {
    request_digest: requestDigest,
    exact_subject_ref: subjectRef,
    location: "Projection",
    root_identity: root,
    namespace_snapshot: {
      authority_digest: authorityDigest,
      namespace_digest: snapshot.namespaceDigest,
      namespace_generation: "r2-work-prefix-list.v1",
      namespace_ref: snapshot.prefix,
      object_count: 0,
    },
  };
  return { target: await createEmptyLocationProofTarget(body), prefix: snapshot.prefix };
}

export async function validateR2WorkEmptyProof(
  core: D1Database,
  bucket: R2Bucket,
  request: ErasureRequest,
  target: PurgeTarget,
): Promise<void> {
  const proof = await parseEmptyLocationProof(target);
  const normalized = validateErasureRequest(request);
  if (proof.location !== "Projection" || proof.request_digest !== await erasureDigest(normalized) ||
    !normalized.exact_subject_refs.includes(proof.exact_subject_ref)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "R2 Work empty proof does not bind to this request");
  }
  assertEmptyProofSubjectRootBinding(proof);
  const sourceRevisionRef = proof.root_identity.source_revision_ref;
  const [root, authorityDigest, snapshot] = await Promise.all([
    readErasureRootIdentity(core, sourceRevisionRef),
    readEmptyProofAuthorityDigest(core, sourceRevisionRef, proof.exact_subject_ref, "Projection"),
    readR2WorkEmptySnapshot(bucket, sourceRevisionRef),
  ]);
  if (await erasureDigest(root) !== await erasureDigest(proof.root_identity) ||
    proof.namespace_snapshot.namespace_generation !== "r2-work-prefix-list.v1" ||
    proof.namespace_snapshot.namespace_ref !== snapshot.prefix ||
    proof.namespace_snapshot.object_count !== 0 || snapshot.keys.length !== 0 ||
    snapshot.namespaceDigest !== proof.namespace_snapshot.namespace_digest ||
    authorityDigest !== proof.namespace_snapshot.authority_digest) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "R2 Work empty proof is stale or its source namespace is not empty");
  }
}
