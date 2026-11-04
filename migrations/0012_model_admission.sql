-- Admission is independent of a nullable declared-capacity bound.
ALTER TABLE chat_turn ADD COLUMN token_limit_kind TEXT
  CHECK (token_limit_kind IN ('published','unknown','legacy'));
ALTER TABLE source_revision ADD COLUMN distill_token_limit_kind TEXT
  CHECK (distill_token_limit_kind IN ('published','unknown','legacy'));

-- Terminal receipts are immutable under 0006. Their basis is inferred on read.
UPDATE chat_turn SET token_limit_kind='legacy'
  WHERE state='started' AND token_limit IS NOT NULL;

CREATE TRIGGER chat_turn_admission_immutable
BEFORE UPDATE ON chat_turn
WHEN OLD.state='started' AND (
  (NEW.token_limit_kind IS NOT OLD.token_limit_kind AND
    (OLD.token_limit_kind IS NOT NULL OR NEW.state!='started' OR OLD.token_limit IS NOT NULL))
  OR ((OLD.token_limit_kind IS NOT NULL OR OLD.token_limit IS NOT NULL)
    AND NEW.token_limit IS NOT OLD.token_limit
    AND NOT (NEW.state!='started' AND NEW.token_limit IS 0
      AND NEW.input_tokens IS 0 AND NEW.cached_tokens IS 0 AND NEW.output_tokens IS 0
      AND NEW.first_token_ms IS NULL)))
BEGIN
  SELECT RAISE(ABORT,'chat_turn_admission_is_immutable');
END;
