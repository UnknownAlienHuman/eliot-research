import type { IngestClientAuthorization, PreparedIngestOperation } from "./d1-ingest-types.js";
import { authorityFail, authorityIso } from "./d1-ingest-validation.js";
import { canonicalJson } from "./ingest-validation.js";

/** Request credentials never replace the immutable grant/author stored on an upload. */
export async function requireIngestClientOperation(database: D1Database, operation: PreparedIngestOperation,
  client: IngestClientAuthorization | undefined): Promise<void> {
  if (!operation.client_origin && !client) return;
  if (!client || !operation.client_origin || canonicalJson(client.origin) !== canonicalJson(operation.client_origin) ||
      client.origin.grant.grantee.subject !== operation.principal_ref) {
    authorityFail("INGEST_POLICY_DENIED", "Import belongs to a different actor or delegation revision");
  }
  await client.requireCurrent();
  const row = await database.prepare("SELECT operation_id FROM bundle_ingest_client_authorized WHERE operation_id=?1")
    .bind(operation.operation_id).first<{ operation_id: string }>();
  if (row === null) authorityFail("INGEST_POLICY_DENIED", "The original namespace delegation is no longer current");
  if (Date.parse(authorityIso(client.credential_expires_at, "service credential expiry")) <= Date.now()) {
    authorityFail("INGEST_POLICY_DENIED", "The service credential has expired");
  }
}

/** An assertion-only SQL view: no new journal or persisted grant. Runs INSIDE each D1 batch. */
export function ingestClientFence(database: D1Database, operationId: string,
  client: IngestClientAuthorization | undefined): readonly D1PreparedStatement[] {
  return client ? [database.prepare("INSERT INTO bundle_ingest_client_write_fence(operation_id,origin_json,credential_expires_at,project_generation) VALUES (?1,?2,?3,?4)")
    .bind(operationId, canonicalJson(client.origin), authorityIso(client.credential_expires_at, "service credential expiry"), client.project_generation)] : [];
}
