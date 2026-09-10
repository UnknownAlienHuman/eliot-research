-- ER-04 Q3 remainder: D1 persistence for retrieval query results and traces.
-- Additive only: creates two tables plus guards, changes no existing table,
-- backfills nothing and rewrites no applied migration. Follows the 0019/0020
-- precedent (additive file under the ER-13 number allocation; ER-13 allocates
-- numbers against current main, this file only consumes the next free number
-- 0021, verified against main before writing).
--
-- A query never mints source grants: every INSERT revalidates the frozen
-- ScopeSnapshot, the caller grant, the purge frontier and member liveness, and
-- aborts with RETRIEVAL_AUTHORITY_STALE when deny, purge or expiry
-- invalidates the scope. Traces persist only on exact ref binding: the trace
-- row identity must equal the trace_ref id/revision inside its JSON body and
-- the embedded scope digest must equal the live scope_snapshot digest,
-- otherwise the insert aborts with RETRIEVAL_TRACE_CORRUPT. Coverage stronger
-- than SAMPLED is never stored; the service caps it before persisting.
--
-- Intent -> Attempt -> Receipt -> Readback -> Reconciliation: writers use
-- INSERT ... ON CONFLICT DO NOTHING followed by an exact readback. The trace
-- is persisted before the result row; the result insert reconciles against
-- the exact trace bytes. A lost ACK reconciles against the durable rows:
-- byte-identical readback is a replay, a divergent request_digest under a
-- reused idempotency identity is a typed conflict, never a second mutation.
-- No HTTP, model or R2 effect occurs inside these statements.
--
-- Trace rows are content-addressed by their trace_ref and stay immutable
-- audit history; scope/grant/purge invalidation clears cached result bodies
-- but never deletes trace rows.
--
-- This additive, uncomposed capability does not promote the public Worker
-- readiness generation. Runtime generation changes belong to the later
-- composition/release gate.
PRAGMA foreign_keys = ON;

CREATE TABLE retrieval_query_result (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class IN (
    'owner_pwa','named_api_client','trusted_agent','federation_client'
  )),
  credential_generation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  state TEXT NOT NULL CHECK (state IN ('PENDING','COMPLETE','INVALIDATED')),
  result_json TEXT CHECK (
    result_json IS NULL OR (
      json_valid(result_json)
      AND length(CAST(result_json AS BLOB)) <= 1000000
    )
  ),
  result_digest TEXT CHECK (
    result_digest IS NULL OR (
      length(result_digest) = 64 AND result_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  trace_id TEXT,
  trace_revision INTEGER,
  coverage_claim TEXT NOT NULL CHECK (coverage_claim IN ('NONE','SAMPLED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(principal_ref, client_class, credential_generation, idempotency_key),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK ((state = 'COMPLETE') = (result_json IS NOT NULL)),
  CHECK ((result_json IS NULL) = (result_digest IS NULL)),
  CHECK ((trace_id IS NULL) = (trace_revision IS NULL)),
  CHECK (state <> 'COMPLETE' OR (result_json IS NOT NULL AND trace_id IS NOT NULL))
) STRICT;
CREATE INDEX retrieval_query_scope_idx
  ON retrieval_query_result(scope_snapshot_id, scope_snapshot_revision, state);

CREATE TABLE retrieval_query_trace (
  trace_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  trace_json TEXT NOT NULL CHECK (
    json_valid(trace_json)
    AND length(CAST(trace_json AS BLOB)) <= 262144
  ),
  trace_digest TEXT NOT NULL CHECK (
    length(trace_digest) = 64 AND trace_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(trace_id, revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK (json_extract(trace_json, '$.trace_ref.id') IS trace_id),
  CHECK (json_extract(trace_json, '$.trace_ref.revision') IS revision),
  CHECK (json_extract(trace_json, '$.scope_snapshot.snapshot_id') IS scope_snapshot_id),
  CHECK (json_extract(trace_json, '$.scope_snapshot.revision') IS scope_snapshot_revision)
) STRICT;

-- Authority gate: the frozen scope, the caller grant, the purge frontier and
-- every scope member must be live at the insert instant. Expired or denied
-- scopes persist nothing.
CREATE TRIGGER retrieval_query_result_authority BEFORE INSERT ON retrieval_query_result
WHEN NOT EXISTS (
  SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id
    AND s.revision = NEW.scope_snapshot_revision
    AND s.invalidated_at IS NULL
    AND julianday(s.expires_at) > julianday(NEW.created_at)
    AND s.purge_ledger_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
    AND EXISTS (
      SELECT 1 FROM scope_access_grant g
      WHERE g.snapshot_id = NEW.scope_snapshot_id
        AND g.snapshot_revision = NEW.scope_snapshot_revision
        AND g.principal_ref = NEW.principal_ref
        AND g.client_class = NEW.client_class
        AND g.credential_generation = NEW.credential_generation
        AND g.state = 'ACTIVE'
        AND g.policy_authority_ref = s.policy_authority_ref
        AND julianday(g.expires_at) > julianday(NEW.created_at)
    )
    AND NOT EXISTS (
      SELECT 1 FROM json_each(s.member_source_revision_refs_json) member
      WHERE NOT EXISTS (
        SELECT 1 FROM source_revision sr JOIN source src ON src.source_id = sr.source_id
        JOIN source_namespace_ownership o
          ON o.source_namespace_id = src.source_namespace_id AND o.status = 'ACTIVE'
        JOIN json_each(s.source_owner_generations_json) gen ON gen.key = member.value
        WHERE sr.source_revision_ref = member.value AND sr.purge_state = 'LIVE'
          AND sr.source_owner_generation = o.source_owner_generation
          AND gen.value = sr.source_owner_generation
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_AUTHORITY_STALE'); END;

-- Exact trace binding: the row identity must equal the trace_ref inside the
-- JSON body, and the embedded scope digest must equal the live scope row. A
-- substituted cursor aborts and stores nothing.
CREATE TRIGGER retrieval_query_trace_binding BEFORE INSERT ON retrieval_query_trace
WHEN NOT EXISTS (
  SELECT 1 FROM scope_snapshot s
  WHERE s.snapshot_id = NEW.scope_snapshot_id
    AND s.revision = NEW.scope_snapshot_revision
    AND s.invalidated_at IS NULL
    AND julianday(s.expires_at) > julianday(NEW.created_at)
    AND json_extract(NEW.trace_json, '$.trace_ref.id') IS NEW.trace_id
    AND json_extract(NEW.trace_json, '$.trace_ref.revision') IS NEW.revision
    AND json_extract(NEW.trace_json, '$.scope_snapshot.digest') IS s.snapshot_digest
)
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_TRACE_CORRUPT'); END;

CREATE TRIGGER retrieval_query_result_immutable BEFORE UPDATE ON retrieval_query_result
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.client_class IS NOT OLD.client_class
  OR NEW.credential_generation IS NOT OLD.credential_generation
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.scope_snapshot_id IS NOT OLD.scope_snapshot_id
  OR NEW.scope_snapshot_revision IS NOT OLD.scope_snapshot_revision
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.state <> 'PENDING' AND NEW.state <> 'INVALIDATED')
  OR (NEW.state = 'INVALIDATED' AND (NEW.result_json IS NOT NULL OR NEW.result_digest IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

CREATE TRIGGER retrieval_query_trace_immutable BEFORE UPDATE ON retrieval_query_trace
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

CREATE TRIGGER retrieval_query_result_no_delete BEFORE DELETE ON retrieval_query_result
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;
CREATE TRIGGER retrieval_query_trace_no_delete BEFORE DELETE ON retrieval_query_trace
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

-- Conservative invalidation mirrors orientation_request: a dead scope or a
-- revoked grant removes the cached result body. Replaying old bytes cannot
-- recreate data under an invalid scope. Trace rows stay as immutable history.
CREATE TRIGGER retrieval_query_scope_invalidated
AFTER UPDATE OF invalidated_at ON scope_snapshot WHEN NEW.invalidated_at IS NOT NULL
BEGIN
  UPDATE retrieval_query_result SET state = 'INVALIDATED', result_json = NULL,
    result_digest = NULL
  WHERE scope_snapshot_id = NEW.snapshot_id
    AND scope_snapshot_revision = NEW.revision AND state <> 'INVALIDATED';
END;

CREATE TRIGGER retrieval_query_grant_revoked
AFTER UPDATE ON scope_access_grant
WHEN NEW.state <> 'ACTIVE' OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
  OR NEW.allowed_use_json IS NOT OLD.allowed_use_json
  OR NEW.disclosure_ceiling IS NOT OLD.disclosure_ceiling
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  UPDATE retrieval_query_result SET state = 'INVALIDATED', result_json = NULL,
    result_digest = NULL
  WHERE scope_snapshot_id = OLD.snapshot_id
    AND scope_snapshot_revision = OLD.snapshot_revision
    AND principal_ref = OLD.principal_ref AND client_class = OLD.client_class
    AND credential_generation = OLD.credential_generation
    AND state <> 'INVALIDATED';
END;

CREATE TRIGGER retrieval_query_grant_deleted
AFTER DELETE ON scope_access_grant
BEGIN
  UPDATE retrieval_query_result SET state = 'INVALIDATED', result_json = NULL,
    result_digest = NULL
  WHERE scope_snapshot_id = OLD.snapshot_id
    AND scope_snapshot_revision = OLD.snapshot_revision
    AND principal_ref = OLD.principal_ref AND client_class = OLD.client_class
    AND credential_generation = OLD.credential_generation
    AND state <> 'INVALIDATED';
END;

CREATE TRIGGER retrieval_query_source_not_live
AFTER UPDATE OF purge_state ON source_revision WHEN NEW.purge_state <> 'LIVE'
BEGIN
  UPDATE retrieval_query_result SET state = 'INVALIDATED', result_json = NULL,
    result_digest = NULL
  WHERE state <> 'INVALIDATED' AND EXISTS (
    SELECT 1 FROM scope_snapshot s, json_each(s.member_source_revision_refs_json) member
    WHERE s.snapshot_id = retrieval_query_result.scope_snapshot_id
      AND s.revision = retrieval_query_result.scope_snapshot_revision
      AND member.value = NEW.source_revision_ref
  );
END;
