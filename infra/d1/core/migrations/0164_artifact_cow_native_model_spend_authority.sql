-- COW snapshot model calls use the exact proof family captured by the original
-- Research run. Reuse the typed proof/revocation relation installed by 0163.
-- Do not change the REPORT witness, snapshot association, owner/scope/current
-- attempt, shape, shared budget, immutability or legacy active-route guards.
-- Captured Native owner/project come from cfg.configuration_json, not from a
-- caller-supplied witness extension or the current project selection.

DROP TRIGGER artifact_section_revise_spend_snapshot_tuple_guard;
CREATE TRIGGER artifact_section_revise_spend_snapshot_tuple_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration')='object'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_run_configuration cfg
    JOIN json_each(cfg.configuration_json,'$.model_selections') selected
    JOIN research_model_spend_pinned_authority pin
      ON pin.candidate_kind=CASE WHEN json_type(selected.value,'$.candidate_kind') IS NULL
        THEN 'dynamic-route' ELSE json_extract(selected.value,'$.candidate_kind') END
      AND pin.candidate_ref=json_extract(selected.value,'$.candidate_ref')
      AND pin.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
      AND pin.qualification_ref=json_extract(selected.value,'$.qualification_ref')
      AND pin.qualification_sha256=json_extract(selected.value,'$.qualification_sha256')
      AND pin.route_ref=json_extract(selected.value,'$.route_ref')
      AND pin.route_version=json_extract(selected.value,'$.route_version')
    WHERE cfg.configuration_ref=json_extract(NEW.request_json,'$.run_configuration.configuration_ref')
      AND cfg.configuration_sha256=json_extract(NEW.request_json,'$.run_configuration.configuration_sha256')
      AND cfg.mode=json_extract(NEW.request_json,'$.run_configuration.mode')
      AND json_extract(selected.value,'$.stage')=CASE NEW.call_slot
        WHEN 'SYNTHESIZE' THEN 'SYNTHESIZE' ELSE 'AUDIT_CLAIMS' END
      AND (SELECT count(*) FROM json_each(cfg.configuration_json,'$.model_selections') m
        WHERE json_extract(m.value,'$.stage')=CASE NEW.call_slot
          WHEN 'SYNTHESIZE' THEN 'SYNTHESIZE' ELSE 'AUDIT_CLAIMS' END)=1
      AND pin.route_ref=NEW.route_ref
      AND (json_extract(pin.deployment_json,'$.route_ref'),json_extract(pin.deployment_json,'$.route_version'),
        json_extract(pin.deployment_json,'$.prompt_generation'),json_extract(pin.deployment_json,'$.schema_generation'),
        json_extract(pin.deployment_json,'$.parameters_digest'),json_extract(pin.deployment_json,'$.pricing_snapshot_ref'))
        = (NEW.route_ref,json_extract(NEW.expected_deployment_json,'$.route_version'),
          json_extract(NEW.expected_deployment_json,'$.prompt_generation'),json_extract(NEW.expected_deployment_json,'$.schema_generation'),
          json_extract(NEW.expected_deployment_json,'$.parameters_digest'),json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref'))
      AND ((pin.candidate_kind='dynamic-route' AND json_type(selected.value,'$.candidate_kind') IS NULL)
        OR (pin.candidate_kind IN ('provider-native-v1','provider-native-v2') AND cfg.mode='snapshot-v2'
          AND json_type(cfg.configuration_json,'$.project_configuration.owner_ref')='text'
          AND json_type(cfg.configuration_json,'$.project_configuration.project_id')='text'
          AND pin.owner_ref=json_extract(cfg.configuration_json,'$.project_configuration.owner_ref')
          AND pin.project_id=json_extract(cfg.configuration_json,'$.project_configuration.project_id')
          AND pin.stage=json_extract(selected.value,'$.stage')
          AND pin.transport_policy_json=json_extract(selected.value,'$.transport_policy')))
  );
END;

DROP TRIGGER artifact_section_revise_spend_snapshot_currentness_guard;
CREATE TRIGGER artifact_section_revise_spend_snapshot_currentness_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration')='object'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_run_configuration cfg
    JOIN json_each(cfg.configuration_json,'$.model_selections') selected
    JOIN research_model_spend_pinned_authority pin
      ON pin.candidate_kind=CASE WHEN json_type(selected.value,'$.candidate_kind') IS NULL
        THEN 'dynamic-route' ELSE json_extract(selected.value,'$.candidate_kind') END
      AND pin.candidate_ref=json_extract(selected.value,'$.candidate_ref')
      AND pin.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
      AND pin.qualification_ref=json_extract(selected.value,'$.qualification_ref')
      AND pin.qualification_sha256=json_extract(selected.value,'$.qualification_sha256')
      AND pin.route_ref=json_extract(selected.value,'$.route_ref')
      AND pin.route_version=json_extract(selected.value,'$.route_version')
    WHERE cfg.configuration_ref=json_extract(NEW.request_json,'$.run_configuration.configuration_ref')
      AND cfg.configuration_sha256=json_extract(NEW.request_json,'$.run_configuration.configuration_sha256')
      AND cfg.mode=json_extract(NEW.request_json,'$.run_configuration.mode')
      AND json_extract(selected.value,'$.stage')=CASE NEW.call_slot
        WHEN 'SYNTHESIZE' THEN 'SYNTHESIZE' ELSE 'AUDIT_CLAIMS' END
      AND pin.route_ref=NEW.route_ref
      AND pin.route_version=json_extract(NEW.expected_deployment_json,'$.route_version')
      -- The 0163 view admits only LIVE, non-revoked exact proofs. Snapshot-v2
      -- retains expired qualification evidence; v1 still requires current expiry.
      AND julianday(pin.qualification_expires_at) IS NOT NULL
      AND (cfg.mode='snapshot-v2' OR (cfg.mode='snapshot-v1'
        AND julianday(pin.qualification_expires_at)>julianday('now')))
  );
END;
