-- Q8 durable binding between the public research.query request and the
-- canonical ER09 Workflow instance. The Q7 job remains the coverage source;
-- this table records owner identity and request identity for lifecycle reads.
PRAGMA foreign_keys = ON;

CREATE TABLE retrieval_exhaustive_workflow (
  workflow_id TEXT PRIMARY KEY CHECK(length(workflow_id) = 84),
  job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 128),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  client_class TEXT NOT NULL CHECK(client_class = 'owner_pwa'),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  request_identity_digest TEXT NOT NULL CHECK(
    length(request_identity_digest) = 64 AND request_identity_digest NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK(state IN ('BOUND','CANCEL_REQUESTED')),
  created_at TEXT NOT NULL,
  UNIQUE(principal_ref, client_class, credential_generation, job_id)
) STRICT;

CREATE INDEX retrieval_exhaustive_workflow_job_idx
  ON retrieval_exhaustive_workflow(job_id, principal_ref, credential_generation);

CREATE TRIGGER retrieval_exhaustive_workflow_immutable BEFORE UPDATE ON retrieval_exhaustive_workflow
WHEN NEW.workflow_id IS NOT OLD.workflow_id
  OR NEW.job_id IS NOT OLD.job_id
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.client_class IS NOT OLD.client_class
  OR NEW.credential_generation IS NOT OLD.credential_generation
  OR NEW.deployment_generation IS NOT OLD.deployment_generation
  OR NEW.request_identity_digest IS NOT OLD.request_identity_digest
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'CANCEL_REQUESTED' AND NEW.state <> OLD.state)
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;

CREATE TRIGGER retrieval_exhaustive_workflow_no_delete BEFORE DELETE ON retrieval_exhaustive_workflow
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_CONFLICT'); END;
