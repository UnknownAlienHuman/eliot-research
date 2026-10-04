-- A1 owner/project model configuration revisions and selected-head CAS.
-- The revision payload contains the exact run-time JSON bundle, including
-- route candidate/proof identities and the seven existing Worker inputs.
PRAGMA foreign_keys = ON;

CREATE TABLE research_project_model_configuration_revision (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  configuration_ref TEXT NOT NULL CHECK (
    length(configuration_ref) = 69
    AND substr(configuration_ref, 1, 5) = 'rpmc-'
    AND substr(configuration_ref, 6) NOT GLOB '*[^0-9a-f]*'
    AND substr(configuration_ref, 6) = configuration_sha256
  ),
  configuration_sha256 TEXT NOT NULL CHECK (
    length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  configuration_json TEXT NOT NULL CHECK (
    json_valid(configuration_json)
    AND length(CAST(configuration_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length = length(CAST(configuration_json AS BLOB))),
  protocol TEXT NOT NULL CHECK (protocol = 'eliotr.research-project-model-configuration.v1'),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  created_by_principal_ref TEXT NOT NULL CHECK (length(created_by_principal_ref) BETWEEN 1 AND 256),
  PRIMARY KEY (owner_id, project_id, configuration_ref),
  UNIQUE (owner_id, project_id, configuration_ref, configuration_sha256),
  UNIQUE (owner_id, project_id, configuration_sha256)
) STRICT;

CREATE INDEX research_project_model_configuration_revision_history
  ON research_project_model_configuration_revision(owner_id, project_id, created_at DESC, configuration_ref);

CREATE TRIGGER research_project_model_configuration_revision_limit
BEFORE INSERT ON research_project_model_configuration_revision
WHEN (SELECT COUNT(*) FROM research_project_model_configuration_revision
      WHERE owner_id=NEW.owner_id AND project_id=NEW.project_id) >= 256
BEGIN
  SELECT RAISE(ABORT, 'research project model configuration revision limit reached');
END;

CREATE TRIGGER research_project_model_configuration_revision_no_update
BEFORE UPDATE ON research_project_model_configuration_revision
BEGIN
  SELECT RAISE(ABORT, 'research project model configuration revisions are immutable');
END;

CREATE TRIGGER research_project_model_configuration_revision_no_delete
BEFORE DELETE ON research_project_model_configuration_revision
BEGIN
  SELECT RAISE(ABORT, 'research project model configuration revisions are immutable');
END;

CREATE TABLE research_project_model_configuration_selection (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  selection_revision INTEGER NOT NULL CHECK (selection_revision BETWEEN 1 AND 1000000),
  configuration_ref TEXT NOT NULL,
  configuration_sha256 TEXT NOT NULL CHECK (
    length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  selected_at TEXT NOT NULL CHECK (length(selected_at) BETWEEN 1 AND 64),
  selected_by_principal_ref TEXT NOT NULL CHECK (length(selected_by_principal_ref) BETWEEN 1 AND 256),
  PRIMARY KEY (owner_id, project_id),
  FOREIGN KEY (owner_id, project_id, configuration_ref, configuration_sha256)
    REFERENCES research_project_model_configuration_revision(owner_id, project_id, configuration_ref, configuration_sha256)
) STRICT;

CREATE TRIGGER research_project_model_configuration_selection_insert_owner
BEFORE INSERT ON research_project_model_configuration_selection
WHEN NOT EXISTS (
  SELECT 1 FROM project_owner WHERE project_id=NEW.project_id AND principal_ref=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'current project owner authority is required');
END;

CREATE TRIGGER research_project_model_configuration_selection_update_owner
BEFORE UPDATE ON research_project_model_configuration_selection
WHEN NEW.selection_revision <> OLD.selection_revision + 1
  OR NOT EXISTS (
    SELECT 1 FROM project_owner WHERE project_id=NEW.project_id AND principal_ref=NEW.owner_id
  )
BEGIN
  SELECT RAISE(ABORT, 'current project owner authority and monotone selection revision are required');
END;
