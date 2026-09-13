-- Durable raw-ingest row locators for an OperationalRecovery erasure.
--
-- The guard is intentionally ephemeral.  These member rows preserve the
-- exact physical identifiers observed by the guarded delete so a later
-- absence readback can still find an orphaned child after its parent row has
-- gone away.  They contain no payload, content, or authority data.
CREATE TABLE raw_ingest_erasure_member (
  source_revision_ref TEXT NOT NULL
    CHECK (length(source_revision_ref) BETWEEN 1 AND 256),
  member_kind TEXT NOT NULL CHECK (member_kind IN (
    'CAPTURE','CONVERSION','ADMISSION','WORKSPACE_BINDING'
  )),
  member_id TEXT NOT NULL CHECK (length(member_id) BETWEEN 1 AND 256),
  PRIMARY KEY (source_revision_ref, member_kind, member_id)
) STRICT;

CREATE INDEX raw_ingest_erasure_member_id_idx
  ON raw_ingest_erasure_member(member_kind, member_id);

-- Member rows may only be created while the native worker holds the exact
-- current guard.  The adapter also repeats the chain predicates in every
-- INSERT ... SELECT; this trigger prevents an alternate SQL caller from
-- turning the table into a general locator registry.
CREATE TRIGGER raw_ingest_erasure_member_authorized
BEFORE INSERT ON raw_ingest_erasure_member
WHEN NOT EXISTS (
  SELECT 1
  FROM raw_ingest_erasure_guard AS g
  JOIN erasure_execution AS e
    ON e.erasure_id = g.erasure_id
   AND e.revision = g.erasure_revision
  JOIN erasure_target AS t
    ON t.erasure_id = g.erasure_id
   AND t.erasure_revision = g.erasure_revision
   AND t.target_id = g.target_id
  JOIN source_revision AS sr
    ON sr.source_revision_ref = g.source_revision_ref
  WHERE g.source_revision_ref = NEW.source_revision_ref
    AND e.state = 'PURGE_EACH_LOCATION'
    AND e.lease_owner = g.lease_owner
    AND e.lease_generation = g.lease_generation
    AND e.lease_until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND t.target_kind = 'OBJECT'
    AND t.location = 'OperationalRecovery'
    AND t.canonical_ref = 'd1-core:raw-ingest:' || g.source_revision_ref
    AND t.state IN ('ENUMERATED','QUARANTINED','PURGE_REQUESTED')
    AND t.shared_live_reference_count = 0
    AND t.retention_or_hold_ref IS NULL
    AND sr.purge_state IN ('PURGE_REQUESTED','REDACTED')
)
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ERASURE_MEMBER_UNAUTHORIZED');
END;

CREATE TRIGGER raw_ingest_erasure_member_immutable_update
BEFORE UPDATE ON raw_ingest_erasure_member
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ERASURE_MEMBER_IMMUTABLE');
END;

CREATE TRIGGER raw_ingest_erasure_member_immutable_delete
BEFORE DELETE ON raw_ingest_erasure_member
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ERASURE_MEMBER_IMMUTABLE');
END;
