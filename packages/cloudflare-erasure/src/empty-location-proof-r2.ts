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

interface RegisteredWorkRow {
  readonly canonical_ref: string;
  readonly object_identity_digest: string;
}

/** Registry lookup is source exact; target-wide R2 scans are never authorized. */
export async function readRegisteredWorkEmptySnapshot(
  core: D1Database,
  bucket: R2Bucket,
  sourceRevisionRef: string,
  subjectRef: string,
  verifyRootDependencySet?: (rootRef: string) => Promise<void>,
): Promise<{ readonly keys: readonly string[]; readonly live_root_count: number; readonly generation: string; readonly digest: string }> {
  const result = await core.prepare(
    "SELECT canonical_ref,object_identity_digest FROM erasure_dependency_registry " +
    "WHERE exact_subject_ref IN (?1,?2) AND location='Projection' AND state='ACTIVE' " +
    "ORDER BY dependency_id LIMIT 10001",
  ).bind(subjectRef, `source-revision:${sourceRevisionRef}`).all<RegisteredWorkRow>();
  if (result.success !== true || !Array.isArray(result.results)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "registered Work inventory is unavailable", true);
  }
  if (result.results.length > 10_000) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "registered Work inventory exceeds its bound");
  const keys = new Set<string>();
  // The current registry has no managed-root columns. If a caller still
  // requires root verification, keep every row unresolved because it cannot
  // be bound to a root from the persisted registry contract.
  const liveRootCount = verifyRootDependencySet === undefined ? 0 : result.results.length;
  for (const row of result.results) {
    if (!row.canonical_ref.startsWith("r2-work:")) {
      erasureFail("ERASURE_IDENTITY_CONFLICT", "registered Work dependency is malformed");
    }
    const key = assertErasureText(row.canonical_ref.slice("r2-work:".length), "registered Work key", 1024);
    try { if (await bucket.head(key) !== null) keys.add(key); }
    catch (cause) { erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "registered Work absence readback failed", true, cause); }
  }
  return {
    keys: [...keys].sort(), live_root_count: liveRootCount,
    generation: result.results.length === 0 ? "r2-work-prefix-list.v1" : "r2-work-source-dependencies.v2",
    digest: await erasureDigest({ registered_dependencies: result.results, present_keys: [...keys].sort() }),
  };
}

export async function readR2WorkEmptySnapshot(bucket: R2Bucket, sourceRevisionRef: string): Promise<R2WorkEmptySnapshot> {
  const prefix = await projectionWorkPrefix(sourceRevisionRef);
  const keys = await listR2WorkPrefix(bucket, prefix);
  return { prefix, keys, namespaceDigest: await erasureDigest(keys) };
}

async function assertSourceAuthorityStable(
  core: D1Database,
  sourceRevisionRef: string,
  subjectRef: string,
  root: EmptyLocationProofBody["root_identity"],
  authorityDigest: string,
): Promise<void> {
  const [currentRoot, currentAuthorityDigest] = await Promise.all([
    readErasureRootIdentity(core, sourceRevisionRef),
    readEmptyProofAuthorityDigest(core, sourceRevisionRef, subjectRef, "Projection"),
  ]);
  if (
    await erasureDigest(currentRoot) !== await erasureDigest(root) ||
    currentAuthorityDigest !== authorityDigest
  ) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "source root or projection authority changed during R2 Work inventory");
}

export async function makeR2WorkEmptyProofTarget(
  core: D1Database,
  bucket: R2Bucket,
  requestDigest: string,
  subjectRef: string,
  sourceRevisionRef: string,
  verifyRootDependencySet?: (rootRef: string) => Promise<void>,
): Promise<{ readonly target: PurgeTarget | null; readonly prefix: string }> {
  const [root, authorityDigest, snapshot, registered] = await Promise.all([
    readErasureRootIdentity(core, sourceRevisionRef),
    readEmptyProofAuthorityDigest(core, sourceRevisionRef, subjectRef, "Projection"),
    readR2WorkEmptySnapshot(bucket, sourceRevisionRef),
    readRegisteredWorkEmptySnapshot(core, bucket, sourceRevisionRef, subjectRef, verifyRootDependencySet),
  ]);
  await assertSourceAuthorityStable(core, sourceRevisionRef, subjectRef, root, authorityDigest);
  if (snapshot.keys.length > 0 || registered.keys.length > 0 || registered.live_root_count > 0) {
    return { target: null, prefix: snapshot.prefix };
  }
  const body: EmptyLocationProofBody = {
    request_digest: requestDigest,
    exact_subject_ref: subjectRef,
    location: "Projection",
    root_identity: root,
    namespace_snapshot: {
      authority_digest: authorityDigest,
      namespace_digest: registered.generation === "r2-work-prefix-list.v1" ? snapshot.namespaceDigest :
        await erasureDigest({ source_namespace_digest: snapshot.namespaceDigest, registered_digest: registered.digest }),
      namespace_generation: registered.generation,
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
  verifyRootDependencySet?: (rootRef: string) => Promise<void>,
): Promise<void> {
  const proof = await parseEmptyLocationProof(target);
  const normalized = validateErasureRequest(request);
  if (proof.location !== "Projection" || proof.request_digest !== await erasureDigest(normalized) ||
    !normalized.exact_subject_refs.includes(proof.exact_subject_ref)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "R2 Work empty proof does not bind to this request");
  }
  assertEmptyProofSubjectRootBinding(proof);
  const sourceRevisionRef = proof.root_identity.source_revision_ref;
  const [root, authorityDigest, snapshot, registered] = await Promise.all([
    readErasureRootIdentity(core, sourceRevisionRef),
    readEmptyProofAuthorityDigest(core, sourceRevisionRef, proof.exact_subject_ref, "Projection"),
    readR2WorkEmptySnapshot(bucket, sourceRevisionRef),
    readRegisteredWorkEmptySnapshot(core, bucket, sourceRevisionRef, proof.exact_subject_ref, verifyRootDependencySet),
  ]);
  await assertSourceAuthorityStable(core, sourceRevisionRef, proof.exact_subject_ref, root, authorityDigest);
  const namespaceDigest = registered.generation === "r2-work-prefix-list.v1" ? snapshot.namespaceDigest :
    await erasureDigest({ source_namespace_digest: snapshot.namespaceDigest, registered_digest: registered.digest });
  if (await erasureDigest(root) !== await erasureDigest(proof.root_identity) ||
    proof.namespace_snapshot.namespace_generation !== registered.generation ||
    proof.namespace_snapshot.namespace_ref !== snapshot.prefix ||
    proof.namespace_snapshot.object_count !== 0 || snapshot.keys.length !== 0 ||
    registered.keys.length > 0 || registered.live_root_count > 0 ||
    namespaceDigest !== proof.namespace_snapshot.namespace_digest ||
    authorityDigest !== proof.namespace_snapshot.authority_digest) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "R2 Work empty proof is stale or its source namespace is not empty");
  }
}
