-- ER-07 Q7 remainder: D1 persistence for the ordered exhaustive reconcile loop.
-- Additive only: creates two tables plus guards, changes no existing table,
-- backfills nothing and rewrites no applied migration. Consumes the next free
-- number 0023, verified against main before writing (0022 is taken by the
-- retrieval scope profile).
--
-- Why a new table instead of widening retrieval_query_result: the 0021 table
-- caps coverage_claim at NONE/SAMPLED, which stopped an unearned COMPLETE
-- becoming an absence proof while nothing could earn one. Widening that CHECK
-- would rebuild an applied table, so the earned-COMPLETE path lives here,
-- where every COMPLETE row carries the denominator that earned it. The Q3
-- result-store refusal ("coverage stronger than SAMPLED is never stored")
-- stands unchanged: its record shape carries no denominator channel, so a
-- COMPLETE presented there is still refused exactly as before.
--
-- A scan never mints source grants: every job INSERT revalidates the frozen
-- ScopeSnapshot, the caller grant, the purge frontier and member liveness, and
-- aborts with RETRIEVAL_AUTHORITY_STALE when deny, purge or expiry
-- invalidates the scope. Only SETTLED shard outcomes are journaled (the
-- shard CHECK requires disposition SETTLED): an unknown outcome keeps its
-- denominator seat and is never counted as a miss, so an unfinished job stays
-- PENDING and never persists a weaker claim that later reads as final.
--
-- Intent -> Attempt -> Receipt -> Readback -> Reconciliation: writers use
-- INSERT ... ON CONFLICT DO NOTHING (job start, shard journal) or a guarded
-- PENDING-to-COMPLETE transition (finalize) followed by an exact readback. A
-- lost ACK reconciles against the durable rows: byte-identical readback is a
-- replay, divergent bytes under a reused identity are a typed conflict, never
-- a second mutation. Shard outcome rows stay as immutable history; scope,
-- grant or purge invalidation clears the cached job receipt but never deletes
-- rows. No HTTP, model or R2 effect occurs inside these statements.
--
-- This additive, uncomposed capability does not promote the public Worker
-- readiness generation. Runtime generation changes belong to the later
-- composition/release gate.
PRAGMA foreign_keys = ON;

CREATE TABLE retrieval_exhaustive_job (
  job_id TEXT PRIMARY KEY CHECK(length(job_id) BETWEEN 1 AND 128),
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
  scope_digest TEXT NOT NULL CHECK (
    length(scope_digest) = 64 AND scope_digest NOT GLOB '*[^0-9a-f]*'
  ),
  plan_id TEXT NOT NULL CHECK(length(plan_id) BETWEEN 1 AND 256),
  coverage_denominator_ref TEXT NOT NULL CHECK(length(coverage_denominator_ref) BETWEEN 1 AND 256),
  denominator_shard_ids_json TEXT NOT NULL CHECK (
    json_valid(denominator_shard_ids_json)
    AND length(CAST(denominator_shard_ids_json AS BLOB)) <= 65536
    AND json_array_length(denominator_shard_ids_json) > 0
  ),
  state TEXT NOT NULL CHECK (state IN ('PENDING','COMPLETE','INVALIDATED')),
  denominator_shards INTEGER NOT NULL CHECK (denominator_shards > 0),
  settled_shards INTEGER,
  total_scanned_sections INTEGER,
  total_matches INTEGER,
  result_artifact_ref TEXT,
  coverage_receipt_ref TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(principal_ref, client_class, credential_generation, idempotency_key),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK (denominator_shards = json_array_length(denominator_shard_ids_json)),
  CHECK ((state = 'COMPLETE') = (result_artifact_ref IS NOT NULL)),
  CHECK ((result_artifact_ref IS NULL) = (coverage_receipt_ref IS NULL)),
  CHECK ((result_artifact_ref IS NULL) = (settled_shards IS NULL)),
  CHECK ((result_artifact_ref IS NULL) = (total_scanned_sections IS NULL)),
  CHECK ((result_artifact_ref IS NULL) = (total_matches IS NULL)),
  CHECK (settled_shards IS NULL OR settled_shards = denominator_shards),
  CHECK (state <> 'COMPLETE' OR (result_artifact_ref IS NOT NULL AND coverage_receipt_ref IS NOT NULL))
) STRICT;
CREATE INDEX retrieval_exhaustive_job_scope_idx
  ON retrieval_exhaustive_job(scope_snapshot_id, scope_snapshot_revision, state);

CREATE TABLE retrieval_exhaustive_shard (
  job_id TEXT NOT NULL,
  shard_id TEXT NOT NULL CHECK(length(shard_id) BETWEEN 1 AND 256),
  outcome_json TEXT NOT NULL CHECK (
    json_valid(outcome_json)
    AND length(CAST(outcome_json AS BLOB)) <= 262144
  ),
  outcome_digest TEXT NOT NULL CHECK (
    length(outcome_digest) = 64 AND outcome_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id, shard_id),
  FOREIGN KEY(job_id) REFERENCES retrieval_exhaustive_job(job_id),
  CHECK (json_extract(outcome_json, '$.shard_id') IS shard_id),
  CHECK (json_extract(outcome_json, '$.disposition') IS 'SETTLED')
) STRICT;

-- Authority gate: the frozen scope, the caller grant, the purge frontier and
-- every scope member must be live at the insert instant, and the recorded
-- scope digest must equal the live scope row. Expired or denied scopes
-- persist nothing and mint no grant.
CREATE TRIGGER retrieval_exhaustive_job_authority BEFORE INSERT ON retrieval_exhaustive_job
WHEN NOT EXISTS (
  SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id
    AND s.revision = NEW.scope_snapshot_revision
    AND s.invalidated_at IS NULL
    AND s.snapshot_digest IS NEW.scope_digest
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

-- A job row is append-only except for the single PENDING-to-COMPLETE
-- settlement and the conservative invalidation below: identity, scope, plan
-- and denominator bytes never change, and an INVALIDATED row carries no
-- receipt body.
CREATE TRIGGER retrieval_exhaustive_job_immutable BEFORE UPDATE ON retrieval_exhaustive_job
WHEN NEW.job_id IS NOT OLD.job_id
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.client_class IS NOT OLD.client_class
  OR NEW.credential_generation IS NOT OLD.credential_generation
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.scope_snapshot_id IS NOT OLD.scope_snapshot_id
  OR NEW.scope_snapshot_revision IS NOT OLD.scope_snapshot_revision
  OR NEW.scope_digest IS NOT OLD.scope_digest
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.coverage_denominator_ref IS NOT OLD.coverage_denominator_ref
  OR NEW.denominator_shard_ids_json IS NOT OLD.denominator_shard_ids_json
  OR NEW.denominator_shards IS NOT OLD.denominator_shards
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (OLD.state <> 'PENDING' AND NEW.state <> 'INVALIDATED')
  OR (NEW.state = 'INVALIDATED' AND (NEW.result_artifact_ref IS NOT NULL
    OR NEW.coverage_receipt_ref IS NOT NULL OR NEW.settled_shards IS NOT NULL
    OR NEW.total_scanned_sections IS NOT NULL OR NEW.total_matches IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

CREATE TRIGGER retrieval_exhaustive_shard_immutable BEFORE UPDATE ON retrieval_exhaustive_shard
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

CREATE TRIGGER retrieval_exhaustive_job_no_delete BEFORE DELETE ON retrieval_exhaustive_job
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;
CREATE TRIGGER retrieval_exhaustive_shard_no_delete BEFORE DELETE ON retrieval_exhaustive_shard
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

-- Conservative invalidation mirrors retrieval_query_result: a dead scope or a
-- revoked grant removes the cached receipt body. Replaying old bytes cannot
-- recreate a COMPLETE claim under an invalid scope. Journaled shard rows stay
-- as immutable history.
CREATE TRIGGER retrieval_exhaustive_scope_invalidated
AFTER UPDATE OF invalidated_at ON scope_snapshot WHEN NEW.invalidated_at IS NOT NULL
BEGIN
  UPDATE retrieval_exhaustive_job SET state = 'INVALIDATED', settled_shards = NULL,
    total_scanned_sections = NULL, total_matches = NULL,
    result_artifact_ref = NULL, coverage_receipt_ref = NULL
  WHERE scope_snapshot_id = NEW.snapshot_id
    AND scope_snapshot_revision = NEW.revision AND state <> 'INVALIDATED';
END;

CREATE TRIGGER retrieval_exhaustive_grant_revoked
AFTER UPDATE ON scope_access_grant
WHEN NEW.state <> 'ACTIVE' OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
  OR NEW.allowed_use_json IS NOT OLD.allowed_use_json
  OR NEW.disclosure_ceiling IS NOT OLD.disclosure_ceiling
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  UPDATE retrieval_exhaustive_job SET state = 'INVALIDATED', settled_shards = NULL,
    total_scanned_sections = NULL, total_matches = NULL,
    result_artifact_ref = NULL, coverage_receipt_ref = NULL
  WHERE scope_snapshot_id = OLD.snapshot_id
    AND scope_snapshot_revision = OLD.snapshot_revision
    AND principal_ref = OLD.principal_ref AND client_class = OLD.client_class
    AND credential_generation = OLD.credential_generation
    AND state <> 'INVALIDATED';
END;

CREATE TRIGGER retrieval_exhaustive_grant_deleted
AFTER DELETE ON scope_access_grant
BEGIN
  UPDATE retrieval_exhaustive_job SET state = 'INVALIDATED', settled_shards = NULL,
    total_scanned_sections = NULL, total_matches = NULL,
    result_artifact_ref = NULL, coverage_receipt_ref = NULL
  WHERE scope_snapshot_id = OLD.snapshot_id
    AND scope_snapshot_revision = OLD.snapshot_revision
    AND principal_ref = OLD.principal_ref AND client_class = OLD.client_class
    AND credential_generation = OLD.credential_generation
    AND state <> 'INVALIDATED';
END;

CREATE TRIGGER retrieval_exhaustive_source_not_live
AFTER UPDATE OF purge_state ON source_revision WHEN NEW.purge_state <> 'LIVE'
BEGIN
  UPDATE retrieval_exhaustive_job SET state = 'INVALIDATED', settled_shards = NULL,
    total_scanned_sections = NULL, total_matches = NULL,
    result_artifact_ref = NULL, coverage_receipt_ref = NULL
  WHERE state <> 'INVALIDATED' AND EXISTS (
    SELECT 1 FROM scope_snapshot s, json_each(s.member_source_revision_refs_json) member
    WHERE s.snapshot_id = retrieval_exhaustive_job.scope_snapshot_id
      AND s.revision = retrieval_exhaustive_job.scope_snapshot_revision
      AND member.value = NEW.source_revision_ref
  );
END;
