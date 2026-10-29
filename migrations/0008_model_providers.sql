-- Provider configuration contains no credentials. Catalogues refresh explicitly.
ALTER TABLE settings ADD COLUMN model_providers_json TEXT NOT NULL DEFAULT
'[{"id":"workers-ai","type":"workers-ai","gatewaySlug":null,"gatewayPath":"","baseUrl":null,"enabled":true},{"id":"openrouter","type":"openai-compatible","gatewaySlug":"openrouter","gatewayPath":"v1","baseUrl":"https://openrouter.ai/api/v1","enabled":true},{"id":"command-code","type":"openai-compatible","gatewaySlug":"custom-command-code","gatewayPath":"v1","baseUrl":"https://api.commandcode.ai/provider/v1","enabled":true},{"id":"kilo","type":"openai-compatible","gatewaySlug":"custom-kilo","gatewayPath":"v1","baseUrl":"https://ai-gateway.kilo.ai/api/v1","enabled":false},{"id":"nous","type":"openai-compatible","gatewaySlug":"custom-nous","gatewayPath":"v1","baseUrl":"https://inference-api.nousresearch.com/v1","enabled":false},{"id":"opencode-go","type":"openai-compatible","gatewaySlug":"custom-opencode-go","gatewayPath":"","baseUrl":"https://opencode.ai/inference/go","modelsUrl":"https://opencode.ai/inference/go/v1/models","metadataUrl":"https://models.dev/api.json","enabled":false}]';

ALTER TABLE chat_turn ADD COLUMN token_limit INTEGER CHECK (token_limit IS NULL OR token_limit >= 0);
ALTER TABLE source_revision ADD COLUMN distill_token_limit INTEGER CHECK (distill_token_limit IS NULL OR distill_token_limit >= 0);
ALTER TABLE settings ADD COLUMN native_usage_mode TEXT NOT NULL DEFAULT 'included'
  CHECK (native_usage_mode IN ('included', 'standard'));
