-- Align Native proof admission with the attempt's legal OBSERVED state.
-- At this point the candidate is inserted in the same D1 batch, but the
-- attempt is completed only after the proof insert succeeds. OBSERVED attempts
-- therefore identify the candidate through the exact preparation and
-- observation tuple, while candidate_ref/sha remain NULL until completion.
DROP TRIGGER provider_native_model_qualification_proof_guard;

CREATE TRIGGER provider_native_model_qualification_proof_guard BEFORE INSERT ON provider_native_model_qualification_proof
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_attempt a
      ON a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id')
      AND a.stage=c.stage AND a.preparation_ref=c.preparation_ref
      AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND c.owner_ref=NEW.owner_ref AND c.project_id=NEW.project_id AND c.stage=NEW.stage
      AND c.route_ref=NEW.route_ref AND c.route_version=NEW.route_version
      AND c.observation_ref=NEW.observation_ref AND c.observation_sha256=NEW.observation_sha256
      AND a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id') AND a.stage=c.stage
      AND a.preparation_ref=c.preparation_ref AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=NEW.observation_ref AND a.observation_sha256=NEW.observation_sha256
      AND a.state='OBSERVED' AND a.candidate_ref IS NULL AND a.candidate_sha256 IS NULL
      AND a.qualification_ref IS NULL AND a.qualification_sha256 IS NULL
      AND NEW.qualification_ref IS ('provider-native-model-qualification-' || NEW.qualification_sha256)
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_attempt a
      ON a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id')
      AND a.stage=c.stage AND a.preparation_ref=c.preparation_ref
      AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=c.owner_ref AND u.project_id=c.project_id AND u.operation_id=a.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=c.stage
    JOIN research_provider_key_configuration_operation k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id JOIN project_owner o ON o.project_id=p.project_id
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND a.state='OBSERVED' AND a.candidate_ref IS NULL AND a.candidate_sha256 IS NULL
      AND a.qualification_ref IS NULL AND a.qualification_sha256 IS NULL
      AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
      AND u.state='QUALIFYING' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
      AND s.state='QUALIFYING' AND s.candidate_ref IS NULL AND s.qualification_ref IS NULL
      AND s.preparation_ref=c.preparation_ref AND s.preparation_sha256=c.preparation_sha256
      AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
      AND julianday(NEW.expires_at)<=julianday(u.deadline_at)
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_observation obs
      ON obs.observation_ref=c.observation_ref AND obs.observation_sha256=c.observation_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.candidate_ref') IS NEW.candidate_ref
      AND json_extract(NEW.qualification_json,'$.candidate_sha256') IS NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.stage') IS NEW.stage
      AND json_extract(NEW.qualification_json,'$.route_ref') IS NEW.route_ref
      AND json_extract(NEW.qualification_json,'$.route_version') IS NEW.route_version
      AND json_extract(NEW.qualification_json,'$.qualification.observation_ref') IS NEW.observation_ref
      AND json_extract(NEW.qualification_json,'$.qualification.observation_sha256') IS NEW.observation_sha256
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_observation obs
      ON obs.observation_ref=c.observation_ref AND obs.observation_sha256=c.observation_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.request_body_sha256') IS json_extract(obs.observation_json,'$.execution.request_body_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.response_body_sha256') IS json_extract(obs.observation_json,'$.execution.response_body_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.response_body_byte_length') IS json_extract(obs.observation_json,'$.execution.response_body_byte_length')
      AND json_extract(NEW.qualification_json,'$.qualification.response_model') IS json_extract(obs.observation_json,'$.execution.response_model')
      AND json_extract(NEW.qualification_json,'$.qualification.gateway_log_id') IS json_extract(obs.observation_json,'$.execution.gateway_log_id')
      AND json_extract(NEW.qualification_json,'$.qualification.input_tokens') IS json_extract(obs.observation_json,'$.execution.input_tokens')
      AND json_extract(NEW.qualification_json,'$.qualification.output_tokens') IS json_extract(obs.observation_json,'$.execution.output_tokens')
      AND json_extract(NEW.qualification_json,'$.qualification.pricing_quote_ref') IS json_extract(obs.observation_json,'$.execution.pricing_quote_ref')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.probe_prompt_sha256') IS json_extract(c.candidate_json,'$.preparation.probe_prompt_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_schema_sha256') IS json_extract(c.candidate_json,'$.preparation.probe_schema_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_parameters_sha256') IS json_extract(c.candidate_json,'$.preparation.probe_parameters_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_prompt_sha256') IS json_extract(c.candidate_json,'$.preparation.prompt_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_schema_sha256') IS json_extract(c.candidate_json,'$.preparation.schema_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_parameters_sha256') IS json_extract(c.candidate_json,'$.preparation.parameters_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_deployment.route_ref') IS json_extract(c.candidate_json,'$.preparation.deployment.route_ref')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_deployment.route_version') IS json_extract(c.candidate_json,'$.preparation.deployment.route_version')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_deployment.route_ref') IS json_extract(c.candidate_json,'$.preparation.probe_deployment.route_ref')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_deployment.route_version') IS json_extract(c.candidate_json,'$.preparation.probe_deployment.route_version')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_deployment') IS json_extract(c.candidate_json,'$.preparation.deployment')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_deployment') IS json_extract(c.candidate_json,'$.preparation.probe_deployment')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.provider') IS 'openrouter'
      AND json_extract(NEW.qualification_json,'$.qualification.api') IS 'openrouter-chat-completions'
      AND json_extract(NEW.qualification_json,'$.qualification.exact_model_id') IS json_extract(c.candidate_json,'$.preparation.transport_policy.model')
      AND json_extract(NEW.qualification_json,'$.qualification.account_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.account_id')
      AND json_extract(NEW.qualification_json,'$.qualification.gateway_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.gateway_id')
      AND json_extract(NEW.qualification_json,'$.qualification.provider_config_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.provider_config_id')
      AND json_extract(NEW.qualification_json,'$.qualification.provider_key_operation_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.operation_id')
      AND json_extract(NEW.qualification_json,'$.qualification.provider_key_metadata_sha256') IS json_extract(c.candidate_json,'$.preparation.key_binding.configuration_metadata_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.alias') IS json_extract(c.candidate_json,'$.preparation.key_binding.alias')
      AND json_extract(NEW.qualification_json,'$.qualification.pricing_snapshot_ref') IS json_extract(c.candidate_json,'$.preparation.pricing_snapshot_ref')
      AND json_extract(NEW.qualification_json,'$.qualification.pricing_snapshot_sha256') IS json_extract(c.candidate_json,'$.preparation.pricing_snapshot_sha256')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.billed_usd') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.protocol') IS 'eliotr.provider-native-zero-price.v1'
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.allow_fallbacks') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.prompt') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.completion') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.request') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.image') IS 0
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.verified_at') IS NEW.verified_at
      AND json_extract(NEW.qualification_json,'$.qualification.expires_at') IS NEW.expires_at
      AND NEW.verified_at IS json_extract(c.candidate_json,'$.verified_at')
      AND NEW.expires_at IS json_extract(c.candidate_json,'$.qualification_expires_at')
      AND julianday(NEW.expires_at)>julianday(NEW.created_at)
  );
END;
