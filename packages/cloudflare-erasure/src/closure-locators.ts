import type { ErasureFence } from "@eliotr/contracts";
import { erasureFail } from "./canonical.js";

// These rows preserve observed physical locations, not deletion authority.
// Every replay still requires a current owner request, execution fence,
// fresh shared-reference/hold checks, and provider absence readback.
export function retainErasureLocatorsStatement(
  database: D1Database,
  fence: ErasureFence,
  now: string,
): D1PreparedStatement {
  return database.prepare(
    "INSERT INTO erasure_dependency_registry(dependency_id,exact_subject_ref,location," +
    "canonical_ref,provider_ref,object_identity_digest,state,created_at,updated_at) " +
    "SELECT 'erasure-locator-'||t.target_id,t.exact_subject_ref,t.location,t.canonical_ref," +
    "t.provider_ref,t.identity_digest,'ACTIVE',?5,?5 FROM erasure_target t " +
    "JOIN erasure_execution e ON e.erasure_id=t.erasure_id AND e.revision=t.erasure_revision " +
    "WHERE e.erasure_id=?1 AND e.revision=?2 AND e.lease_owner=?3 AND e.lease_generation=?4 " +
    "AND e.lease_until>?6 AND e.state IN ('REQUESTED','QUARANTINE_AND_REVOKE') " +
    "AND t.target_kind='OBJECT' AND EXISTS " +
    "(SELECT 1 FROM json_each(e.request_json,'$.exact_subject_refs') WHERE value=t.exact_subject_ref) " +
    "ON CONFLICT(exact_subject_ref,location,canonical_ref) DO UPDATE SET " +
    "updated_at=excluded.updated_at,state='ACTIVE' " +
    "WHERE erasure_dependency_registry.object_identity_digest=excluded.object_identity_digest " +
    "AND erasure_dependency_registry.provider_ref IS excluded.provider_ref",
  ).bind(
    fence.erasure_id, fence.revision, fence.lease_owner,
    fence.lease_generation, now, Date.parse(now),
  );
}

export async function assertErasureLocatorsRetained(
  database: D1Database,
  fence: ErasureFence,
  now: string,
): Promise<void> {
  const row = await database.prepare(
    "SELECT (SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=e.erasure_id " +
    "AND t.erasure_revision=e.revision AND t.target_kind='OBJECT' AND (NOT EXISTS " +
    "(SELECT 1 FROM json_each(e.request_json,'$.exact_subject_refs') WHERE value=t.exact_subject_ref) " +
    "OR NOT EXISTS (SELECT 1 FROM erasure_dependency_registry d " +
    "WHERE d.exact_subject_ref=t.exact_subject_ref AND d.location=t.location " +
    "AND d.canonical_ref=t.canonical_ref AND d.provider_ref IS t.provider_ref " +
    "AND d.object_identity_digest=t.identity_digest AND d.state='ACTIVE'))) AS missing " +
    "FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 " +
    "AND e.lease_owner=?3 AND e.lease_generation=?4 AND e.lease_until>?5 " +
    "AND e.state IN ('REQUESTED','QUARANTINE_AND_REVOKE') LIMIT 1",
  ).bind(
    fence.erasure_id, fence.revision, fence.lease_owner,
    fence.lease_generation, Date.parse(now),
  ).first<{ missing: unknown }>();
  if (row === null) {
    erasureFail("ERASURE_LEASE_LOST", "erasure locator retention lost its execution fence", true);
  }
  if (row.missing !== 0) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "an erasure object locator was not retained with its exact identity");
  }
}
