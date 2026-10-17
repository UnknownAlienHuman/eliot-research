-- A guide is a locator for an ordinary admitted Research run/report, never a second execution engine.
CREATE TABLE project_guide_binding (
  identity_digest TEXT PRIMARY KEY CHECK(length(identity_digest)=64),
  owner_principal_ref TEXT NOT NULL,
  project_id TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('en','ru')),
  prompt_revision TEXT NOT NULL,
  corpus_digest TEXT NOT NULL CHECK(length(corpus_digest)=64),
  corpus_json TEXT NOT NULL CHECK(json_valid(corpus_json)),
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_body TEXT NOT NULL CHECK(json_valid(request_body)),
  workflow_instance_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('HELD','UNKNOWN','RUNNING','READY','PARTIAL','FAILED','STALE','INVALID')),
  artifact_id TEXT,
  artifact_revision INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((artifact_id IS NULL AND artifact_revision IS NULL) OR
        (artifact_id IS NOT NULL AND artifact_revision>0)),
  FOREIGN KEY(project_id) REFERENCES project(project_id)
) STRICT;
CREATE INDEX project_guide_owner_project ON project_guide_binding(owner_principal_ref,project_id,state);
CREATE TRIGGER project_guide_identity_immutable BEFORE UPDATE ON project_guide_binding
WHEN NEW.identity_digest<>OLD.identity_digest OR NEW.owner_principal_ref<>OLD.owner_principal_ref
 OR NEW.project_id<>OLD.project_id OR NEW.language<>OLD.language OR NEW.prompt_revision<>OLD.prompt_revision
 OR NEW.corpus_digest<>OLD.corpus_digest OR NEW.corpus_json<>OLD.corpus_json
 OR NEW.selection_json<>OLD.selection_json OR NEW.idempotency_key<>OLD.idempotency_key
 OR NEW.request_body<>OLD.request_body OR NEW.workflow_instance_id<>OLD.workflow_instance_id
BEGIN SELECT RAISE(ABORT,'PROJECT_GUIDE_IDENTITY_CHANGED'); END;
