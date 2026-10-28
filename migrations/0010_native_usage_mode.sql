-- Native requests are paused unless the owner explicitly chooses standard billing.
-- This does not invent an enforceable Neuron cap or change existing models/usage.
ALTER TABLE settings ADD COLUMN native_usage_mode TEXT NOT NULL DEFAULT 'included'
  CHECK (native_usage_mode IN ('included', 'standard'));
