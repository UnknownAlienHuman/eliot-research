PRAGMA foreign_keys = ON;

CREATE TABLE research_change_feed (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  change_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'WIKI_PUBLISHED',
    'SOURCE_ADMITTED',
    'SOURCE_UPDATED',
    'ARTIFACT_DRAFTED',
    'RESEARCH_COMPLETED',
    'ERASURE_COMPLETED'
  )),
  subject_ref TEXT NOT NULL,
  subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
  payload_ref TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  visibility_principal_ref TEXT,
  visibility_snapshot_id TEXT,
  visibility_snapshot_revision INTEGER CHECK (visibility_snapshot_revision > 0),
  occurred_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= 65536
  ),
  CHECK ((visibility_snapshot_id IS NULL) = (visibility_snapshot_revision IS NULL)),
  FOREIGN KEY (visibility_snapshot_id, visibility_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;

CREATE INDEX research_change_feed_visibility_idx
  ON research_change_feed(sequence, visibility_principal_ref);
CREATE INDEX research_change_feed_scope_idx
  ON research_change_feed(visibility_snapshot_id, visibility_snapshot_revision, sequence);
CREATE INDEX research_change_feed_kind_idx
  ON research_change_feed(kind, sequence);

CREATE TRIGGER research_change_feed_no_update
BEFORE UPDATE ON research_change_feed
BEGIN
  SELECT RAISE(ABORT, 'RESEARCH_CHANGE_IMMUTABLE');
END;

CREATE TRIGGER research_change_feed_no_delete
BEFORE DELETE ON research_change_feed
BEGIN
  SELECT RAISE(ABORT, 'RESEARCH_CHANGE_IMMUTABLE');
END;

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
  ) VALUES (
    'wiki:' || NEW.outbox_ref,
    'WIKI_PUBLISHED',
    'wiki-page:' || NEW.page_id,
    NEW.revision,
    NEW.manifest_ref,
    NEW.payload_sha256,
    NULL,
    NULL,
    NULL,
    NEW.created_at,
    json_object('outbox_ref', NEW.outbox_ref, 'state', NEW.state)
  );
END;
