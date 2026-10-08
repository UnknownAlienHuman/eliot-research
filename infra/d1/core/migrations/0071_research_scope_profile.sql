-- S99: retain immutable legacy profile rows, permit the existing larger owner loader
-- only for the explicitly versioned Research profile. No scope/grant/receipt is rewritten.
CREATE TABLE retrieval_scope_profile_s99 (
  snapshot_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  profile_version TEXT NOT NULL CHECK (length(profile_version) BETWEEN 1 AND 128),
  max_sources INTEGER NOT NULL CHECK (max_sources > 0 AND
    ((profile_version = 'retrieval-scope-v2' AND max_sources <= 4096) OR
     (profile_version <> 'retrieval-scope-v2' AND max_sources <= 64))),
  max_results INTEGER NOT NULL CHECK (max_results > 0 AND max_results <= 16),
  created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, revision),
  FOREIGN KEY(snapshot_id, revision) REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;
INSERT INTO retrieval_scope_profile_s99
  SELECT snapshot_id, revision, profile_version, max_sources, max_results, created_at
  FROM retrieval_scope_profile;
-- Stop before replacement if any copied identity/value differs.
CREATE TABLE s99_profile_copy_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO s99_profile_copy_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM retrieval_scope_profile_s99) = (SELECT COUNT(*) FROM retrieval_scope_profile)
  AND NOT EXISTS (SELECT * FROM retrieval_scope_profile EXCEPT SELECT * FROM retrieval_scope_profile_s99)
  AND NOT EXISTS (SELECT * FROM retrieval_scope_profile_s99 EXCEPT SELECT * FROM retrieval_scope_profile)
  THEN 1 ELSE 0 END;
DROP TABLE s99_profile_copy_guard;
DROP TRIGGER retrieval_scope_profile_immutable;
DROP TRIGGER retrieval_scope_profile_no_delete;
DROP TABLE retrieval_scope_profile;
ALTER TABLE retrieval_scope_profile_s99 RENAME TO retrieval_scope_profile;
CREATE TRIGGER retrieval_scope_profile_immutable BEFORE UPDATE ON retrieval_scope_profile
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_PROFILE_CONFLICT'); END;
CREATE TRIGGER retrieval_scope_profile_no_delete BEFORE DELETE ON retrieval_scope_profile
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_PROFILE_CONFLICT'); END;
INSERT INTO schema_state(key,value,updated_at)
VALUES('research_scope_profile_generation','retrieval-scope-v2',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
