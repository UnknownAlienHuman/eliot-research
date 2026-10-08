-- S29 immutable semantic configuration revision (F1): replace the raw
-- ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0/_1 env blobs with one immutable,
-- content-addressed revision stored in D1.
--
-- RENUMBER NOTE: this migration was authored as 0096; it was renumbered to
-- 0097 because 0096 was taken by the S37 D1 stages 8/9 rebuild
-- (0096_research_model_spend_admission_branch_stages.sql). The SQL body is
-- byte-identical to the authored 0096 apart from this header note: it
-- creates a new table with no dependencies, so 0096 -> 0097 ordering is safe. The Worker environment keeps only
-- a short revision reference (ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF) and the
-- expected SHA-256 of the canonical config bytes
-- (ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256).
--
-- Identity: revision_ref is derived as "scr-" + the first 12 hex characters
-- of config_sha256. config_sha256 is the SHA-256 of the exact stored
-- config_json bytes. A revision row is immutable: updates and deletes are
-- rejected by triggers, so a deployed reference can never change meaning.
-- Conflicting bytes under one reference are rejected at write time by the
-- readback check in the revision store.
PRAGMA foreign_keys = ON;

CREATE TABLE research_semantic_config_revision (
  revision_ref TEXT NOT NULL PRIMARY KEY
    CHECK (
      revision_ref GLOB 'scr-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    ),
  config_sha256 TEXT NOT NULL UNIQUE
    CHECK (length(config_sha256) = 64 AND config_sha256 GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
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
