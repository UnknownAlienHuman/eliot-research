PRAGMA foreign_keys = ON;

-- Every draft binding emits one owner- and scope-visible immutable change.
-- The deterministic reference makes replay idempotent for the same artifact revision.
CREATE TRIGGER IF NOT EXISTS artifact_draft_binding_change_feed
AFTER INSERT ON artifact_draft_binding
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
  ) VALUES (
    'artifact-draft:' || NEW.artifact_id || ':' || NEW.revision,
    'ARTIFACT_DRAFTED',
    'artifact:' || NEW.artifact_id,
    NEW.revision,
    NEW.manifest_r2_key,
    NEW.manifest_sha256,
    NEW.principal_ref,
    NEW.scope_snapshot_id,
    NEW.scope_snapshot_revision,
    NEW.created_at,
    json_object(
      'artifact_id', NEW.artifact_id,
      'created_at', NEW.created_at,
      'manifest_r2_key', NEW.manifest_r2_key,
      'manifest_sha256', NEW.manifest_sha256,
      'principal_ref', NEW.principal_ref,
      'revision', NEW.revision,
      'scope_snapshot_id', NEW.scope_snapshot_id,
      'scope_snapshot_revision', NEW.scope_snapshot_revision
    )
  );
END;
