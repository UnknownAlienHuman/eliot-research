import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";
import type { ScopeSnapshot } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import { ORIENTATION_TTL_MS, orientationFail, orientationId } from "./orientation-input.js";

export interface OrientationOperation {
  operation_id: string; principal_ref: string; client_class: string; credential_generation: string;
  idempotency_key: string; request_digest: string; state: "PREPARED" | "COMPLETE" | "INVALIDATED";
  snapshot_id: string | null; snapshot_revision: number | null;
  result_json: string | null; result_digest: string | null; created_at: string; expires_at: string;
}
const fields = "operation_id,principal_ref,client_class,credential_generation,idempotency_key,request_digest,state," +
  "snapshot_id,snapshot_revision,created_at,expires_at," +
  "CASE WHEN length(CAST(result_json AS BLOB))<=450000 THEN result_json ELSE NULL END AS result_json,result_digest";

export function orientationStorage(db: D1Database, context: AuthenticatedRequestContext, now: () => number = Date.now) {
  async function read(id: string): Promise<OrientationOperation | null> {
    orientationId(id);
    const row = await db.prepare(`SELECT ${fields} FROM orientation_request WHERE operation_id=?1 AND principal_ref=?2 ` +
      "AND client_class=?3 AND credential_generation=?4").bind(id, context.principal_ref, context.client_class,
      context.credential_generation).first<OrientationOperation>();
    if (!row) return null;
    if (!["PREPARED", "COMPLETE", "INVALIDATED"].includes(row.state) || !Number.isFinite(Date.parse(row.created_at)) ||
        !Number.isFinite(Date.parse(row.expires_at))) orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
    if (row.state === "INVALIDATED" || Date.parse(row.expires_at) <= now()) orientationFail("ORIENTATION_OPERATION_EXPIRED", 409);
    if (row.state === "COMPLETE" && (!row.result_json || !row.result_digest)) orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
    if (row.result_json !== null) {
      let value: unknown;
      try { value = JSON.parse(row.result_json); } catch { orientationFail("ORIENTATION_OPERATION_CORRUPT", 409); }
      if (canonicalEvidenceJson(value) !== row.result_json || await evidenceSha256(value) !== row.result_digest) {
        orientationFail("ORIENTATION_OPERATION_CORRUPT", 409);
      }
    }
    return row;
  }
  async function reserve(request: QueryRequest): Promise<OrientationOperation> {
    const key = orientationId(context.request.headers.get("idempotency-key"));
    const id = `orient-${await evidenceSha256({ principal: context.principal_ref, client: context.client_class,
      credential: context.credential_generation, key })}`;
    const digest = await evidenceSha256(request);
    let current = await read(id);
    if (!current) {
      const timestamp = new Date(now()).toISOString();
      try {
        await db.prepare("INSERT INTO orientation_request (operation_id,principal_ref,client_class,credential_generation," +
          "idempotency_key,request_digest,state,created_at,expires_at) VALUES (?1,?2,?3,?4,?5,?6,'PREPARED',?7,?8) " +
          "ON CONFLICT DO NOTHING").bind(id, context.principal_ref, context.client_class, context.credential_generation,
          key, digest, timestamp, new Date(Date.parse(timestamp) + ORIENTATION_TTL_MS).toISOString()).run();
      } catch { /* Only exact readback may resolve an uncertain reservation. */ }
      current = await read(id);
      if (!current) orientationFail("ORIENTATION_RESERVATION_UNCERTAIN", 503, true);
    }
    if (current.request_digest !== digest) orientationFail("ORIENTATION_IDEMPOTENCY_CONFLICT", 409);
    return current;
  }
  async function bindScope(operation: OrientationOperation, snapshot: ScopeSnapshot): Promise<OrientationOperation> {
    try {
      await db.prepare("UPDATE orientation_request SET snapshot_id=?2,snapshot_revision=?3 WHERE operation_id=?1 " +
        "AND state='PREPARED' AND snapshot_id IS NULL AND request_digest=?4")
        .bind(operation.operation_id, snapshot.snapshot_id, snapshot.revision, operation.request_digest).run();
    } catch { /* Inspect the winning immutable scope binding, never issue a replacement write. */ }
    const row = await read(operation.operation_id);
    if (!row || row.snapshot_id !== snapshot.snapshot_id || row.snapshot_revision !== snapshot.revision) {
      orientationFail("ORIENTATION_SCOPE_BINDING_CONFLICT", 409);
    }
    return row;
  }
  async function complete(operation: OrientationOperation, snapshot: ScopeSnapshot, payload: unknown): Promise<OrientationOperation> {
    const json = canonicalEvidenceJson(payload);
    if (new TextEncoder().encode(json).byteLength > 450000) orientationFail("ORIENTATION_RESULT_LIMIT", 413);
    const digest = await evidenceSha256(payload);
    try {
      await db.prepare("UPDATE orientation_request SET state='COMPLETE',result_json=?2,result_digest=?3 " +
        "WHERE operation_id=?1 AND state='PREPARED' AND snapshot_id=?4 AND snapshot_revision=?5 " +
        "AND EXISTS (SELECT 1 FROM scope_snapshot s JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id " +
        "AND g.snapshot_revision=s.revision WHERE s.snapshot_id=?4 AND s.revision=?5 AND s.snapshot_digest=?6 " +
        "AND s.invalidated_at IS NULL AND g.state='ACTIVE' AND g.principal_ref=?7 AND g.client_class=?8 " +
        "AND g.credential_generation=?9 AND julianday(g.expires_at)>julianday(?10) AND julianday(s.expires_at)>julianday(?10))")
        .bind(operation.operation_id, json, digest, snapshot.snapshot_id, snapshot.revision, snapshot.digest,
          context.principal_ref, context.client_class, context.credential_generation, new Date(now()).toISOString()).run();
    } catch { /* A lost final ACK is resolved by the same exact result, not a second execution. */ }
    const row = await read(operation.operation_id);
    if (!row || row.state !== "COMPLETE" || row.result_json !== json || row.result_digest !== digest) {
      orientationFail("ORIENTATION_RESULT_UNCERTAIN", 503, true);
    }
    return row;
  }
  return { read, reserve, bindScope, complete };
}
