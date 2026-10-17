-- Research spend admission must resolve the captured model's authority family.
-- Live prerequisite: research_model_spend_admission_deployment_guard SHA-256
-- 1a0624d150fe10dc19bcdffbaba21c62adabf917f686a7043985e82448290e31
-- (C1-FD-NATIVE-SPEND-READONLY.json). No canonical rows or table constraints change.
-- W2/current grant, policy, deployment, scope, role and shape guards remain intact.
-- COW admissions have independent witnesses/guards and are intentionally unchanged.

-- A typed, exact proof relation keeps each authority family independent and the
-- INSERT expression below D1's depth limit. A Native pin cannot use a DynamicRoute
-- row with colliding references. Expiry policy belongs to the captured mode below.
CREATE VIEW research_model_spend_pinned_authority AS
SELECT 'dynamic-route' AS candidate_kind, NULL AS owner_ref, NULL AS project_id, NULL AS stage,
  c.route_ref, c.route_version, c.candidate_ref, c.candidate_sha256,
  q.qualification_ref, q.proof_sha256 AS qualification_sha256,
  json_extract(c.candidate_json,'$.deployment') AS deployment_json,
  NULL AS transport_policy_json,
  json_extract(q.qualification_json,'$.qualification.expires_at') AS qualification_expires_at
FROM dynamic_route_candidate c
JOIN dynamic_route_qualification_proof q ON q.candidate_ref=c.candidate_ref
  AND q.candidate_sha256=c.candidate_sha256 AND q.route_ref=c.route_ref AND q.route_version=c.route_version
WHERE json_extract(c.candidate_json,'$.qualification_tier') IS 'LIVE'
  AND json_extract(q.qualification_json,'$.qualification.tier') IS 'LIVE'
  AND NOT EXISTS (SELECT 1 FROM dynamic_route_qualification_revocation v
    WHERE v.qualification_ref=q.qualification_ref AND v.qualification_sha256=q.proof_sha256)
UNION ALL
SELECT 'provider-native-v1', c.owner_ref, c.project_id, c.stage,
  c.route_ref, c.route_version, c.candidate_ref, c.candidate_sha256,
  q.qualification_ref, q.qualification_sha256,
  json_extract(c.candidate_json,'$.preparation.deployment'),
  json_extract(c.candidate_json,'$.preparation.transport_policy'), q.expires_at
FROM provider_native_model_candidate c
JOIN provider_native_model_qualification_proof q ON q.candidate_ref=c.candidate_ref
  AND q.candidate_sha256=c.candidate_sha256 AND q.owner_ref=c.owner_ref AND q.project_id=c.project_id
  AND q.stage=c.stage AND q.route_ref=c.route_ref AND q.route_version=c.route_version
  AND q.observation_ref=c.observation_ref AND q.observation_sha256=c.observation_sha256
WHERE c.qualification_tier='LIVE' AND q.qualification_tier='LIVE'
  AND json_extract(c.candidate_json,'$.candidate_kind') IS 'provider-native-v1'
  AND json_extract(q.qualification_json,'$.candidate_kind') IS 'provider-native-v1'
  AND json_extract(c.candidate_json,'$.preparation.owner_ref') IS c.owner_ref
  AND json_extract(c.candidate_json,'$.preparation.project_id') IS c.project_id
  AND json_extract(c.candidate_json,'$.preparation.stage') IS c.stage
  AND NOT EXISTS (SELECT 1 FROM provider_native_model_qualification_revocation v
    WHERE v.owner_ref=c.owner_ref AND v.project_id=c.project_id
      AND v.qualification_ref=q.qualification_ref AND v.qualification_sha256=q.qualification_sha256)
UNION ALL
SELECT 'provider-native-v2', e.owner_ref, e.project_id, e.stage,
  json_extract(e.preparation_json,'$.deployment.route_ref'),
  json_extract(e.preparation_json,'$.deployment.route_version'), e.candidate_ref, e.candidate_sha256,
  e.qualification_ref, e.qualification_sha256,
  json_extract(e.preparation_json,'$.deployment'),
  json_extract(e.preparation_json,'$.transport_policy'),
  json_extract(e.qualification_json,'$.expires_at')
FROM provider_native_model_catalog_v2_evidence e
WHERE e.state='COMPLETED'
  AND json_extract(e.candidate_json,'$.candidate_kind') IS 'provider-native-v2'
  AND json_extract(e.candidate_json,'$.qualification_tier') IS 'LIVE'
  AND json_extract(e.qualification_json,'$.candidate_kind') IS 'provider-native-v2'
  AND json_extract(e.qualification_json,'$.qualification_tier') IS 'LIVE'
  AND json_extract(e.qualification_json,'$.candidate_ref') IS e.candidate_ref
  AND json_extract(e.qualification_json,'$.candidate_sha256') IS e.candidate_sha256
  AND json_extract(e.qualification_json,'$.owner_ref') IS e.owner_ref
  AND json_extract(e.qualification_json,'$.project_id') IS e.project_id
  AND json_extract(e.qualification_json,'$.stage') IS e.stage
  AND json_extract(e.preparation_json,'$.owner_ref') IS e.owner_ref
  AND json_extract(e.preparation_json,'$.project_id') IS e.project_id
  AND json_extract(e.preparation_json,'$.stage') IS e.stage
  AND json_extract(e.preparation_json,'$.provider_slug') IS e.provider_slug
  AND json_extract(e.preparation_json,'$.model_id') IS e.model_id
  AND json_extract(e.preparation_json,'$.transport_policy.provider') IS e.provider_slug
  AND json_extract(e.preparation_json,'$.transport_policy.model') IS e.model_id
  AND json_extract(e.preparation_json,'$.transport_policy.billing.alias') IS e.alias
  AND NOT EXISTS (SELECT 1 FROM provider_native_model_catalog_v2_revocation v
    WHERE v.owner_ref=e.owner_ref AND v.project_id=e.project_id
      AND v.qualification_ref=e.qualification_ref AND v.qualification_sha256=e.qualification_sha256);

DROP TRIGGER research_model_spend_admission_deployment_guard;
CREATE TRIGGER research_model_spend_admission_deployment_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT,'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_workflow_run run
    LEFT JOIN research_run_configuration cfg ON cfg.operation_id=run.operation_id
      AND cfg.configuration_ref=run.configuration_ref
    WHERE run.operation_id=NEW.workflow_operation_id
      AND (
        -- Pre-0104 legacy authority, unchanged from 0105.
        (run.configuration_required=0 AND EXISTS (
          SELECT 1 FROM dynamic_route_active_generation active
          JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=active.candidate_ref
            AND candidate.candidate_sha256=active.candidate_sha256
          LEFT JOIN dynamic_route_active_qualification latest ON latest.route_ref=active.route_ref
            AND latest.route_version=active.route_version
          LEFT JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=latest.qualification_ref
            AND proof.proof_sha256=latest.qualification_sha256 AND proof.route_ref=latest.route_ref
            AND proof.route_version=latest.route_version AND proof.candidate_ref=latest.candidate_ref
            AND proof.candidate_sha256=latest.candidate_sha256
          WHERE active.route_ref=NEW.route_ref
            AND active.route_version=json_extract(NEW.expected_deployment_json,'$.route_version')
            AND json_extract(candidate.candidate_json,'$.deployment.route_ref') IS NEW.route_ref
            AND json_extract(candidate.candidate_json,'$.deployment.route_version') IS json_extract(NEW.expected_deployment_json,'$.route_version')
            AND json_extract(candidate.candidate_json,'$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json,'$.prompt_generation')
            AND json_extract(candidate.candidate_json,'$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json,'$.schema_generation')
            AND json_extract(candidate.candidate_json,'$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json,'$.parameters_digest')
            AND json_extract(candidate.candidate_json,'$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
            AND ((latest.route_ref IS NULL AND json_extract(candidate.candidate_json,'$.qualification_expires_at') IS NOT NULL
                  AND julianday(json_extract(candidate.candidate_json,'$.qualification_expires_at'))>julianday('now'))
              OR (latest.route_ref IS NOT NULL AND latest.candidate_ref IS active.candidate_ref
                  AND latest.candidate_sha256 IS active.candidate_sha256 AND proof.qualification_ref IS NOT NULL
                  AND json_extract(proof.qualification_json,'$.qualification.tier') IS 'LIVE'
                  AND json_extract(proof.qualification_json,'$.qualification.expires_at') IS NOT NULL
                  AND julianday(json_extract(proof.qualification_json,'$.qualification.expires_at'))>julianday('now')))
        ))
        OR (run.configuration_required=1 AND run.configuration_ref IS NOT NULL AND cfg.operation_id IS NOT NULL
          AND cfg.investigation_id=run.investigation_id AND cfg.principal_ref=run.principal_ref
          AND cfg.deployment_generation=run.deployment_generation
          AND (SELECT count(*) FROM json_each(cfg.configuration_json,'$.model_selections') m
            WHERE json_extract(m.value,'$.stage')=json_extract(NEW.stage_request_json,'$.stage'))=1
          AND EXISTS (
            SELECT 1 FROM json_each(cfg.configuration_json,'$.model_selections') selected
            JOIN research_model_spend_pinned_authority pin
              ON pin.candidate_kind=CASE WHEN json_type(selected.value,'$.candidate_kind') IS NULL
                THEN 'dynamic-route' ELSE json_extract(selected.value,'$.candidate_kind') END
              AND pin.candidate_ref=json_extract(selected.value,'$.candidate_ref')
              AND pin.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
              AND pin.qualification_ref=json_extract(selected.value,'$.qualification_ref')
              AND pin.qualification_sha256=json_extract(selected.value,'$.qualification_sha256')
              AND pin.route_ref=json_extract(selected.value,'$.route_ref')
              AND pin.route_version=json_extract(selected.value,'$.route_version')
            WHERE json_extract(selected.value,'$.stage')=json_extract(NEW.stage_request_json,'$.stage')
              AND pin.route_ref=NEW.route_ref
              AND (json_extract(pin.deployment_json,'$.route_ref'),json_extract(pin.deployment_json,'$.route_version'),
                json_extract(pin.deployment_json,'$.prompt_generation'),json_extract(pin.deployment_json,'$.schema_generation'),
                json_extract(pin.deployment_json,'$.parameters_digest'),json_extract(pin.deployment_json,'$.pricing_snapshot_ref'))
                = (NEW.route_ref,json_extract(NEW.expected_deployment_json,'$.route_version'),
                  json_extract(NEW.expected_deployment_json,'$.prompt_generation'),json_extract(NEW.expected_deployment_json,'$.schema_generation'),
                  json_extract(NEW.expected_deployment_json,'$.parameters_digest'),json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref'))
              AND (pin.candidate_kind='dynamic-route' OR (cfg.mode='snapshot-v2'
                AND pin.owner_ref=json_extract(cfg.configuration_json,'$.project_configuration.owner_ref')
                AND pin.project_id=json_extract(cfg.configuration_json,'$.project_configuration.project_id')
                AND pin.stage=json_extract(selected.value,'$.stage')
                AND pin.transport_policy_json=json_extract(selected.value,'$.transport_policy')))
              AND julianday(pin.qualification_expires_at) IS NOT NULL
              AND (cfg.mode='snapshot-v2' OR (cfg.mode='snapshot-v1'
                AND julianday(pin.qualification_expires_at)>julianday('now')))
          ))
      )
  );
END;
