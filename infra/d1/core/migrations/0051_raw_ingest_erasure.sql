-- Raw-ingest erasure closure.
--
-- A guard is installed by the native erasure worker for one source revision
-- immediately before the raw-ingest rows are removed.  The guard is scoped to
-- the exact target and lease fence and is deleted in the same D1 batch after
-- the child rows have been removed.

CREATE TABLE raw_ingest_erasure_guard (
  source_revision_ref TEXT PRIMARY KEY
    CHECK (length(source_revision_ref) BETWEEN 1 AND 256),
  erasure_id TEXT NOT NULL
    CHECK (length(erasure_id) BETWEEN 1 AND 256),
  erasure_revision INTEGER NOT NULL
    CHECK (erasure_revision > 0),
  target_id TEXT NOT NULL
    CHECK (length(target_id) BETWEEN 1 AND 256),
  lease_owner TEXT NOT NULL
    CHECK (length(lease_owner) BETWEEN 1 AND 256),
  lease_generation INTEGER NOT NULL
    CHECK (lease_generation > 0),
  FOREIGN KEY (erasure_id, erasure_revision)
    REFERENCES erasure_execution(erasure_id, revision),
  FOREIGN KEY (erasure_id, erasure_revision, target_id)
    REFERENCES erasure_target(erasure_id, erasure_revision, target_id)
) STRICT;

CREATE INDEX raw_file_capture_source_revision_idx
  ON raw_file_capture(source_revision_ref);

CREATE INDEX raw_markdown_conversion_capture_idx
  ON raw_markdown_conversion(capture_id);

CREATE INDEX raw_normalized_admission_source_revision_idx
  ON raw_normalized_admission(source_revision_ref);

-- A guard can only be installed for the native raw-ingest operational target
-- while its source has entered the requested/redacted purge boundary.  The
-- target and execution rows are checked again here so a caller cannot turn a
-- row in this table into a general-purpose delete permission.
CREATE TRIGGER raw_ingest_erasure_guard_authorized
BEFORE INSERT ON raw_ingest_erasure_guard
WHEN NOT EXISTS (
  SELECT 1
  FROM erasure_execution AS e
  JOIN erasure_target AS t
    ON t.erasure_id = e.erasure_id
   AND t.erasure_revision = e.revision
   AND t.target_id = NEW.target_id
  JOIN source_revision AS sr
    ON sr.source_revision_ref = NEW.source_revision_ref
  WHERE e.erasure_id = NEW.erasure_id
    AND e.revision = NEW.erasure_revision
    AND e.state = 'PURGE_EACH_LOCATION'
    AND e.lease_owner = NEW.lease_owner
    AND e.lease_generation = NEW.lease_generation
    AND e.lease_until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND t.target_kind = 'OBJECT'
    AND t.location = 'OperationalRecovery'
    AND t.canonical_ref = 'd1-core:raw-ingest:' || NEW.source_revision_ref
    AND t.state IN ('ENUMERATED', 'QUARANTINED', 'PURGE_REQUESTED')
    AND t.shared_live_reference_count = 0
    AND t.retention_or_hold_ref IS NULL
    AND sr.purge_state IN ('PURGE_REQUESTED', 'REDACTED')
    AND (
      t.exact_subject_ref = 'source-revision:' || sr.source_revision_ref
      OR t.exact_subject_ref = 'source:' || sr.source_id
    )
    AND EXISTS (
      SELECT 1 FROM json_each(e.request_json, '$.exact_subject_refs')
      WHERE value = t.exact_subject_ref
    )
    AND EXISTS (
      SELECT 1 FROM json_each(e.request_json, '$.required_locations')
      WHERE value = 'OperationalRecovery'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM erasure_hold AS h
      WHERE h.state = 'ACTIVE'
        AND (
          h.exact_subject_ref IS NULL
          OR h.exact_subject_ref = t.exact_subject_ref
        )
        AND (h.location IS NULL OR h.location = t.location)
        AND (h.canonical_ref IS NULL OR h.canonical_ref = t.canonical_ref)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ERASURE_GUARD_UNAUTHORIZED');
END;

-- Guard identity is immutable.  This prevents rebinding a valid fence to a
-- different target after the INSERT trigger has authorized it.
CREATE TRIGGER raw_ingest_erasure_guard_immutable
BEFORE UPDATE ON raw_ingest_erasure_guard
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ERASURE_GUARD_IMMUTABLE');
END;

-- The native cleanup worker deletes the guard at the end of its one fenced
-- batch.  A stale worker, a different lease, a changed target, or a newly
-- active hold cannot use that DELETE to authorize child-row removal.
CREATE TRIGGER raw_ingest_erasure_guard_current_delete
BEFORE DELETE ON raw_ingest_erasure_guard
WHEN NOT EXISTS (
  SELECT 1
  FROM erasure_execution AS e
  JOIN erasure_target AS t
    ON t.erasure_id = e.erasure_id
   AND t.erasure_revision = e.revision
  WHERE e.erasure_id = OLD.erasure_id
    AND e.revision = OLD.erasure_revision
    AND e.state = 'PURGE_EACH_LOCATION'
    AND e.lease_owner = OLD.lease_owner
    AND e.lease_generation = OLD.lease_generation
    AND e.lease_until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND t.target_id = OLD.target_id
    AND t.target_kind = 'OBJECT'
    AND t.location = 'OperationalRecovery'
    AND t.canonical_ref = 'd1-core:raw-ingest:' || OLD.source_revision_ref
    AND t.state IN ('ENUMERATED', 'QUARANTINED', 'PURGE_REQUESTED')
    AND t.shared_live_reference_count = 0
    AND t.retention_or_hold_ref IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM erasure_hold AS h
      WHERE h.state = 'ACTIVE'
        AND (
          h.exact_subject_ref IS NULL
          OR h.exact_subject_ref = t.exact_subject_ref
        )
        AND (h.location IS NULL OR h.location = t.location)
        AND (h.canonical_ref IS NULL OR h.canonical_ref = t.canonical_ref)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ERASURE_GUARD_DELETE_UNAUTHORIZED');
END;

DROP TRIGGER IF EXISTS workspace_mcp_raw_admission_no_delete;

-- Workspace raw admission remains immutable except when the currently leased
-- native erasure execution has installed the exact source-revision guard.
CREATE TRIGGER workspace_mcp_raw_admission_no_delete
BEFORE DELETE ON workspace_mcp_raw_normalized_admission
WHEN NOT EXISTS (
  SELECT 1
  FROM raw_file_capture AS c
  JOIN raw_ingest_erasure_guard AS g
    ON g.source_revision_ref = c.source_revision_ref
  JOIN erasure_execution AS e
    ON e.erasure_id = g.erasure_id
   AND e.revision = g.erasure_revision
  JOIN erasure_target AS t
    ON t.erasure_id = e.erasure_id
   AND t.erasure_revision = e.revision
   AND t.target_id = g.target_id
  WHERE c.capture_id = OLD.capture_id
    AND e.state = 'PURGE_EACH_LOCATION'
    AND e.lease_owner = g.lease_owner
    AND e.lease_generation = g.lease_generation
    AND e.lease_until > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND t.target_kind = 'OBJECT'
    AND t.location = 'OperationalRecovery'
    AND t.canonical_ref = 'd1-core:raw-ingest:' || g.source_revision_ref
    AND t.state IN ('ENUMERATED', 'QUARANTINED', 'PURGE_REQUESTED')
    AND t.shared_live_reference_count = 0
    AND t.retention_or_hold_ref IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM erasure_hold AS h
      WHERE h.state = 'ACTIVE'
        AND (
          h.exact_subject_ref IS NULL
          OR h.exact_subject_ref = t.exact_subject_ref
        )
        AND (h.location IS NULL OR h.location = t.location)
        AND (h.canonical_ref IS NULL OR h.canonical_ref = t.canonical_ref)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_MCP_RAW_ADMISSION_BINDING_IMMUTABLE');
END;

-- Capture starts before a source_revision row is materialized.  A missing
-- source row is therefore allowed here; a known non-LIVE source is not.
CREATE TRIGGER raw_file_capture_source_live_on_insert
BEFORE INSERT ON raw_file_capture
WHEN EXISTS (
  SELECT 1
  FROM source_revision AS sr
  WHERE sr.source_revision_ref = NEW.source_revision_ref
    AND sr.purge_state <> 'LIVE'
)
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_SOURCE_NOT_LIVE');
END;

-- Conversion requires the captured parent.  Its source may still be absent
-- until admission promotion, but a known purged source cannot be resumed.
CREATE TRIGGER raw_markdown_conversion_capture_current_on_insert
BEFORE INSERT ON raw_markdown_conversion
WHEN NOT EXISTS (
  SELECT 1
  FROM raw_file_capture AS c
  WHERE c.capture_id = NEW.capture_id
    AND c.state = 'CAPTURED'
)
OR EXISTS (
  SELECT 1
  FROM raw_file_capture AS c
  JOIN source_revision AS sr
    ON sr.source_revision_ref = c.source_revision_ref
  WHERE c.capture_id = NEW.capture_id
    AND sr.purge_state <> 'LIVE'
)
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_CONVERSION_CAPTURE_NOT_CURRENT');
END;

-- Admission reservations must remain bound to the captured source revision.
-- As with capture/conversion, absence of the source_revision row is allowed
-- while the normal promotion path is still constructing it.
CREATE TRIGGER raw_normalized_admission_capture_current_on_insert
BEFORE INSERT ON raw_normalized_admission
WHEN NOT EXISTS (
  SELECT 1
  FROM raw_file_capture AS c
  WHERE c.capture_id = NEW.capture_id
    AND c.state = 'CAPTURED'
    AND c.source_revision_ref = NEW.source_revision_ref
)
OR EXISTS (
  SELECT 1
  FROM source_revision AS sr
  WHERE sr.source_revision_ref = NEW.source_revision_ref
    AND sr.purge_state <> 'LIVE'
)
BEGIN
  SELECT RAISE(ABORT, 'RAW_INGEST_ADMISSION_CAPTURE_NOT_CURRENT');
END;
