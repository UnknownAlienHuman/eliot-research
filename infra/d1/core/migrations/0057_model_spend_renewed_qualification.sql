PRAGMA foreign_keys = ON;

-- Qualification renewal keeps the immutable route candidate unchanged and
-- selects its current proof through the exact active-qualification pointer.
-- When no pointer exists, retain the pre-0057 candidate-expiry behavior.
DROP TRIGGER research_model_spend_admission_deployment_guard;

CREATE TRIGGER research_model_spend_admission_deployment_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_active_generation active
    JOIN dynamic_route_candidate candidate
      ON candidate.candidate_ref = active.candidate_ref
      AND candidate.candidate_sha256 = active.candidate_sha256
    LEFT JOIN dynamic_route_active_qualification latest
      ON latest.route_ref = active.route_ref
      AND latest.route_version = active.route_version
    LEFT JOIN dynamic_route_qualification_proof proof
      ON proof.qualification_ref = latest.qualification_ref
      AND proof.proof_sha256 = latest.qualification_sha256
      AND proof.route_ref = latest.route_ref
      AND proof.route_version = latest.route_version
      AND proof.candidate_ref = latest.candidate_ref
      AND proof.candidate_sha256 = latest.candidate_sha256
    WHERE active.route_ref = NEW.route_ref
      AND active.route_version = json_extract(NEW.expected_deployment_json, '$.route_version')
      AND json_extract(candidate.candidate_json, '$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(candidate.candidate_json, '$.deployment.route_version') IS json_extract(NEW.expected_deployment_json, '$.route_version')
      AND json_extract(candidate.candidate_json, '$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json, '$.prompt_generation')
      AND json_extract(candidate.candidate_json, '$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json, '$.schema_generation')
      AND json_extract(candidate.candidate_json, '$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json, '$.parameters_digest')
      AND json_extract(candidate.candidate_json, '$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json, '$.pricing_snapshot_ref')
      AND (
        (
          latest.route_ref IS NULL
          AND json_extract(candidate.candidate_json, '$.qualification_expires_at') IS NOT NULL
          AND julianday(json_extract(candidate.candidate_json, '$.qualification_expires_at')) > julianday('now')
        )
        OR
        (
          latest.route_ref IS NOT NULL
          AND latest.candidate_ref IS active.candidate_ref
          AND latest.candidate_sha256 IS active.candidate_sha256
          AND proof.qualification_ref IS NOT NULL
          AND json_extract(proof.qualification_json, '$.qualification.tier') IS 'LIVE'
          AND json_extract(proof.qualification_json, '$.qualification.expires_at') IS NOT NULL
          AND julianday(json_extract(proof.qualification_json, '$.qualification.expires_at')) > julianday('now')
        )
      )
  );
END;
