-- D1 caps LIKE/GLOB patterns at 50 bytes. The positive per-character patterns
-- in 0097 exceed that bound, so no semantic revision can be inserted there.
-- This repair is deliberately empty-table-only: any row causes the guard CHECK
-- to abort before the authoritative table is changed.
CREATE TABLE __eliotr_migration_0108_research_semantic_config_revision_empty_guard (
  empty_confirmed INTEGER NOT NULL CHECK (empty_confirmed = 1)
) STRICT;

INSERT INTO __eliotr_migration_0108_research_semantic_config_revision_empty_guard (empty_confirmed)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM research_semantic_config_revision LIMIT 1
) THEN 1 ELSE 0 END;

DROP TABLE __eliotr_migration_0108_research_semantic_config_revision_empty_guard;

CREATE TABLE research_semantic_config_revision_0108 (
  revision_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      length(revision_ref) = 16
      AND substr(revision_ref, 1, 4) = 'scr-'
      AND substr(revision_ref, 5) NOT GLOB '*[^0-9a-f]*'
    ),
  config_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(config_sha256) = 64 AND config_sha256 NOT GLOB '*[^0-9a-f]*'),
  config_json TEXT NOT NULL
    CHECK (
      json_valid(config_json)
      AND length(CAST(config_json AS BLOB)) BETWEEN 2 AND 65536
    ),
  byte_length INTEGER NOT NULL
    CHECK (byte_length = length(CAST(config_json AS BLOB))),
  protocol TEXT NOT NULL
    CHECK (protocol = 'eliotr.research-semantic-config.v1'),
  created_at TEXT NOT NULL
    CHECK (length(created_at) BETWEEN 1 AND 64),
  created_by_principal_ref TEXT NOT NULL
    CHECK (length(created_by_principal_ref) BETWEEN 1 AND 256)
) STRICT;

DROP TABLE research_semantic_config_revision;
ALTER TABLE research_semantic_config_revision_0108 RENAME TO research_semantic_config_revision;

CREATE TRIGGER research_semantic_config_revision_no_update
BEFORE UPDATE ON research_semantic_config_revision
BEGIN
  SELECT RAISE(ABORT, 'research semantic config revisions are immutable');
END;

CREATE TRIGGER research_semantic_config_revision_no_delete
BEFORE DELETE ON research_semantic_config_revision
BEGIN
  SELECT RAISE(ABORT, 'research semantic config revisions are immutable');
END;
