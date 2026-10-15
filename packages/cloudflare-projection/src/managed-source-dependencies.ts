import {
  assertProjectionIdentifier,
  assertProjectionSha256,
  assertProjectionText,
  canonicalProjectionJson,
  projectionDigest,
  projectionFail,
  projectionSha256Utf8,
} from "./canonical.js";

/** Exact immutable objects, never a whole target prefix. */
export interface ManagedSourceWorkDependency {
  readonly key: string;
  readonly sha256: string;
  readonly kind: "CANONICAL" | "COPY_REF" | "SHARED_REF";
}

export interface ManagedDependencySourceFence {
  readonly source_revision_ref: string;
  readonly source_id: string;
  readonly source_namespace_id: string;
  readonly source_owner_system_id: string;
  readonly source_owner_generation: string;
  readonly object_residency_key_digest: string;
  readonly content_sha256: string;
  readonly ownership_record_revision: number;
  readonly source_admission_policy_revision: number;
  readonly source_class: string;
  readonly admission_decision_receipt_ref: string;
  readonly admission_decision_sha256: string;
}

export interface ManagedManifestDependencyRoot {
  readonly protocol: "eliotr.managed-manifest-dependency-root.v1";
  readonly root_ref: string;
  readonly build_prefix: string;
}

interface RegisteredRow {
  readonly dependency_id: string;
  readonly canonical_ref: string;
  readonly object_identity_digest: string;
  readonly shared_reference_key: string | null;
  readonly managed_root_ref: string | null;
  readonly managed_object_kind: string;
  readonly managed_root_state: string | null;
  readonly managed_source_fence_json: string;
  readonly state: string;
}

const MAX_DEPENDENCIES_PER_BATCH = 64;
const SOURCE_FENCE_SQL =
  "SELECT 1 FROM source_revision sr JOIN source s ON s.source_id=sr.source_id " +
  "JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id " +
  "AND own.owner_system_id=s.source_owner_system_id " +
  "JOIN source_admission_decision d ON d.source_revision_ref=sr.source_revision_ref " +
  "JOIN source_admission_policy ap ON ap.source_namespace_id=s.source_namespace_id " +
  "AND ap.source_class=s.source_class AND ap.revision=own.source_admission_policy_revision " +
  "WHERE sr.source_revision_ref=?1 AND sr.source_id=?2 AND s.head_rev=sr.source_revision_ref " +
  "AND s.source_namespace_id=?3 AND s.source_owner_system_id=?4 " +
  "AND sr.source_owner_generation=?5 AND own.source_owner_generation=?5 " +
  "AND s.source_owner_generation=?5 AND sr.object_residency_key_digest=?6 " +
  "AND sr.content_sha256=?7 AND own.ownership_record_revision=?8 " +
  "AND own.status='ACTIVE' AND sr.purge_state='LIVE' " +
  "AND own.source_admission_policy_revision=?9 AND s.source_class=?10 AND d.source_class=?10 " +
  "AND d.decision_receipt_ref=?11 AND d.decision_sha256=?12 AND d.decision='ADMITTED' " +
  "AND d.source_owner_generation=?5 AND d.owner_system_id=own.owner_system_id " +
  "AND d.source_namespace_id=s.source_namespace_id " +
  "AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday(?13)) " +
  "AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref " +
  "FROM source_admission_decision chosen WHERE chosen.source_revision_ref=sr.source_revision_ref " +
  "AND chosen.decision='ADMITTED' ORDER BY chosen.created_at DESC,chosen.decision_receipt_ref DESC LIMIT 1)";

const FENCE_FIELDS = ["source_revision_ref", "source_id", "source_namespace_id", "source_owner_system_id",
  "source_owner_generation", "object_residency_key_digest", "content_sha256", "ownership_record_revision",
  "source_admission_policy_revision", "source_class", "admission_decision_receipt_ref", "admission_decision_sha256"] as const;
// Reuse exactly the registration predicate against each persisted fence. Root
// publication and every root read use D1's current time for admission expiry.
const ROOT_SOURCE_CURRENT_SQL = SOURCE_FENCE_SQL.replace(/\?(\d+)/gu, (_match, number: string) => {
  const index = Number(number);
  return index === 13 ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" :
    `json_extract(dep.managed_source_fence_json,'$.${FENCE_FIELDS[index - 1]}')`;
});

function sourceBindings(source: ManagedDependencySourceFence, asOf: string): readonly (string | number)[] {
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith("sha256") || key.endsWith("digest")) assertProjectionSha256(value, key);
    else if (key !== "ownership_record_revision" && key !== "source_admission_policy_revision") assertProjectionIdentifier(value, key);
  }
  if (![source.ownership_record_revision, source.source_admission_policy_revision].every((n) => Number.isSafeInteger(n) && n > 0)) {
    projectionFail("PROJECTION_INPUT_INVALID", "source ownership revision is invalid");
  }
  if (!Number.isFinite(Date.parse(asOf))) projectionFail("PROJECTION_INPUT_INVALID", "dependency timestamp is invalid");
  return [source.source_revision_ref, source.source_id, source.source_namespace_id,
    source.source_owner_system_id, source.source_owner_generation, source.object_residency_key_digest,
    source.content_sha256, source.ownership_record_revision, source.source_admission_policy_revision, source.source_class, source.admission_decision_receipt_ref,
    source.admission_decision_sha256, asOf];
}

async function validateRoot(root: ManagedManifestDependencyRoot): Promise<void> {
  if (root.protocol !== "eliotr.managed-manifest-dependency-root.v1" ||
      !root.build_prefix.startsWith("managed-target-manifests/") || !root.build_prefix.endsWith("/")) {
    projectionFail("PROJECTION_INPUT_INVALID", "managed manifest dependency root is invalid");
  }
  assertProjectionText(root.build_prefix, "managed build prefix", 900);
  if (root.root_ref !== `managed-root:${await projectionSha256Utf8(root.build_prefix)}`) {
    projectionFail("PROJECTION_INPUT_INVALID", "dependency root does not bind the exact build prefix");
  }
}

export async function managedManifestDependencyRoot(buildPrefix: string): Promise<ManagedManifestDependencyRoot> {
  const root = Object.freeze({
    protocol: "eliotr.managed-manifest-dependency-root.v1" as const,
    root_ref: `managed-root:${await projectionSha256Utf8(buildPrefix)}`,
    build_prefix: buildPrefix,
  });
  await validateRoot(root);
  return root;
}

function complete<T>(result: D1Result<T>, label: string): readonly T[] {
  if (result.success !== true || !Array.isArray(result.results)) {
    projectionFail("PROJECTION_SETTLEMENT_UNCERTAIN", `${label} was not readback verified`, true);
  }
  return result.results;
}

/** Called after immutable Work success, including on replay after a lost ACK. */
export function createD1ManagedSourceDependencies(database: D1Database) {
  return Object.freeze({
    async register(input: {
      readonly root: ManagedManifestDependencyRoot;
      readonly source: ManagedDependencySourceFence;
      readonly objects: readonly ManagedSourceWorkDependency[];
      readonly as_of: string;
    }): Promise<{ readonly protocol: "eliotr.managed-source-dependencies.v1"; readonly registered_count: number }> {
      await validateRoot(input.root);
      const bindings = sourceBindings(input.source, input.as_of);
      const sourceFenceJson = canonicalProjectionJson(input.source);
      if (input.objects.length < 1 || input.objects.length > MAX_DEPENDENCIES_PER_BATCH) {
        projectionFail("PROJECTION_INPUT_INVALID", "dependency registration requires 1..64 exact objects");
      }
      const subject = `source-revision:${input.source.source_revision_ref}`;
      const canonicalPrefix = `projection/${(await projectionSha256Utf8(`source\0${input.source.source_revision_ref}`)).slice(0, 48)}/`;
      const seen = new Set<string>();
      const expected: RegisteredRow[] = [];
      const statements: D1PreparedStatement[] = [];
      for (const object of input.objects) {
        assertProjectionText(object.key, "Work dependency key", 1024);
        assertProjectionSha256(object.sha256, "Work dependency digest");
        if (!["CANONICAL", "COPY_REF", "SHARED_REF"].includes(object.kind) || seen.has(object.key) ||
            !(object.kind === "CANONICAL" ? object.key.startsWith(canonicalPrefix) : object.key.startsWith(input.root.build_prefix))) {
          projectionFail("PROJECTION_INPUT_INVALID", "Work dependency escaped its source/build namespace or is duplicated");
        }
        seen.add(object.key);
        const canonicalRef = `r2-work:${object.key}`;
        const identity = await projectionDigest({
          exact_subject_ref: subject, location: "Projection", canonical_ref: canonicalRef, provider_ref: null,
        });
        // The immutable bytes digest is part of the deterministic dependency ID;
        // replay cannot silently register different bytes at the same key.
        const dependencyId = `managed-dependency:${await projectionDigest({ subject, canonicalRef, sha256: object.sha256 })}`;
        const rootRef = object.kind === "CANONICAL" ? null : input.root.root_ref;
        const sharedRef = object.kind === "SHARED_REF" ? `managed-shared:${await projectionSha256Utf8(object.key)}` : null;
        expected.push({ dependency_id: dependencyId, canonical_ref: canonicalRef, object_identity_digest: identity,
          shared_reference_key: sharedRef, managed_root_ref: rootRef, managed_object_kind: object.kind,
          managed_root_state: rootRef === null ? null : "BUILDING", managed_source_fence_json: sourceFenceJson, state: "ACTIVE" });
        statements.push(database.prepare(
          "INSERT INTO erasure_dependency_registry(dependency_id,exact_subject_ref,location,canonical_ref," +
          "object_identity_digest,shared_reference_key,managed_root_ref,managed_object_kind,managed_root_state," +
          "managed_source_fence_json,state,created_at,updated_at) SELECT ?14,?15,'Projection',?16,?17,?18,?19,?20,?21,?22,'ACTIVE',?13,?13 " +
          `WHERE EXISTS (${SOURCE_FENCE_SQL}) AND NOT EXISTS (SELECT 1 FROM erasure_dependency_registry ` +
          "WHERE exact_subject_ref=?15 AND location='Projection' AND canonical_ref=?16)"
        ).bind(...bindings, dependencyId, subject, canonicalRef, identity, sharedRef, rootRef, object.kind,
          rootRef === null ? null : "BUILDING", sourceFenceJson));
      }
      const result = await database.batch(statements);
      if (result.length !== statements.length || result.some((row) => row.success !== true)) {
        projectionFail("PROJECTION_SETTLEMENT_UNCERTAIN", "source dependencies were not durably acknowledged", true);
      }
      const readback = complete(await database.prepare(
        "SELECT dependency_id,canonical_ref,object_identity_digest,shared_reference_key,managed_root_ref," +
        "managed_object_kind,managed_root_state,managed_source_fence_json,state FROM erasure_dependency_registry " +
        "WHERE exact_subject_ref=?14 AND location='Projection' AND canonical_ref IN " +
        "(SELECT value FROM json_each(?15)) AND EXISTS (" + SOURCE_FENCE_SQL + ")"
      ).bind(...bindings, subject, JSON.stringify(expected.map((row) => row.canonical_ref))).all<RegisteredRow>(), "source dependency registration");
      if (readback.length !== expected.length || expected.some((row) => !readback.some((found) =>
        found.dependency_id === row.dependency_id && found.canonical_ref === row.canonical_ref &&
        found.object_identity_digest === row.object_identity_digest && found.shared_reference_key === row.shared_reference_key &&
        found.managed_root_ref === row.managed_root_ref && found.managed_object_kind === row.managed_object_kind &&
        (row.managed_root_ref === null || found.managed_source_fence_json === row.managed_source_fence_json) &&
        found.state === "ACTIVE" && (found.managed_root_state === row.managed_root_state || found.managed_root_state === "ACTIVE")))) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "source authority or immutable dependency changed before readback");
      }
      return Object.freeze({ protocol: "eliotr.managed-source-dependencies.v1" as const, registered_count: expected.length });
    },
    async activateRoot(root: ManagedManifestDependencyRoot, expectedSourceCount: number, expectedCopyCount: number): Promise<void> {
      await validateRoot(root);
      if (![expectedSourceCount, expectedCopyCount].every((count) => Number.isSafeInteger(count) && count > 0)) {
        projectionFail("PROJECTION_INPUT_INVALID", "root membership counts are invalid");
      }
      await database.prepare(
        "UPDATE erasure_dependency_registry SET managed_root_state='ACTIVE' " +
        "WHERE managed_root_ref=?1 AND managed_root_state='BUILDING' AND state='ACTIVE' " +
        "AND ?2=(SELECT COUNT(DISTINCT exact_subject_ref) FROM erasure_dependency_registry WHERE managed_root_ref=?1 AND state='ACTIVE') " +
        "AND ?3=(SELECT COUNT(*) FROM erasure_dependency_registry WHERE managed_root_ref=?1 AND managed_object_kind='COPY_REF' AND state='ACTIVE') " +
        "AND NOT EXISTS (SELECT 1 FROM erasure_dependency_registry dep " +
        "WHERE dep.managed_root_ref=?1 AND (dep.managed_root_state='BLOCKED' OR dep.state<>'ACTIVE' " +
        `OR NOT EXISTS (${ROOT_SOURCE_CURRENT_SQL})))`
      ).bind(root.root_ref, expectedSourceCount, expectedCopyCount).run();
      await this.assertActiveRoot(root, expectedSourceCount, expectedCopyCount);
    },
    async assertActiveRoot(root: ManagedManifestDependencyRoot, expectedSourceCount: number, expectedCopyCount: number): Promise<void> {
      await validateRoot(root);
      const rows = complete(await database.prepare(
        "SELECT COUNT(DISTINCT exact_subject_ref) AS sources," +
        "SUM(CASE WHEN managed_object_kind='COPY_REF' THEN 1 ELSE 0 END) AS copies," +
        `SUM(CASE WHEN managed_root_state<>'ACTIVE' OR dep.state<>'ACTIVE' OR NOT EXISTS (${ROOT_SOURCE_CURRENT_SQL}) THEN 1 ELSE 0 END) AS invalid ` +
        "FROM erasure_dependency_registry dep WHERE dep.managed_root_ref=?1"
      ).bind(root.root_ref).all<{ sources: number; copies: number; invalid: number | null }>(), "managed root currentness");
      if (rows.length !== 1 || rows[0]?.sources !== expectedSourceCount || rows[0]?.copies !== expectedCopyCount || rows[0]?.invalid !== 0) {
        projectionFail("PROJECTION_AUTHORITY_CONFLICT", "managed root is incomplete, blocked, or no longer current");
      }
    },
  });
}
