-- Preserve historical currency records; new jobs record token bounds separately.
ALTER TABLE chat_turn ADD COLUMN token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0);
ALTER TABLE source_revision ADD COLUMN distill_token_limit INTEGER CHECK (distill_token_limit IS NULL OR distill_token_limit >= 0);
