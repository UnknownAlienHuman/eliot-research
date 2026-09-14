PRAGMA foreign_keys = ON;

-- Replace the legacy all-public change-feed hook.  The outbox row is inserted
-- before the publication transaction flips the proposal state, so the
-- proposal join intentionally does not require state = 'PUBLISHED'.
DROP TRIGGER IF EXISTS wiki_publication_outbox_change_feed;

CREATE TRIGGER wiki_publication_outbox_change_feed
AFTER INSERT ON wiki_publication_outbox
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
    'wiki:' || NEW.outbox_ref,
    'WIKI_PUBLISHED',
    'wiki-page:' || NEW.page_id,
    NEW.revision,
    NEW.manifest_ref,
    NEW.payload_sha256,
    p.principal_ref,
    json_extract(r.page_json, '$.scope_snapshot_ref.id'),
    json_extract(r.page_json, '$.scope_snapshot_ref.revision'),
    NEW.created_at,
    json_object('outbox_ref', NEW.outbox_ref, 'state', NEW.state)
  FROM wiki_publication_revision r
  JOIN wiki_publication_proposal p
    ON p.proposal_id = r.proposal_id
   AND p.proposal_revision = r.proposal_revision
  WHERE r.page_id = NEW.page_id
    AND r.revision = NEW.revision
    AND r.manifest_ref = NEW.manifest_ref
    AND r.page_sha256 = NEW.payload_sha256;
END;
