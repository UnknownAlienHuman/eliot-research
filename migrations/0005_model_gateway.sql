-- Non-secret owner opt-in for one existing Google AI Studio default BYOK credential.
-- NULL keeps external models disconnected. No model default or budget changes.
ALTER TABLE settings ADD COLUMN model_gateway_id TEXT
  CHECK (model_gateway_id IS NULL OR (length(model_gateway_id) BETWEEN 1 AND 64 AND model_gateway_id != 'default'));
