-- Cover the owner-scoped keyset query used by research.query/jobs.
-- The route still caps returned rows and Workflow status reads independently.
CREATE INDEX retrieval_exhaustive_workflow_owner_created_idx
  ON retrieval_exhaustive_workflow(
    principal_ref,
    client_class,
    credential_generation,
    deployment_generation,
    created_at DESC,
    workflow_id DESC
  );
