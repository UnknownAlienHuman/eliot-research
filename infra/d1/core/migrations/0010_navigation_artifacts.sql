-- Scope-bound derived navigation, never publication evidence. No existing authority row is rewritten.
CREATE TABLE navigation_artifact (
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('SOURCE_CARD','DOCUMENT_MAP','PROJECT_ATLAS')),
  subject_id TEXT NOT NULL,
  subject_revision INTEGER NOT NULL CHECK (subject_revision > 0),
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 0),
  body_digest TEXT NOT NULL CHECK (length(body_digest) = 64 AND body_digest NOT GLOB '*[^0-9a-f]*'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(CAST(body_json AS BLOB)) <= 1000000),
  source_bindings_json TEXT NOT NULL CHECK (json_valid(source_bindings_json) AND json_type(source_bindings_json) = 'array'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope_snapshot_id, scope_snapshot_revision, artifact_kind, subject_id, subject_revision),
  UNIQUE(scope_snapshot_id, scope_snapshot_revision, artifact_id, artifact_revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK (length(CAST(body_json AS BLOB)) + length(CAST(source_bindings_json AS BLOB)) <= 1800000),
  CHECK (json_array_length(source_bindings_json) <= 4096)
) STRICT;

CREATE TRIGGER navigation_artifact_immutable
BEFORE UPDATE ON navigation_artifact
BEGIN
  SELECT RAISE(ABORT, 'navigation artifacts are immutable');
END;

CREATE TRIGGER navigation_artifact_scope_guard
BEFORE INSERT ON navigation_artifact
BEGIN
  SELECT RAISE(ABORT, 'navigation scope is unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id
      AND s.revision = NEW.scope_snapshot_revision AND s.invalidated_at IS NULL
      AND julianday(s.expires_at) > julianday(NEW.created_at)
  );
  SELECT RAISE(ABORT, 'navigation scope member is unavailable') WHERE EXISTS (
    SELECT 1 FROM scope_snapshot scope, json_each(scope.member_source_revision_refs_json) member
    WHERE scope.snapshot_id = NEW.scope_snapshot_id AND scope.revision = NEW.scope_snapshot_revision
      AND NOT EXISTS (
        SELECT 1 FROM source_revision sr JOIN source s ON s.source_id=sr.source_id
        JOIN source_namespace_ownership o ON o.source_namespace_id=s.source_namespace_id AND o.status='ACTIVE'
        JOIN json_each(scope.source_owner_generations_json) gen ON gen.key=member.value
        WHERE sr.source_revision_ref=member.value AND sr.purge_state='LIVE'
          AND sr.source_owner_generation=o.source_owner_generation AND gen.value=sr.source_owner_generation
      )
  );
  SELECT RAISE(ABORT, 'navigation source binding is unavailable') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.source_bindings_json) b WHERE NOT EXISTS (
      SELECT 1 FROM source_revision sr JOIN source s ON s.source_id = sr.source_id
      JOIN source_namespace_ownership o ON o.source_namespace_id = s.source_namespace_id AND o.status = 'ACTIVE'
      JOIN scope_snapshot scope ON scope.snapshot_id = NEW.scope_snapshot_id AND scope.revision = NEW.scope_snapshot_revision
      WHERE sr.source_revision_ref = json_extract(b.value, '$.source_revision_ref') AND sr.purge_state = 'LIVE'
        AND sr.source_owner_generation = json_extract(b.value, '$.source_owner_generation')
        AND o.source_owner_generation = sr.source_owner_generation
        AND sr.content_sha256 = json_extract(b.value, '$.content_sha256')
        AND sr.object_residency_key_digest = json_extract(b.value, '$.object_residency_key_digest')
        AND EXISTS (SELECT 1 FROM json_each(scope.member_source_revision_refs_json) m WHERE m.value = sr.source_revision_ref)
    )
  );
END;

-- Conservative invalidation removes every navigation body in a dependent snapshot, including Atlas
-- summaries about omitted sources. Replaying old bytes cannot recreate data under an invalid scope.
CREATE TRIGGER navigation_scope_invalidated
AFTER UPDATE OF invalidated_at ON scope_snapshot WHEN NEW.invalidated_at IS NOT NULL
BEGIN
  DELETE FROM navigation_artifact WHERE scope_snapshot_id = NEW.snapshot_id AND scope_snapshot_revision = NEW.revision;
END;

CREATE TRIGGER navigation_scope_deleted
BEFORE DELETE ON scope_snapshot
BEGIN
  DELETE FROM navigation_artifact WHERE scope_snapshot_id = OLD.snapshot_id AND scope_snapshot_revision = OLD.revision;
END;

CREATE TRIGGER navigation_source_not_live
AFTER UPDATE OF purge_state ON source_revision WHEN NEW.purge_state <> 'LIVE'
BEGIN
  DELETE FROM navigation_artifact WHERE EXISTS (
    SELECT 1 FROM scope_snapshot s, json_each(s.member_source_revision_refs_json) m
    WHERE s.snapshot_id = navigation_artifact.scope_snapshot_id AND s.revision = navigation_artifact.scope_snapshot_revision
      AND m.value = NEW.source_revision_ref
  );
END;

CREATE TRIGGER navigation_source_deleted
BEFORE DELETE ON source_revision
BEGIN
  DELETE FROM navigation_artifact WHERE EXISTS (
    SELECT 1 FROM scope_snapshot s, json_each(s.member_source_revision_refs_json) m
    WHERE s.snapshot_id = navigation_artifact.scope_snapshot_id AND s.revision = navigation_artifact.scope_snapshot_revision
      AND m.value = OLD.source_revision_ref
  );
END;
