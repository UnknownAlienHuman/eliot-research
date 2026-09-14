PRAGMA foreign_keys = ON;

-- A verified commit guard is the durable boundary for an admitted source
-- revision.  The trigger runs inside the same D1 transaction as the guard,
-- so a replayed/ignored guard insert cannot create a second change event.
CREATE TRIGGER IF NOT EXISTS bundle_ingest_commit_guard_change_feed
AFTER INSERT ON bundle_ingest_commit_guard
WHEN NEW.verified = 1
BEGIN
  INSERT OR IGNORE INTO research_change_feed (
    change_ref,
    kind,
    subject_ref,
    subject_revision,
    payload_ref,
    payload_sha256,
    visibility_principal_ref,
    visibility_snapshot_id,
    visibility_snapshot_revision,
    occurred_at,
    metadata_json
  )
  SELECT
    'source-revision:' || NEW.source_revision_ref,
    CASE WHEN b.expected_head_revision_ref IS NULL THEN 'SOURCE_ADMITTED' ELSE 'SOURCE_UPDATED' END,
    'source:' || b.source_id,
    (
      SELECT COUNT(DISTINCT admitted.source_revision_ref)
      FROM bundle_ingest_commit_guard g
      JOIN source_revision admitted
        ON admitted.source_revision_ref = g.source_revision_ref
      WHERE g.verified = 1
        AND admitted.source_id = b.source_id
    ),
    r.source_revision_ref,
    r.content_sha256,
    b.principal_ref,
    NULL,
    NULL,
    NEW.created_at,
    json_object(
      'content_sha256', r.content_sha256,
      'operation_id', b.operation_id,
      'source_revision_ref', r.source_revision_ref
    )
  FROM bundle_ingest_operation b
  JOIN source_revision r
    ON r.source_revision_ref = NEW.source_revision_ref
   AND r.source_id = b.source_id
  WHERE b.operation_id = NEW.operation_id
    AND b.source_revision_ref = NEW.source_revision_ref
    AND b.state = 'COMMITTED';
END;
