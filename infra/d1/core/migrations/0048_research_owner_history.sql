-- Bounded latest-run lookup for the authenticated owner and active deployment.
CREATE INDEX research_workflow_owner_history_idx
  ON research_workflow_run(
    principal_ref, credential_generation, deployment_generation,
    created_at DESC, operation_id DESC
  );
